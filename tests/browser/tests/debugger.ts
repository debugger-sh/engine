import type { Stop } from 'debugger-sh';
import { expect, test } from 'vitest';

import { eng } from '../helpers';

const SQUARE = `int square(int x) {
  int y = x * x;
  return y;
}

int main() {
  int a = square(3);
  return a;
}`;

const POINT = `struct Point {
  int x;
  int y;
};

int scale(int factor) {
  Point p{2 * factor, 3 * factor};
  return p.x * p.y;
}

int main() { return scale(1); }`;

const top = (stop: Stop | null) => stop?.frames()[0];

test('inspects frames, scopes and variables at a breakpoint', async () => {
  const engine = await eng({ 'main.cpp': POINT });
  const proc = engine.run('cpp', { debug: true });
  const dbg = proc.debugger;
  expect(await dbg.setBreakpoints('main.cpp', [{ line: 8 }])).toMatchObject([
    { verified: true, line: 8 }
  ]);

  const stop = await dbg.continue();
  expect(stop).toMatchObject({ reason: 'breakpoint', threadId: 1 });
  const [frame, caller] = stop!.frames();
  expect(frame).toMatchObject({ name: 'scale', line: 8, source: { path: '/main.cpp' } });
  expect(caller).toMatchObject({ name: 'main', line: 11 });
  expect(frame.scopes().map((scope) => scope.name)).toEqual(['Arguments', 'Locals']);
  expect(frame.args().vars()).toMatchObject([{ name: 'factor', value: '1', type: 'int' }]);
  expect(frame.globals().vars()).toEqual([]);

  const [p] = frame.locals().vars();
  expect(p).toMatchObject({ name: 'p', type: 'Point' });
  expect(p.children()).toMatchObject([
    { name: 'x', value: '2' },
    { name: 'y', value: '3' }
  ]);
  expect(p.children({ start: 1 })).toMatchObject([{ name: 'y', value: '3' }]);

  expect(await dbg.continue()).toBeNull();
  expect((await proc).exitCode).toBe(6);
});

test('steps in, over and out', async () => {
  const engine = await eng({ 'main.cpp': SQUARE });
  const proc = engine.run('cpp', { debug: true });
  const dbg = proc.debugger;
  const reasons: string[] = [];
  dbg.on('stop', (stop) => reasons.push(stop.reason));
  await dbg.setBreakpoints('main.cpp', [{ line: 7 }]);

  expect(top(await dbg.continue())).toMatchObject({ name: 'main', line: 7 });
  expect(top(await dbg.stepIn())).toMatchObject({ name: 'square', line: 2 });
  expect(top(await dbg.stepOver())).toMatchObject({ name: 'square', line: 3 });
  expect(top(await dbg.stepOut())).toMatchObject({ name: 'main' });
  expect(await dbg.continue()).toBeNull();
  expect(reasons).toEqual(['breakpoint', 'step', 'step', 'step']);
  expect((await proc).exitCode).toBe(9);
});

test('setBreakpoints replaces the breakpoints of a file', async () => {
  const engine = await eng({ 'main.cpp': SQUARE });
  const dbg = engine.run('cpp', { debug: true }).debugger;
  await dbg.setBreakpoints('main.cpp', [{ line: 7 }]);
  await dbg.setBreakpoints('/main.cpp', [{ line: 3 }]);
  expect(top(await dbg.continue())).toMatchObject({ name: 'square', line: 3 });
  expect(await dbg.continue()).toBeNull();
});

test('continue without breakpoints runs the program to completion', async () => {
  const engine = await eng({ 'main.cpp': SQUARE });
  const proc = engine.run('cpp', { debug: true });
  expect(await proc.debugger.continue()).toBeNull();
  expect(await proc.debugger.stepIn()).toBeNull();
  expect((await proc).exitCode).toBe(9);
});

test('operations resolve if the process exits before it can be debugged', async () => {
  const engine = await eng({ 'main.cpp': 'int main() { return 0; }' });
  const proc = engine.run('cpp', { debug: true });
  proc.kill();

  expect(await proc.debugger.setBreakpoints('main.cpp', [{ line: 1 }, { line: 2 }])).toEqual([
    { verified: false },
    { verified: false }
  ]);
  expect(await proc.debugger.continue()).toBeNull();
  expect((await proc).exitCode).not.toBe(0);
});
