// Times every program in `programs/<toolchain>/<program>/` in the engine, cold (a fresh browser
// profile, so toolchains are downloaded) and warm (a new page in the same profile, so toolchains
// come from the HTTP cache), and with `--local`, natively (with `programs/<toolchain>/local.ts`).
//
// Usage: npm run tools:benchmarks -- [toolchain[/program] ...] [--runs=N] [--local]
import { serve } from 'bun';
import chalk from 'chalk';
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
const SERIES = ['local', 'cold', 'warm'] as const;

type Series = (typeof SERIES)[number];
type Datapoint = { toolchain: string; program: string; series: Series; trial: number; ms: number };
type Local = {
  setup(dir: string): Promise<string>;
  run(dir: string, program: string, out: string): Promise<string>;
};

const args = process.argv.slice(2);
const runs = Number(args.find((arg) => arg.startsWith('--runs='))?.slice(7) ?? 10);
const local = args.includes('--local');
const filters = args.filter((arg) => !arg.startsWith('--'));

const info = (msg: string) => console.log(`${chalk.cyan('info')} ${msg}`);
const die = (msg: string): never => {
  console.error(`\n${chalk.red('error')} ${msg}`);
  process.exit(1);
};

if ((await readFile(path.join(DIST, 'debugger-sh.js'), 'utf8')).includes('http://localhost:'))
  die('dist/ is a development build: run `npm run build` first.');

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

/** Times building (into a fresh directory) and running a program with a local toolchain. */
async function timeLocal(toolchain: Local, dir: string, program: string) {
  const out = await mkdtemp(path.join(os.tmpdir(), 'bench-'));
  const start = performance.now();
  const stdout = await toolchain.run(dir, program, out);
  const ms = performance.now() - start;
  await rm(out, { recursive: true, force: true });
  return { ms, stdout };
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
const times = (toolchain: string, program: string, series: Series) =>
  datapoints
    .filter((d) => d.toolchain === toolchain && d.program === program && d.series === series)
    .map((d) => d.ms);
const versions: Record<string, string> = {};
let agent = '';

const programs: [string, string][] = [];
for (const toolchain of await readdir(PROGRAMS))
  for (const entry of await readdir(path.join(PROGRAMS, toolchain), { withFileTypes: true }))
    if (
      entry.isDirectory() &&
      (!filters.length || filters.some((f) => `${toolchain}/${entry.name}`.startsWith(f)))
    )
      programs.push([toolchain, entry.name]);
info(
  `${programs.length} program(s), ${runs} trial(s) each${local ? ', with local toolchains' : ''}`
);

for (const [toolchain, program] of programs) {
  const name = `${toolchain}/${program}`;
  const dir = path.join(PROGRAMS, toolchain, program);
  const toolchainDir = path.join(TOOLCHAINS, toolchain);
  const native: Local | undefined = local
    ? await import(path.join(PROGRAMS, toolchain, 'local.ts'))
    : undefined;
  if (native && !versions[toolchain]) {
    info(`setting up local ${toolchain} toolchain...`);
    versions[toolchain] = await native.setup(toolchainDir);
  }
  info(`${chalk.bold(name)}${native ? chalk.dim(` (local: ${versions[toolchain]})`) : ''}`);

  // An untimed warm-up run, so the local toolchain is in the OS's file cache like the engine's
  // is in the browser's, also gives the output that the engine must match.
  const expected = native && (await timeLocal(native, toolchainDir, dir)).stdout;
  const record = (series: Series, trial: number, ms: number) => {
    datapoints.push({ toolchain, program, series, trial, ms });
    const averages = SERIES.filter((s) => times(toolchain, program, s).length).map((s) => {
      const { mean, stdev } = stats(times(toolchain, program, s));
      return `${chalk.bold(s)} ${mean.toFixed(0)} ${chalk.dim(`± ${stdev.toFixed(0)}`)} ms`;
    });
    process.stdout.write(
      `\r\x1b[2K ${chalk.blue('└─')} ${chalk.dim(`[${trial + 1}/${runs}]`)} ${averages.join('   ')}`
    );
  };

  for (let trial = 0; trial < runs; trial++) {
    if (native) record('local', trial, (await timeLocal(native, toolchainDir, dir)).ms);

    const profile = await mkdtemp(path.join(os.tmpdir(), 'bench-profile-'));
    const context = await chromium.launchPersistentContext(profile, { channel: 'chromium' });
    for (const series of ['cold', 'warm'] as const) {
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
      if (result.exitCode !== 0 || (expected !== undefined && result.stdout !== expected))
        die(
          `${name} failed in the engine (exit ${result.exitCode}):\n${result.stdout}${result.stderr}`
        );
      agent = result.agent;
      record(series, trial, result.ms);
    }
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
  console.log();
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
for (const { toolchain, program, series } of datapoints)
  ((summary[toolchain] ??= {})[program] ??= {})[series] ??= stats(
    times(toolchain, program, series)
  );

await mkdir(OUTPUT, { recursive: true });
await writeFile(path.join(OUTPUT, 'raw.json'), JSON.stringify({ meta, datapoints }, null, 2));
await writeFile(path.join(OUTPUT, 'summary.json'), JSON.stringify({ meta, summary }, null, 2));
console.log(`${chalk.green('ok')} wrote output/summary.json and output/raw.json`);
await server.stop();
