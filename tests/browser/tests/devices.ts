import { Pipe } from 'debugger-sh';
import { expect, test } from 'vitest';

import { eng, HELLO, withTool } from '../helpers';

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** A shared buffer holding `text`. */
function buffer(text: string): SharedArrayBuffer {
  const bytes = new TextEncoder().encode(text);
  const buffer = new SharedArrayBuffer(bytes.length);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

test('processes read from pipes', async () => {
  const tool = await withTool();
  const pipe = new Pipe();
  const proc = tool.run('/bin/main', ['read', '/dev/test'], { devices: { '/dev/test': pipe } });
  const result = expect(proc).outputs({ stdout: 'hello world!' });
  await pipe.write('hello world!');
  pipe.close();
  await result;
});

test('processes write to pipes', async () => {
  const tool = await withTool();
  const pipe = new Pipe();
  await tool.run('/bin/main', ['write', '/dev/test', 'from guest'], {
    devices: { '/dev/test': pipe }
  });
  expect(decode(await pipe.read())).toBe('from guest');
});

test('pipes are not reset between processes', async () => {
  const tool = await withTool();
  const pipe = new Pipe({ close: false });
  await tool.run('/bin/main', ['write', '/dev/test', 'kept'], { devices: { '/dev/test': pipe } });
  pipe.close();
  await expect(
    tool.run('/bin/main', ['read', '/dev/test'], { devices: { '/dev/test': pipe } })
  ).outputs({ stdout: 'kept' });
});

test('processes read and write shared buffers in place', async () => {
  const tool = await withTool();
  const devices = { '/dev/mem': buffer('abcde') };
  await expect(tool.run('/bin/main', ['read', '/dev/mem'], { devices })).outputs({
    stdout: 'abcde'
  });
  await tool.run('/bin/main', ['write', '/dev/mem', 'xy'], { devices });
  expect(decode(new Uint8Array(devices['/dev/mem']).slice())).toBe('xycde');
});

test('the size of a shared buffer is its length', async () => {
  const tool = await withTool();
  const devices = { '/dev/mem': new SharedArrayBuffer(42) };
  await expect(tool.run('/bin/main', ['size', '/dev/mem'], { devices })).outputs({
    stdout: '42\n'
  });
});

test('devices shadow files, without changing them', async () => {
  const tool = await withTool();
  await tool.fs.writeFile('/file.txt', 'file');
  const devices = { '/file.txt': buffer('device') };
  await expect(tool.run('/bin/main', ['read', '/file.txt'], { devices })).outputs({
    stdout: 'device'
  });
  expect(await tool.fs.readFile('/file.txt', 'utf8')).toBe('file');
});

test('devices may be placed in directories which do not exist', async () => {
  const tool = await withTool();
  const devices = { '/a/b/c': buffer('deep') };
  await expect(tool.run('/bin/main', ['read', '/a/b/c'], { devices })).outputs({
    stdout: 'deep'
  });
  expect(await tool.fs.readDir('/')).not.toContain('a');
});

test('relative device paths are resolved against the root', async () => {
  const tool = await withTool();
  const devices = { test_dev: buffer('relative') };
  await expect(tool.run('/bin/main', ['read', '/test_dev'], { devices })).outputs({
    stdout: 'relative'
  });
});

test('devices are only visible to their process', async () => {
  const tool = await withTool();
  const devices = { '/dev/mem': buffer('mine') };
  const mine = expect(tool.run('/bin/main', ['size', '/dev/mem'], { devices })).outputs({
    stdout: '4\n'
  });
  await expect(tool.run('/bin/main', ['size', '/dev/mem'])).outputs({ stdout: '-1\n' });
  await mine;
});

test('toolchains only pass devices to the program', async () => {
  // If the compiler saw the device, it would compile it instead of `main.cpp`.
  const engine = await eng({ 'main.cpp': HELLO });
  const devices = { '/main.cpp': buffer('not C++') };
  await expect(engine.run('cpp', { devices })).outputs({ exitCode: 0, stdout: 'hello\n' });
});

test('python programs read devices', async () => {
  const engine = await eng({ 'main.py': 'print(open("/dev/in").read()[::-1])' });
  const devices = { '/dev/in': buffer('python') };
  await expect(engine.run('python', { devices })).outputs({ stdout: 'nohtyp\n' });
});
