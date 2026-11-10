import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildFixtures } from './build-fixtures.mjs';

// Test a built package through its public API. Use --exceptions when the package
// also contains the optional C++ exception-handling change.
assert.ok(process.env.PLAYWRIGHT_MODULE, 'Set PLAYWRIGHT_MODULE to an installed Playwright module');
const { chromium } = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href);
const modulePath =
  process.argv.slice(2).find((arg) => !arg.startsWith('--')) ??
  fileURLToPath(new URL('../../dist/debugger-sh.js', import.meta.url));
const engineModule = await readFile(modulePath);
const fixtures = await buildFixtures(process.argv.includes('--exceptions'));
const html = `<meta charset="utf-8"><script type="module">
import { Engine } from '/engine.js';
window.probe = {
  async create(lang = 'c') {
    this.engine = await Engine.create(lang);
    const decoder = new TextDecoder();
    this.engine.stdout.on('data', bytes => this.state.stdout += decoder.decode(bytes));
    this.engine.stderr.on('data', bytes => this.state.stderr += decoder.decode(bytes));
    this.engine.debugger.on('event', event => this.state.events.push(event));
    this.pch = new Uint8Array(await (await fetch('/fixture.pch')).arrayBuffer());
    this.archive = new Uint8Array(await (await fetch('/libfixture.a')).arrayBuffer());
  },
  begin({ header, source, plain = false, binary = false, debug = false, invalid }) {
    this.state = { stdout: '', stderr: '', done: false, events: [] };
    this.seq = 1;
    this.engine.debugger.enabled = debug;
    const filename = this.engine.lang === 'python' ? 'main.py' : 'main.cpp';
    this.engine.fs = plain || binary ? { [filename]: source } : {
      'main.cpp': source,
      'fixture.h': header,
      'excluded.cpp': '#error source selection must exclude this file'
    };
    this.engine.binaryFiles = binary ? { '/images/雪.bin': new Uint8Array([0, 255, 128, 192, 10, 13, 0, 42]) } : plain ? {} : {
      '/fixture.pch': this.pch.slice(),
      '/libfixture.a': this.archive.slice()
    };
    this.engine.cppArtifacts = plain || binary ? undefined : {
      sources: ['/main.cpp'], archives: ['/libfixture.a'], precompiledHeader: '/fixture.pch'
    };
    if (invalid === 'source') this.engine.cppArtifacts.sources = ['/missing.cpp'];
    if (invalid === 'empty sources') this.engine.cppArtifacts.sources = [];
    if (invalid === 'missing archive') this.engine.cppArtifacts.archives = ['/missing.a'];
    if (invalid === 'missing PCH') this.engine.cppArtifacts.precompiledHeader = '/missing.pch';
    if (invalid === 'collision') this.engine.binaryFiles['/' + filename] = new Uint8Array([1]);
    if (invalid === 'relative path') this.engine.binaryFiles['images/relative'] = new Uint8Array([1]);
    if (invalid === 'path alias') this.engine.binaryFiles['/images//alias'] = new Uint8Array([1]);
    if (invalid === 'artifacts') this.engine.cppArtifacts = { archives: [] };
    if (invalid === 'binary path') this.engine.binaryFiles['/bad/../file'] = new Uint8Array([1]);
    if (invalid === 'corrupt archive') this.engine.binaryFiles['/libfixture.a'] = new Uint8Array([1, 2, 3]);
    this.engine.run().then(result => {
      this.state.result = result;
      this.state.done = true;
    }, error => {
      this.state.error = String(error);
      this.state.done = true;
    });
    if (debug) this.send('initialize');
  },
  send(command, args = {}) {
    return this.engine.debugger.send({ type: 'request', seq: this.seq++, command, arguments: args });
  }
};
</script>`;
const server = createServer((request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  const resources = {
    '/': ['text/html', html],
    '/engine.js': ['text/javascript', engineModule],
    '/fixture.pch': ['application/octet-stream', fixtures.pch],
    '/libfixture.a': ['application/octet-stream', fixtures.archive]
  };
  const resource = resources[request.url];
  if (!resource) return response.writeHead(404).end();
  response.setHeader('Content-Type', resource[0]);
  response.end(resource[1]);
});
let browser;
let page;
const pageErrors = [];
const results = [];
const source =
  'int main() {\n  int value = PCH_VALUE + archive_value();\n  printf("ARTIFACT RESULT: %d\\n", value);\n  return value == 42 ? 0 : 1;\n}\n';

async function begin(options = {}) {
  await page.evaluate((args) => window.probe.begin(args), {
    header: fixtures.header,
    source,
    ...options
  });
}
async function complete(label, success = true, stdout = 'ARTIFACT RESULT: 42\n') {
  await page.waitForFunction(() => window.probe.state.done, undefined, { timeout: 120_000 });
  const state = await page.evaluate(() => window.probe.state);
  if (success) {
    assert.equal(state.result?.type, 'completed', JSON.stringify(state));
    assert.equal(state.result.exitCode, 0, JSON.stringify(state));
    assert.equal(state.stdout, stdout, JSON.stringify(state));
  } else {
    assert.ok(
      state.result?.type === 'error' ||
        (state.result?.type === 'completed' && state.result.exitCode !== 0),
      JSON.stringify(state)
    );
  }
  results.push({ label, result: state.result, stdout: state.stdout, stderr: state.stderr });
  return state;
}

try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.probe !== undefined);
  assert.equal(await page.evaluate(() => crossOriginIsolated), true);
  await page.evaluate(() => window.probe.create());

  await begin();
  await complete('Run: PCH, archive, and selected source');

  await begin({ debug: true });
  await page.waitForFunction(
    () => {
      const probe = window.probe;
      if (!probe.state.events.some((event) => event.event === 'initialized')) return false;
      const response = probe.send('setBreakpoints', {
        source: { path: '/main.cpp' },
        breakpoints: [{ line: 3 }]
      });
      if (!response?.body?.breakpoints?.some((breakpoint) => breakpoint.verified)) return false;
      return probe.send('configurationDone')?.success === true;
    },
    undefined,
    { timeout: 120_000 }
  );
  await page.waitForFunction(
    () => window.probe.state.events.some((event) => event.event === 'stopped'),
    undefined,
    { timeout: 120_000 }
  );
  const debug = await page.evaluate(() => {
    const probe = window.probe;
    const stopped = probe.state.events.find((event) => event.event === 'stopped');
    const stack = probe.send('stackTrace', { threadId: stopped.body.threadId });
    const response = probe.send('next', { threadId: stopped.body.threadId });
    return { stopped, stack, response };
  });
  assert.equal(debug.stopped.body.reason, 'breakpoint');
  assert.equal(debug.stack.success, true, JSON.stringify(debug));
  assert.equal(debug.stack.body.stackFrames[0].name, 'main');
  assert.equal(debug.stack.body.stackFrames[0].line, 3);
  assert.equal(debug.response.success, true, JSON.stringify(debug));
  await page.waitForFunction(
    () => window.probe.state.events.filter((event) => event.event === 'stopped').length >= 2,
    undefined,
    { timeout: 120_000 }
  );
  const stepped = await page.evaluate(() => {
    const probe = window.probe;
    const stopped = probe.state.events.filter((event) => event.event === 'stopped')[1];
    const stack = probe.send('stackTrace', { threadId: stopped.body.threadId });
    const response = probe.send('continue', { threadId: stopped.body.threadId });
    return { stopped, stack, response };
  });
  assert.equal(stepped.stopped.body.reason, 'step');
  assert.equal(stepped.stack.success, true, JSON.stringify(stepped));
  assert.equal(stepped.stack.body.stackFrames[0].name, 'main');
  assert.equal(stepped.stack.body.stackFrames[0].line, 4);
  assert.equal(stepped.response.success, true, JSON.stringify(stepped));
  await complete('Debug: PCH, archive, source breakpoint, Step Over and continue');

  for (const [invalid, message] of [
    ['source', 'C/C++ sources must select existing source files'],
    ['empty sources', 'C/C++ sources must select existing source files'],
    ['missing archive', 'Missing binary build input: /missing.a'],
    ['missing PCH', 'Missing binary build input: /missing.pch'],
    ['binary path', 'Invalid binary input path: /bad/../file']
  ]) {
    await begin({ invalid });
    const state = await complete(`Reject ${invalid}`, false);
    assert.equal(state.result.type, 'error', JSON.stringify(state));
    assert.equal(state.result.error.type, 'EngineError');
    assert.ok(state.result.error.message.includes(message), JSON.stringify(state));
  }
  await begin({ invalid: 'corrupt archive' });
  const corrupt = await complete('Reject corrupt archive', false);
  assert.match(corrupt.stdout + corrupt.stderr, /libfixture\.a/);
  await begin({
    plain: true,
    source: '#include <cstdio>\nint main() { printf("ARTIFACT RESULT: %d\\n", 42); }\n'
  });
  await complete('Plain source remains compatible after artifact errors');
  const programs = {
    python: `import os
expected = bytes([0, 255, 128, 192, 10, 13, 0, 42])
data = open('/images/雪.bin', 'rb').read()
assert data == expected
assert '雪.bin' in os.listdir('/images')
assert not os.path.exists('/images/result.bin')
open('/images/result.bin', 'wb').write(data)
assert open('/images/result.bin', 'rb').read() == expected
print('BINARY RESULT: 42')
`,
    c: `#include <cstdio>
#include <cstring>
int main() {
  unsigned char expected[] = {0, 255, 128, 192, 10, 13, 0, 42}, data[8];
  FILE *input = fopen("/images/雪.bin", "rb");
  if (!input || fread(data, 1, 8, input) != 8 || memcmp(data, expected, 8)) return 1;
  fclose(input);
  if (fopen("/images/result.bin", "rb")) return 2;
  FILE *output = fopen("/images/result.bin", "wb");
  if (!output || fwrite(data, 1, 8, output) != 8) return 3;
  fclose(output);
  input = fopen("/images/result.bin", "rb");
  if (!input || fread(data, 1, 8, input) != 8 || memcmp(data, expected, 8)) return 4;
  fclose(input);
  printf("BINARY RESULT: 42\\n");
}
`
  };
  for (const lang of ['python', 'c']) {
    await page.evaluate((lang) => window.probe.create(lang), lang);
    for (const debug of [false, true]) {
      await begin({ binary: true, source: programs[lang], debug });
      if (debug) {
        await page.waitForFunction(() =>
          window.probe.state.events.some((event) => event.event === 'initialized')
        );
        await page.evaluate((lang) => {
          const probe = window.probe;
          const response = probe.send('setBreakpoints', {
            source: { path: lang === 'python' ? '/main.py' : '/main.cpp' },
            breakpoints: [{ line: lang === 'python' ? 3 : 5 }]
          });
          if (!response?.body?.breakpoints?.some((breakpoint) => breakpoint.verified))
            throw new Error('Unverified breakpoint');
          probe.send('configurationDone');
        }, lang);
        await page.waitForFunction(
          () => window.probe.state.events.some((event) => event.event === 'stopped'),
          undefined,
          { timeout: 120_000 }
        );
        await page.evaluate(() =>
          window.probe.send('continue', {
            threadId: window.probe.state.events.find((event) => event.event === 'stopped').body
              .threadId
          })
        );
      }
      await complete(
        `${lang} ${debug ? 'Debug' : 'Run'}: binary bytes, Unicode path, guest writes, isolated outputs`,
        true,
        'BINARY RESULT: 42\n'
      );
    }
    for (const invalid of [
      'collision',
      'relative path',
      'path alias',
      'binary path',
      ...(lang === 'python' ? ['artifacts'] : [])
    ]) {
      await begin({ binary: true, source: programs[lang], invalid });
      const state = await complete(`${lang}: reject ${invalid}`, false);
      assert.equal(state.result.type, 'error', JSON.stringify(state));
      assert.equal(state.result.error.type, 'EngineError');
      assert.match(state.result.error.message, /binary input|Binary build inputs/i);
    }
  }
  assert.deepEqual(pageErrors, []);
  console.log(
    JSON.stringify(
      { status: 'passed', exceptions: process.argv.includes('--exceptions'), results },
      null,
      2
    )
  );
} catch (error) {
  console.error(
    JSON.stringify(
      {
        status: 'failed',
        results,
        state: await page?.evaluate(() => window.probe?.state).catch(() => undefined),
        pageErrors
      },
      null,
      2
    )
  );
  throw error;
} finally {
  await browser?.close();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  await rm(fixtures.directory, { recursive: true, force: true });
}
