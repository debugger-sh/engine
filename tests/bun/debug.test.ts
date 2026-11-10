import { afterAll, beforeEach, expect, test } from 'bun:test';
import { type Debugger, Engine } from 'debugger-sh';

import { output } from './helpers';

let engine: Engine;
beforeEach(async () => {
  engine?.dispose();
  engine = await Engine.create();
});
afterAll(() => engine.dispose());

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Message = { type: string; event?: string; command?: string; success?: boolean; body?: any };

/** A minimal DAP client. */
function client(dbg: Debugger) {
  const events: Message[] = [];
  const waiters: (() => void)[] = [];
  dbg.on('event', (e) => {
    events.push(e as Message);
    waiters.splice(0).forEach((wake) => wake());
  });
  let seq = 1;
  return {
    request: (command: string, args: object = {}) =>
      dbg.send({ type: 'request', seq: seq++, command, arguments: args }) as Message,
    async event(name: string): Promise<Message> {
      for (;;) {
        const index = events.findIndex((e) => e.event === name);
        if (index >= 0) return events.splice(index, 1)[0];
        await new Promise<void>((wake) => waiters.push(wake));
      }
    }
  };
}

const CPP = `#include <cstdio>
int main() {
  int x = 41;
  x++;
  printf("%d\\n", x);
}`;

test('debugging a C++ program stops at breakpoints', async () => {
  await engine.fs.mount({ 'main.cpp': CPP });
  const proc = engine.run('cpp', { debug: true });
  const result = output(proc);
  const dap = client(proc.debugger);

  expect(dap.request('initialize').success).toBe(true);
  await dap.event('initialized');
  const bps = dap.request('setBreakpoints', {
    source: { path: '/main.cpp' },
    breakpoints: [{ line: 4 }]
  });
  expect(bps.body.breakpoints[0]).toMatchObject({ verified: true, line: 4 });
  dap.request('configurationDone');

  expect((await dap.event('stopped')).body).toMatchObject({ reason: 'breakpoint' });
  const [frame] = dap.request('stackTrace', { threadId: 1 }).body.stackFrames;
  expect(frame).toMatchObject({ name: 'main', line: 4 });
  const [locals] = dap.request('scopes', { frameId: frame.id }).body.scopes;
  const vars = dap.request('variables', { variablesReference: locals.variablesReference }).body
    .variables;
  expect(vars).toContainEqual(expect.objectContaining({ name: 'x', value: '41' }));

  dap.request('continue', { threadId: 1 });
  await dap.event('terminated');
  expect(await result).toMatchObject({ exitCode: 0, stdout: '42\n' });
});

test('debugged processes wait for the DAP handshake', async () => {
  await engine.fs.mount({ 'main.cpp': CPP });
  const proc = engine.run('cpp', { debug: true });
  const result = output(proc);
  const dap = client(proc.debugger);
  dap.request('initialize');
  await dap.event('initialized');
  await Bun.sleep(500);
  let finished = false;
  void result.then(() => (finished = true));
  expect(finished).toBe(false);
  dap.request('configurationDone');
  expect(await result).toMatchObject({ exitCode: 0, stdout: '42\n' });
});

test('any WASI executable with DWARF can be debugged', async () => {
  await engine.fs.mount({ 'main.cpp': CPP });
  await engine.run('cpp');
  const proc = engine.run('/build/main', { debug: true });
  const dap = client(proc.debugger);
  dap.request('initialize');
  await dap.event('initialized');
  dap.request('setBreakpoints', { source: { path: '/main.cpp' }, breakpoints: [{ line: 5 }] });
  dap.request('configurationDone');
  expect((await dap.event('stopped')).body).toMatchObject({ reason: 'breakpoint' });
  dap.request('continue', { threadId: 1 });
  expect((await proc).exitCode).toBe(0);
});

test('debugging Python stops at breakpoints', async () => {
  await engine.fs.mount({ 'main.py': 'x = 1\ny = x + 1\nprint(y)\n' });
  const proc = engine.run('python', { debug: true });
  const result = output(proc);
  const dap = client(proc.debugger);
  dap.request('initialize');
  await dap.event('initialized');
  dap.request('setBreakpoints', { source: { path: '/main.py' }, breakpoints: [{ line: 2 }] });
  dap.request('configurationDone');
  expect((await dap.event('stopped')).body).toMatchObject({ reason: 'breakpoint' });
  const frames = dap.request('stackTrace', { threadId: 1 }).body.stackFrames;
  expect(frames[0]).toMatchObject({ line: 2 });
  dap.request('continue', { threadId: 1 });
  expect(await result).toMatchObject({ exitCode: 0, stdout: '2\n' });
});

test('Python scripts see their own argv when debugged', async () => {
  await engine.fs.mount({ app: { files: { 'run.py': 'import sys\nprint(sys.argv)\n' } } });
  const proc = engine.run('python', ['/app/run.py', 'arg'], { debug: true });
  const result = output(proc);
  const dap = client(proc.debugger);
  dap.request('initialize');
  await dap.event('initialized');
  dap.request('configurationDone');
  expect((await result).stdout).toBe("['/app/run.py', 'arg']\n");
});

test('a failed build terminates the debug session', async () => {
  await engine.fs.mount({ 'main.cpp': 'nope' });
  const proc = engine.run('cpp', { debug: true });
  const dap = client(proc.debugger);
  dap.request('initialize');
  await dap.event('terminated');
  expect((await proc).exitCode).not.toBe(0);
});

test('each process has its own debugger', async () => {
  await engine.fs.mount({ 'main.cpp': CPP });
  const a = engine.run('cpp', { debug: true });
  const b = engine.run('cpp', { debug: true });
  expect(a.debugger).not.toBe(b.debugger);
  a.kill();
  b.kill();
});
