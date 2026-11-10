import { expect, test } from 'vitest';

import { createEngine, output, sleep, withTool } from '../helpers';

test('forwards arguments', async () => {
  const tool = await withTool();
  expect((await output(tool.run('/bin/main', ['args', 'a', 'b c']))).stdout).toBe('a\nb c\n');
});

test('invalid binaries and directories exit with 126', async () => {
  const engine = await createEngine({ 'text.wasm': 'not wasm', dir: { files: {} } });
  expect(await output(engine.run('/text.wasm'))).toMatchObject({
    exitCode: 126,
    stderr: '/text.wasm: cannot execute\n'
  });
  expect(await output(engine.run('/dir'))).toMatchObject({
    exitCode: 126,
    stderr: '/dir: cannot execute\n'
  });
  expect((await engine.run(import.meta.url)).exitCode).toBe(126); // this (JavaScript) file
});

test('unknown commands exit with 127', async () => {
  const engine = await createEngine();
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

test('processes run concurrently', async () => {
  const tool = await withTool();
  const looping = tool.run('/bin/main', ['loop']);
  expect(await tool.run('/bin/main', ['exit', '7'])).toEqual({ exitCode: 7, killed: false });
  looping.kill();
});

test('forwards environment variables', async () => {
  const tool = await withTool();
  const proc = tool.run('/bin/main', ['env', 'NAME'], { env: { NAME: 'value' } });
  expect((await output(proc)).stdout).toBe('value\n');
});

test('the filesystem stays usable while processes run', async () => {
  const tool = await withTool();
  const busy = tool.run('/bin/main', ['spam', '/spam.txt']);
  await tool.fs.writeFile('/busy.txt', 'ok');
  expect(await tool.fs.readFile('/busy.txt', 'utf8')).toBe('ok');
  busy.kill();
});

test('guest errors exit with 134', async () => {
  const tool = await withTool();
  const result = await output(tool.run('/bin/main', ['trap']));
  expect(result.exitCode).toBe(134);
  expect(result.stderr).toMatch(/^\/bin\/main: /);
});

test('files written by processes are visible to the main thread', async () => {
  const tool = await withTool();
  await tool.run('/bin/main', ['write', '/written.txt', 'from guest']);
  expect(await tool.fs.readFile('/written.txt', 'utf8')).toBe('from guest');
});

test('files written by the main thread are visible to processes', async () => {
  const tool = await withTool();
  await tool.fs.writeFile('/hello.txt', 'from host');
  expect((await output(tool.run('/bin/main', ['read', '/hello.txt']))).stdout).toBe('from host');
});

test('kill after exit has no effect', async () => {
  const tool = await withTool();
  const proc = tool.run('/bin/main', ['exit', '2']);
  await proc;
  proc.kill();
  expect(await proc).toEqual({ exitCode: 2, killed: false });
});

test('killing processes mid-I/O never deadlocks the filesystem', async () => {
  const tool = await withTool();
  for (let i = 0; i < 20; i++) {
    const procs = Array.from({ length: 4 }, (_, j) =>
      tool.run('/bin/main', ['spam', `/spam${j}.txt`])
    );
    await sleep(20 + i * 5);
    procs.forEach((proc) => proc.kill());
    await tool.fs.writeFile('/after.txt', `${i}`);
  }
  expect(await tool.fs.readFile('/after.txt', 'utf8')).toBe('19');
  expect(await tool.run('/bin/main', ['exit', '9'])).toEqual({ exitCode: 9, killed: false });
});

test('killed workers are replaced', async () => {
  const tool = await withTool();
  const proc = tool.run('/bin/main', ['loop']);
  await sleep(200);
  proc.kill();
  await proc;
  expect(await tool.run('/bin/main', ['exit', '1'])).toEqual({ exitCode: 1, killed: false });
});

test('kill resolves immediately with 137', async () => {
  const tool = await withTool();
  const proc = tool.run('/bin/main', ['loop']);
  await sleep(200);
  proc.kill();
  expect(await proc).toEqual({ exitCode: 137, killed: true });
});

test('network errors exit with 127', async () => {
  const engine = await createEngine();
  const missing = `${location.origin}/missing.wasm`;
  const result = await output(engine.run(missing));
  expect(result).toMatchObject({ exitCode: 127, stderr: `${missing}: network error (404)\n` });
});

test('the debugger is undefined without debug: true', async () => {
  const tool = await withTool();
  expect(tool.run('/bin/main', ['exit', '0']).debugger).toBeUndefined();
});

test('many processes run in parallel', async () => {
  const tool = await withTool();
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) => tool.run('/bin/main', ['exit', `${i}`]))
  );
  expect(results.map((r) => r.exitCode)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
});

test('runs an executable from bytes', async () => {
  const tool = await withTool();
  const bytes = await tool.fs.readFile('/bin/main');
  expect(await tool.run(bytes, ['exit', '5'])).toEqual({ exitCode: 5, killed: false });
});

test('runs an executable from an absolute path', async () => {
  const tool = await withTool();
  expect(await tool.run('/bin/main', ['exit', '3'])).toEqual({ exitCode: 3, killed: false });
});

test('runs an executable from a relative path, resolved against cwd', async () => {
  const tool = await withTool();
  expect(await tool.run('./main', ['exit', '4'], { cwd: '/bin' })).toEqual({
    exitCode: 4,
    killed: false
  });
});

test('runs an executable from a URL', async () => {
  const engine = await createEngine();
  const python = 'https://runno.dev/langs/python-3.11.3.wasm';
  const result = await output(engine.run(python, ['-c', 'print(6 * 7)'], { sysroot: 'python' }));
  expect(result).toMatchObject({ exitCode: 0, stdout: '42\n' });
});

test('processes see each other’s files', async () => {
  const tool = await withTool();
  await tool.run('/bin/main', ['write', '/shared.txt', 'shared']);
  expect((await output(tool.run('/bin/main', ['read', '/shared.txt']))).stdout).toBe('shared');
});

test('captures stderr', async () => {
  const tool = await withTool();
  expect(await output(tool.run('/bin/main', ['stderr']))).toMatchObject({
    stdout: '',
    stderr: 'oops\n'
  });
});

test('stdin larger than its buffer', async () => {
  const tool = await withTool();
  const proc = tool.run('/bin/main', ['cat']);
  const result = output(proc);
  const big = 'x'.repeat(100_000);
  await proc.stdin.write(big);
  proc.stdin.close();
  expect((await result).stdout).toBe(big);
});

test('stdin is forwarded until closed', async () => {
  const tool = await withTool();
  const proc = tool.run('/bin/main', ['cat']);
  const result = output(proc);
  expect(proc.stdin.closed).toBe(false);
  await proc.stdin.write('CS198!');
  await proc.stdin.write(new TextEncoder().encode(' bytes'));
  proc.stdin.close();
  expect(proc.stdin.closed).toBe(true);
  expect((await result).stdout).toBe('CS198! bytes');
});

test('sysroot network errors exit with 127', async () => {
  const tool = await withTool();
  const result = await output(
    tool.run('/bin/main', { sysroot: `${location.origin}/missing.tar.gz` })
  );
  expect(result).toMatchObject({ exitCode: 127, stderr: '/bin/main: network error (404)\n' });
});
