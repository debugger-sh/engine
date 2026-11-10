/**
 * Runs `tests.js` inside headless Chromium, served (cross-origin isolated, as shared
 * memory requires) from the repository root. Run `npm run build` first.
 */
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = path.resolve(import.meta.dir, '../..');
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const file = Bun.file(path.join(ROOT, new URL(req.url).pathname));
    if (!(await file.exists())) return new Response('Not found', { status: 404 });
    return new Response(file, {
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp'
      }
    });
  }
});

const proxy = process.env.HTTPS_PROXY
  ? { server: process.env.HTTPS_PROXY, bypass: 'localhost' }
  : undefined;
const browser = await chromium.launch({ proxy });
const page = await browser.newPage();
page.on('console', (msg) => console.log(msg.text()));
page.on('pageerror', (err) => console.error(err));

const filter = process.argv[2] ?? '';
await page.goto(
  `http://localhost:${server.port}/tests/browser/index.html?filter=${encodeURIComponent(filter)}`
);
const failed = await page
  .waitForFunction(() => (window as unknown as { failed?: string[] }).failed, null, { timeout: 0 })
  .then((h) => h.jsonValue());

await browser.close();
server.stop();
process.exit(failed.length ? 1 : 0);
