// Times every program in `programs/<toolchain>/<program>/` with the engine's toolchains run
// natively (`setup.sh` installs one, then `toolchain.sh` runs each trial), and with the engine
// in Chromium on a throttled network: both the first run (a fresh browser profile, so toolchains
// are downloaded) and a subsequent run (a new page in the same profile, so toolchains come from
// the browser's HTTP cache).
//
// Usage: npm run tools:benchmarks -- [toolchain[/program] ...] [--runs=N]
import { serve } from 'bun';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = path.resolve(import.meta.dir, '../..');
const DIST = path.join(ROOT, 'dist');
const PROGRAMS = path.join(import.meta.dir, 'programs');
const OUTPUT = path.join(import.meta.dir, 'output');
const TOOLCHAINS = path.join(import.meta.dir, '.toolchains');

/** The global average mobile network speed (Speedtest Global Index), in Mbps. */
const NETWORK = { downloadMbps: 100, uploadMbps: 15 };

type Series = 'local' | 'first' | 'subsequent';
type Datapoint = { toolchain: string; program: string; series: Series; trial: number; ms: number };

const args = process.argv.slice(2);
const runs = Number(args.find((arg) => arg.startsWith('--runs='))?.slice(7) ?? 10);
const filters = args.filter((arg) => !arg.startsWith('--'));

if ((await readFile(path.join(DIST, 'debugger-sh.js'), 'utf8')).includes('http://localhost:')) {
  console.error('dist/ is a development build: run `npm run build` first.');
  process.exit(1);
}

// Shared memory requires cross-origin isolation.
const server = serve({
  port: 0,
  async fetch(req) {
    const headers = {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp'
    };
    const { pathname } = new URL(req.url);
    if (pathname === '/')
      return new Response('<!doctype html>', {
        headers: { ...headers, 'Content-Type': 'text/html' }
      });
    const file = Bun.file(path.join(DIST, pathname));
    return (await file.exists())
      ? new Response(file, { headers })
      : new Response(null, { status: 404 });
  }
});

/** Reads a directory into an engine `FileTree`. */
async function tree(dir: string): Promise<Record<string, unknown>> {
  const entries = await readdir(dir, { withFileTypes: true });
  return Object.fromEntries(
    await Promise.all(
      entries.map(async (entry) => {
        const at = path.join(dir, entry.name);
        return [
          entry.name,
          entry.isDirectory() ? { files: await tree(at) } : await readFile(at, 'utf8')
        ];
      })
    )
  );
}

/** Runs `programs/<toolchain>/<script>` with the toolchain's directory and `args`. */
const script = (toolchain: string, name: string, args: string[], options = {}) =>
  spawnSync(path.join(PROGRAMS, toolchain, name), [path.join(TOOLCHAINS, toolchain), ...args], {
    encoding: 'utf8',
    ...options
  });

/** Times building (into a fresh directory) and running a program with the native toolchain. */
async function timeLocal(toolchain: string, dir: string) {
  const out = await mkdtemp(path.join(os.tmpdir(), 'bench-'));
  const start = performance.now();
  const result = script(toolchain, 'toolchain.sh', [out], {
    cwd: dir
  });
  const ms = performance.now() - start;
  await rm(out, { recursive: true, force: true });
  if (result.status !== 0) throw new Error(`${toolchain}: ${result.error ?? result.stderr}`);
  return { ms, stdout: result.stdout };
}

/** Runs in the page: times creating an engine and running the program to completion. */
async function inPage({
  library,
  toolchain,
  files
}: {
  library: string;
  toolchain: string;
  files: unknown;
}) {
  const { Engine } = await import(library);
  const start = performance.now();
  const engine = await Engine.create();
  await engine.fs.mount(files);
  const proc = engine.run(toolchain);
  const decoder = new TextDecoder();
  let [stdout, stderr] = ['', ''];
  proc.stdout.on('data', (chunk: Uint8Array) => (stdout += decoder.decode(chunk)));
  proc.stderr.on('data', (chunk: Uint8Array) => (stderr += decoder.decode(chunk)));
  const { exitCode } = await proc;
  const ms = performance.now() - start;
  engine.dispose();
  return { ms, exitCode, stdout, stderr, agent: navigator.userAgent };
}

const stats = (xs: number[]) => {
  const sorted = [...xs].sort((a, b) => a - b);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, x) => a + (x - mean) ** 2, 0) / Math.max(xs.length - 1, 1);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return {
    n: xs.length,
    mean,
    median,
    stdev: Math.sqrt(variance),
    min: sorted[0],
    max: sorted.at(-1)
  };
};

const datapoints: Datapoint[] = [];
const versions: Record<string, string> = {};
let agent = '';

for (const toolchain of await readdir(PROGRAMS)) {
  for (const entry of await readdir(path.join(PROGRAMS, toolchain), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const program = entry.name;
    const name = `${toolchain}/${program}`;
    if (filters.length && !filters.some((filter) => name.startsWith(filter))) continue;
    const dir = path.join(PROGRAMS, toolchain, program);
    const record = (series: Series, trial: number, ms: number) => {
      datapoints.push({ toolchain, program, series, trial, ms });
      console.log(`${name}  ${series.padEnd(10)}  #${trial + 1}  ${ms.toFixed(0).padStart(6)} ms`);
    };

    if (!versions[toolchain]) {
      if (script(toolchain, 'setup.sh', [], { stdio: 'inherit' }).status !== 0)
        throw new Error(`${toolchain}: setup failed`);
      versions[toolchain] = script(toolchain, 'toolchain.sh', ['--version']).stdout.split('\n')[0];
    }
    // An untimed warm-up run, so the local toolchain is in the OS's file cache like the engine's
    // is in the browser's, also gives the output that the engine must match.
    const { stdout: expected } = await timeLocal(toolchain, dir);
    for (let trial = 0; trial < runs; trial++)
      record('local', trial, (await timeLocal(toolchain, dir)).ms);

    for (let trial = 0; trial < runs; trial++) {
      const profile = await mkdtemp(path.join(os.tmpdir(), 'bench-profile-'));
      const context = await chromium.launchPersistentContext(profile, { channel: 'chromium' });
      try {
        for (const series of ['first', 'subsequent'] as const) {
          const page = await context.newPage();
          // Only the engine is timed (not loading the page), so only it is throttled.
          await page.goto(server.url.href);
          const cdp = await context.newCDPSession(page);
          await cdp.send('Network.emulateNetworkConditions', {
            offline: false,
            latency: 0,
            downloadThroughput: (NETWORK.downloadMbps * 1e6) / 8,
            uploadThroughput: (NETWORK.uploadMbps * 1e6) / 8
          });
          const result = await page.evaluate(inPage, {
            library: '/debugger-sh.js',
            toolchain,
            files: await tree(dir)
          });
          await page.close();
          if (result.exitCode !== 0 || result.stdout !== expected)
            throw new Error(
              `${name} failed in the engine (exit ${result.exitCode}):\n${result.stdout}${result.stderr}`
            );
          agent = result.agent;
          record(series, trial, result.ms);
        }
      } finally {
        await context.close();
        await rm(profile, { recursive: true, force: true });
      }
    }
  }
}

const meta = {
  date: new Date().toISOString(),
  runs,
  machine: {
    cpu: os.cpus()[0].model,
    platform: `${os.platform()} ${os.release()}`,
    memoryGB: os.totalmem() / 2 ** 30
  },
  browser: agent,
  network: NETWORK,
  versions
};
const summary: Record<
  string,
  Record<string, Partial<Record<Series, ReturnType<typeof stats>>>>
> = {};
for (const { toolchain, program, series } of datapoints) {
  const programs = (summary[toolchain] ??= {});
  (programs[program] ??= {})[series] ??= stats(
    datapoints
      .filter((d) => d.toolchain === toolchain && d.program === program && d.series === series)
      .map((d) => d.ms)
  );
}

await mkdir(OUTPUT, { recursive: true });
await writeFile(path.join(OUTPUT, 'raw.json'), JSON.stringify({ meta, datapoints }, null, 2));
await writeFile(path.join(OUTPUT, 'summary.json'), JSON.stringify({ meta, summary }, null, 2));
console.log(`\nWrote ${path.relative(process.cwd(), OUTPUT)}/{summary,raw}.json`);
await server.stop();
