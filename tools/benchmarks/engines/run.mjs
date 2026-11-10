// Benchmarks the old engine (main) against the rewritten engine in headless Chromium.
//
//   node run.mjs [--old ../path/to/main/dist] [--contexts 6] [--reps 3] [--langs cpp,rust,python]
//
// Toolchain assets are served from a local mirror (`mirror/<host>/<path>`) so that network
// variance doesn't dominate; Chromium resolves the toolchain hosts to a local HTTPS server.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';

import { files, programs } from './programs.mjs';

const here = import.meta.dirname;
const { values: args } = parseArgs({
  options: {
    old: { type: 'string', default: path.resolve(here, '../../../../engine-main/dist') },
    new: { type: 'string', default: path.resolve(here, '../../../dist') },
    mirror: { type: 'string', default: path.resolve(here, 'mirror') },
    out: { type: 'string', default: path.resolve(here, 'results/results.jsonl') },
    contexts: { type: 'string', default: '6' },
    reps: { type: 'string', default: '3' },
    engines: { type: 'string', default: 'old,new' },
    langs: { type: 'string', default: 'cpp,rust,python' },
    programs: { type: 'string', default: 'hello,fib,containers' }
  }
});

const HOSTS = ['fabioibanez.github.io', 'debugger-sh.github.io', 'runno.dev'];
const TYPES = { '.js': 'text/javascript', '.html': 'text/html', '.wasm': 'application/wasm' };

// A throwaway self-signed certificate (Chromium is told to ignore certificate errors)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-'));
execFileSync('openssl', [
  'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
  '-keyout', path.join(tmp, 'key.pem'), '-out', path.join(tmp, 'cert.pem')
], { stdio: 'ignore' });

const roots = { old: args.old, new: args.new, page: path.join(here, 'page') };
const server = https.createServer(
  { key: fs.readFileSync(path.join(tmp, 'key.pem')), cert: fs.readFileSync(path.join(tmp, 'cert.pem')) },
  (req, res) => {
    const host = req.headers.host.split(':')[0];
    const url = new URL(req.url, 'https://x');
    let file;
    if (HOSTS.includes(host)) {
      // Mirror GitHub Pages' headers: CORS, and a 10 minute cache lifetime
      file = path.join(args.mirror, host, url.pathname);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'max-age=600');
    } else {
      const [, root, ...rest] = url.pathname.split('/');
      file = roots[root] ? path.join(roots[root], ...rest) : path.join(roots.page, 'index.html');
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      res.setHeader('Cache-Control', 'no-store');
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
    res.setHeader('Content-Type', TYPES[path.extname(file)] ?? 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  }
);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const browser = await chromium.launch({
  args: [`--host-resolver-rules=${HOSTS.map((h) => `MAP ${h} 127.0.0.1:${port}`).join(',')}`]
});

fs.mkdirSync(path.dirname(args.out), { recursive: true });
const out = fs.createWriteStream(args.out, { flags: 'a' });
const record = (row) => {
  out.write(JSON.stringify(row) + '\n');
  const status = row.ok ? '' : `  FAILED: ${row.error}`;
  console.log(`${row.engine} ${row.lang}/${row.program} ${row.group}: ${row.ms.toFixed(0)}ms${status}`);
};

// One fresh browser context (empty HTTP cache, new JS realm) per cold start
async function session(engine, lang, name, context) {
  const program = programs[lang][name];
  const browserContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await browserContext.newPage();
  page.on('pageerror', (err) => console.error(`[page] ${err.message}`));
  await page.goto(`https://localhost:${port}/page/index.html`);
  await page.waitForFunction(() => window.ready);

  const measure = async (group, tag, call) => {
    let row;
    try {
      const result = await call();
      const ok = result.exitCode === 0 && result.stdout === program.expected(tag);
      row = { ...result, ok, error: ok ? undefined : `exit ${result.exitCode}: ${result.stdout}` };
    } catch (err) {
      row = { ms: NaN, ok: false, error: String(err) };
    }
    record({ engine, lang, program: name, group, context, ms: row.ms, ok: row.ok, error: row.error });
  };

  let tag = 0;
  const source = () => program.source(`v${tag}`);
  await measure('cold', `v${tag}`, () =>
    page.evaluate(([e, l, f, s]) => window.bench.start(e, l, f, s), [engine, lang, files[lang], source()])
  );
  for (let rep = 0; rep < Number(args.reps); rep++) {
    await measure('recompile', `v${tag}`, () => page.evaluate((s) => window.bench.rerun(s), source()));
    tag++;
    await measure('change', `v${tag}`, () => page.evaluate((s) => window.bench.rerun(s), source()));
  }
  await browserContext.close();
}

const engines = args.engines.split(',');
for (const lang of args.langs.split(','))
  for (const name of args.programs.split(','))
    for (let context = 0; context < Number(args.contexts); context++)
      // Alternate which engine goes first, so that drift affects both equally
      for (const engine of context % 2 ? engines.toReversed() : engines)
        await session(engine, lang, name, context);

await browser.close();
server.close();
out.end();
