import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Engine } from 'debugger-sh';

import { output, withTool } from './helpers';

let engine: Engine;
let server: ReturnType<typeof Bun.serve>;
let tool: Uint8Array;

beforeAll(async () => {
  engine = await withTool();
  tool = await engine.fs.readFile('/bin/main');
  server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const path = new URL(req.url).pathname;
      if (path === '/tool.wasm') return new Response(tool);
      if (path === '/text.wasm') return new Response('not wasm');
      return new Response('missing', { status: 404 });
    }
  });
});
afterAll(() => {
  engine.dispose();
  server.stop();
});

const url = (path: string) => `http://localhost:${server.port}${path}`;

test('runs an executable from an absolute path', async () => {
  expect(await output(engine.run('/bin/main', ['exit', '3']))).toMatchObject({
    exitCode: 3,
    killed: false
  });
});

test('runs an executable from a relative path, resolved against cwd', async () => {
  expect(await engine.run('./main', ['exit', '4'], { cwd: '/bin' })).toEqual({
    exitCode: 4,
    killed: false
  });
});

test('runs an executable from bytes', async () => {
  expect(await engine.run(tool, ['exit', '5'])).toEqual({ exitCode: 5, killed: false });
});

test('runs an executable from a URL', async () => {
  expect(await engine.run(url('/tool.wasm'), ['exit', '6'])).toEqual({
    exitCode: 6,
    killed: false
  });
});

test('forwards arguments and environment variables', async () => {
  expect((await output(engine.run('/bin/main', ['args', 'a', 'b c']))).stdout).toBe('a\nb c\n');
  expect(
    (await output(engine.run('/bin/main', ['env', 'NAME'], { env: { NAME: 'value' } }))).stdout
  ).toBe('value\n');
});

test('captures stderr', async () => {
  expect(await output(engine.run('/bin/main', ['stderr']))).toMatchObject({
    stdout: '',
    stderr: 'oops\n'
  });
});

test('unknown commands exit with 127', async () => {
  expect(await output(engine.run('nope'))).toMatchObject({
    exitCode: 127,
    stderr: 'nope: command not found\n'
  });
  expect(await output(engine.run('/missing'))).toMatchObject({
    exitCode: 127,
    stderr: '/missing: command not found\n'
  });
  expect(await output(engine.run('constructor'))).toMatchObject({ exitCode: 127 });
});

test('network errors exit with 127', async () => {
  const missing = url('/missing.wasm');
  expect(await output(engine.run(missing))).toMatchObject({
    exitCode: 127,
    stderr: `${missing}: network error (404)\n`
  });
});

test('sysroot network errors exit with 127', async () => {
  const result = await output(engine.run('/bin/main', { sysroot: url('/missing.tar.gz') }));
  expect(result).toMatchObject({ exitCode: 127, stderr: '/bin/main: network error (404)\n' });
});

test('invalid binaries and directories exit with 126', async () => {
  await engine.fs.writeFile('/text.wasm', 'not wasm');
  expect(await output(engine.run('/text.wasm'))).toMatchObject({
    exitCode: 126,
    stderr: '/text.wasm: cannot execute\n'
  });
  expect(await output(engine.run(url('/text.wasm')))).toMatchObject({ exitCode: 126 });
  expect(await output(engine.run('/bin'))).toMatchObject({
    exitCode: 126,
    stderr: '/bin: cannot execute\n'
  });
});

test('guest errors exit with 134', async () => {
  const result = await output(engine.run('/bin/main', ['trap']));
  expect(result.exitCode).toBe(134);
  expect(result.stderr).toStartWith('/bin/main: ');
});

test('stdin is forwarded until closed', async () => {
  const proc = engine.run('/bin/main', ['cat']);
  const result = output(proc);
  expect(proc.stdin.closed).toBe(false);
  await proc.stdin.write('CS198!');
  await proc.stdin.write(new TextEncoder().encode(' bytes'));
  proc.stdin.close();
  expect(proc.stdin.closed).toBe(true);
  expect((await result).stdout).toBe('CS198! bytes');
});

test('stdin larger than its buffer', async () => {
  const proc = engine.run('/bin/main', ['cat']);
  const result = output(proc);
  const big = 'x'.repeat(100_000);
  await proc.stdin.write(big);
  proc.stdin.close();
  expect((await result).stdout).toBe(big);
});

// Note: Bun cannot terminate a worker busy running WebAssembly, so this one keeps a core busy.
test('kill resolves immediately with 137', async () => {
  const proc = engine.run('/bin/main', ['loop']);
  await Bun.sleep(200);
  proc.kill();
  expect(await proc).toEqual({ exitCode: 137, killed: true });
});

test('killed workers are replaced', async () => {
  const proc = engine.run('/bin/main', ['cat']);
  await Bun.sleep(200);
  proc.kill();
  await proc;
  expect(await engine.run('/bin/main', ['exit', '1'])).toEqual({ exitCode: 1, killed: false });
});

test('kill after exit has no effect', async () => {
  const proc = engine.run('/bin/main', ['exit', '2']);
  await proc;
  proc.kill();
  expect(await proc).toEqual({ exitCode: 2, killed: false });
});

test('processes run concurrently', async () => {
  const waiting = engine.run('/bin/main', ['cat']);
  expect(await engine.run('/bin/main', ['exit', '7'])).toEqual({ exitCode: 7, killed: false });
  waiting.kill();
});

test('many processes run in parallel', async () => {
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) => engine.run('/bin/main', ['exit', `${i}`]))
  );
  expect(results.map((r) => r.exitCode)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
});

test('files written by processes are visible to the main thread', async () => {
  await engine.run('/bin/main', ['write', '/written.txt', 'from guest']);
  expect(await engine.fs.readFile('/written.txt', 'utf8')).toBe('from guest');
});

test('files written by the main thread are visible to processes', async () => {
  await engine.fs.writeFile('/hello.txt', 'from host');
  expect((await output(engine.run('/bin/main', ['read', '/hello.txt']))).stdout).toBe('from host');
});

test('processes see each other’s files', async () => {
  await engine.run('/bin/main', ['write', '/shared.txt', 'shared']);
  expect((await output(engine.run('/bin/main', ['read', '/shared.txt']))).stdout).toBe('shared');
});

test('the filesystem stays usable while processes run', async () => {
  const busy = engine.run('/bin/main', ['spam', '/spam.txt']);
  await engine.fs.writeFile('/busy.txt', 'ok');
  expect(await engine.fs.readFile('/busy.txt', 'utf8')).toBe('ok');
  busy.kill();
});

test('killing processes mid-I/O never deadlocks the filesystem', async () => {
  for (let i = 0; i < 20; i++) {
    const procs = Array.from({ length: 4 }, (_, j) =>
      engine.run('/bin/main', ['spam', `/spam${j}.txt`])
    );
    await Bun.sleep(20 + i * 5);
    for (const proc of procs) proc.kill();
    await engine.fs.writeFile('/after.txt', `${i}`);
  }
  expect(await engine.fs.readFile('/after.txt', 'utf8')).toBe('19');
  expect(await engine.run('/bin/main', ['exit', '9'])).toEqual({ exitCode: 9, killed: false });
});

test('debugger is undefined without debug: true', () => {
  const proc = engine.run('/bin/main', ['exit', '0']);
  expect(proc.debugger).toBeUndefined();
});
