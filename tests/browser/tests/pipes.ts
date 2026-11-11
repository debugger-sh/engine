import { Pipe } from 'debugger-sh';
import { expect, test } from 'vitest';

import { sleep, withTool } from '../helpers';

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

test('reads what was written', async () => {
  const pipe = new Pipe();
  await pipe.write('hello world!');
  expect(decode(await pipe.read())).toBe('hello world!');
});

test('reads wait for writes', async () => {
  const pipe = new Pipe();
  const read = pipe.read();
  await pipe.write(new TextEncoder().encode('later'));
  expect(decode(await read)).toBe('later');
});

test('reads are empty once closed and drained', async () => {
  const pipe = new Pipe();
  await pipe.write('last');
  expect(pipe.closed).toBe(false);
  pipe.close();
  expect(pipe.closed).toBe(true);
  expect(decode(await pipe.read())).toBe('last');
  expect(await pipe.read()).toEqual(new Uint8Array());
});

test('writing to a closed pipe throws', async () => {
  const pipe = new Pipe();
  pipe.close();
  await expect(pipe.write('x')).rejects.toThrow();
});

test('closing a pipe fails blocked writes', async () => {
  const pipe = new Pipe({ capacity: 1 });
  const written = pipe.write('ab');
  pipe.close();
  await expect(written).rejects.toThrow();
});

test('writes larger than the capacity wait for reads', async () => {
  const pipe = new Pipe({ capacity: 16 });
  const big = 'x'.repeat(1000);
  const written = pipe.write(big).then(() => pipe.close());
  expect((await collect(pipe)).map(decode).join('')).toBe(big);
  await written;
});

test('a pipe buffers exactly its capacity', async () => {
  const pipe = new Pipe({ capacity: 4 });
  await pipe.write('full'); // resolves without any reads
  const written = pipe.write('!');
  expect(decode(await pipe.read())).toBe('full');
  await written;
  expect(decode(await pipe.read())).toBe('!');
});

test('a pipe with a capacity of 1 buffers 1 byte', async () => {
  const pipe = new Pipe({ capacity: 1 });
  const written = pipe.write('ab');
  expect(decode(await pipe.read())).toBe('a');
  expect(decode(await pipe.read())).toBe('b');
  await written;
});

test('lines() yields each line without its newline', async () => {
  const pipe = new Pipe();
  await pipe.write('a\nb\n\nc');
  pipe.close();
  expect(await collect(pipe.lines())).toEqual(['a', 'b', '', 'c']);
});

test('data and end fire when the pipe is read, and listening does not read', async () => {
  const pipe = new Pipe();
  const events: string[] = [];
  pipe.on('data', (chunk) => events.push(decode(chunk)));
  pipe.on('end', () => events.push('end'));
  await pipe.write('a');
  pipe.close();
  expect(events).toEqual([]);
  await pipe.read();
  await pipe.read();
  await pipe.read();
  expect(events).toEqual(['a', 'end']);
});

test('flowing pipes are consumed without reads', async () => {
  const pipe = new Pipe();
  let data = '';
  pipe.on('data', (chunk) => (data += decode(chunk)));
  const ended = new Promise<void>((resolve) => pipe.on('end', () => resolve()));
  pipe.flow();
  await pipe.write('flowing');
  pipe.close();
  await ended;
  expect(data).toBe('flowing');
});

test('reads of a flowing pipe resolve with the next chunk', async () => {
  const pipe = new Pipe();
  pipe.flow();
  const reads = [pipe.read(), pipe.read()];
  await pipe.write('next');
  expect((await Promise.all(reads)).map(decode)).toEqual(['next', 'next']);
  pipe.close();
  expect(await pipe.read()).toEqual(new Uint8Array());
});

// ╭──────────────────────────────────────────────────────────────────────────╮
// │ Standard I/O                                                             │
// ╰──────────────────────────────────────────────────────────────────────────╯

test('stdout and stderr can be pipes', async () => {
  const tool = await withTool();
  const [stdout, stderr] = [new Pipe(), new Pipe()];
  const proc = tool.run('/bin/main', ['args', 'a', 'b'], { stdout, stderr });
  expect(proc.stdout).toBe(stdout);
  expect(proc.stderr).toBe(stderr);
  await proc;
  expect(await collect(stdout.lines())).toEqual(['a', 'b']);

  const errors = new Pipe();
  await tool.run('/bin/main', ['stderr'], { stderr: errors });
  expect(await collect(errors.lines())).toEqual(['oops']);
});

test('pipes given to a process are closed once it exits', async () => {
  const tool = await withTool();
  const [stdin, stdout, device] = [new Pipe(), new Pipe(), new Pipe()];
  await tool.run('/bin/main', ['exit', '1'], { stdin, stdout, devices: { '/dev/test': device } });
  expect([stdin.closed, stdout.closed, device.closed]).toEqual([true, true, true]);
});

test('pipes given to a killed process are closed', async () => {
  const tool = await withTool();
  const stdout = new Pipe();
  const proc = tool.run('/bin/main', ['loop'], { stdout });
  await sleep(200);
  proc.kill();
  await proc;
  expect(stdout.closed).toBe(true);
});

test('closing a full stdout unblocks the process writing to it', async () => {
  const tool = await withTool();
  const stdout = new Pipe({ capacity: 1 });
  const proc = tool.run('/bin/main', ['args', 'blocked'], { stdout });
  await sleep(200);
  stdout.close();
  await expect(proc).resolves.toMatchObject({ killed: false });
});

test('pipes created with close: false are left open', async () => {
  const tool = await withTool();
  const stdout = new Pipe({ close: false });
  await tool.run('/bin/main', ['args', 'first'], { stdout });
  await tool.run('/bin/main', ['args', 'second'], { stdout });
  expect(stdout.closed).toBe(false);
  stdout.close();
  expect(await collect(stdout.lines())).toEqual(['first', 'second']);
});

test('awaiting a process drains the flowing pipes given to it', async () => {
  const tool = await withTool();
  const stdout = new Pipe();
  let data = '';
  stdout.on('data', (chunk) => (data += decode(chunk)));
  stdout.flow();
  await tool.run('/bin/main', ['args', 'flowed'], { stdout });
  expect(data).toBe('flowed\n');
});

test('stdin can be a pipe', async () => {
  const tool = await withTool();
  const stdin = new Pipe();
  await stdin.write('input');
  stdin.close();
  await expect(tool.run('/bin/main', ['cat'], { stdin })).outputs({ stdout: 'input' });
});

test('pipes connect processes', async () => {
  const tool = await withTool();
  const pipe = new Pipe();
  const first = tool.run('/bin/main', ['args', 'piped'], { stdout: pipe });
  const second = tool.run('/bin/main', ['cat'], { stdin: pipe });
  await expect(second).outputs({ stdout: 'piped\n' }); // `first` closes the pipe as it exits
  await first;
});

test('the default stdout and stderr are closed once the process exits', async () => {
  const tool = await withTool();
  const proc = tool.run('/bin/main', ['exit', '0']);
  await proc;
  expect(proc.stdout.closed).toBe(true);
  expect(proc.stderr.closed).toBe(true);
  expect(await proc.stdout.read()).toEqual(new Uint8Array());
});

test('output larger than the default stdout is drained', async () => {
  const tool = await withTool();
  const big = 'y'.repeat(100_000);
  const stdin = new Pipe();
  const proc = tool.run('/bin/main', ['cat'], { stdin });
  const result = expect(proc).outputs({ stdout: big });
  await stdin.write(big);
  stdin.close();
  await result;
});
