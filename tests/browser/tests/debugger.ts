import { expect, test } from 'vitest';

import { createEngine, dap, output, sleep } from '../helpers';

const CPP = '#include <cstdio>\nint main() {\n  int x = 41;\n  x++;\n  printf("%d\\n", x);\n}';

test('debugging C++ stops at breakpoints and inspects variables', async () => {
  const engine = await createEngine({ 'main.cpp': CPP });
  const proc = engine.run('cpp', { debug: true });
  const result = output(proc);
  const client = dap(proc.debugger);
  await client.start('/main.cpp', [4]);

  expect((await client.event('stopped')).body).toMatchObject({ reason: 'breakpoint' });
  const [frame] = client.request('stackTrace', { threadId: 1 }).body.stackFrames;
  expect(frame).toMatchObject({ name: 'main', line: 4 });
  const [locals] = client.request('scopes', { frameId: frame.id }).body.scopes;
  const { variables } = client.request('variables', {
    variablesReference: locals.variablesReference
  }).body;
  expect(variables).toContainEqual(expect.objectContaining({ name: 'x', value: '41' }));

  client.request('continue', { threadId: 1 });
  await client.event('terminated');
  expect(await result).toMatchObject({ exitCode: 0, stdout: '42\n' });
});

test('any WASI executable with DWARF can be debugged', async () => {
  const engine = await createEngine({ 'main.cpp': CPP });
  await engine.run('cpp');
  const proc = engine.run('/build/main', { debug: true });
  const client = dap(proc.debugger);
  await client.start('/main.cpp', [5]);
  expect((await client.event('stopped')).body).toMatchObject({ reason: 'breakpoint' });
  client.request('continue', { threadId: 1 });
  expect((await proc).exitCode).toBe(0);
});

test('a failed build terminates the debug session', async () => {
  const engine = await createEngine({ 'main.cpp': 'nope' });
  const proc = engine.run('cpp', { debug: true });
  const client = dap(proc.debugger);
  client.request('initialize');
  await client.event('terminated');
  expect((await proc).exitCode).not.toBe(0);
});

test('debugged processes wait for the DAP handshake', async () => {
  const engine = await createEngine({ 'main.cpp': CPP });
  const proc = engine.run('cpp', { debug: true });
  let finished = false;
  const result = output(proc).finally(() => (finished = true));
  const client = dap(proc.debugger);
  client.request('initialize');
  await client.event('initialized');
  await sleep(500);
  expect(finished).toBe(false);
  client.request('configurationDone');
  expect(await result).toMatchObject({ exitCode: 0, stdout: '42\n' });
});

test('each process has its own debugger', async () => {
  const engine = await createEngine({ 'main.cpp': CPP });
  const [a, b] = [engine.run('cpp', { debug: true }), engine.run('cpp', { debug: true })];
  expect(a.debugger).not.toBe(b.debugger);
  a.kill();
  b.kill();
});

test('debugged Python scripts see their own argv', async () => {
  const engine = await createEngine({
    app: { files: { 'run.py': 'import sys\nprint(sys.argv)\n' } }
  });
  const proc = engine.run('python', ['/app/run.py', 'arg'], { debug: true });
  const result = output(proc);
  await dap(proc.debugger).start();
  expect((await result).stdout).toBe("['/app/run.py', 'arg']\n");
});

test('debugging Python stops at breakpoints', async () => {
  const engine = await createEngine({ 'main.py': 'x = 1\ny = x + 1\nprint(y)\n' });
  const proc = engine.run('python', { debug: true });
  const result = output(proc);
  const client = dap(proc.debugger);
  await client.start('/main.py', [2]);
  expect((await client.event('stopped')).body).toMatchObject({ reason: 'breakpoint' });
  expect(client.request('stackTrace', { threadId: 1 }).body.stackFrames[0]).toMatchObject({
    line: 2
  });
  client.request('continue', { threadId: 1 });
  expect(await result).toMatchObject({ exitCode: 0, stdout: '2\n' });
});
