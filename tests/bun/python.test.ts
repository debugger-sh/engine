import { afterAll, beforeEach, expect, test } from 'bun:test';
import { Engine } from 'debugger-sh';

import { output } from './helpers';

let engine: Engine;
beforeEach(async () => {
  engine?.dispose();
  engine = await Engine.create();
});
afterAll(() => engine.dispose());

test('runs the first Python file (alphabetically) under cwd', async () => {
  await engine.fs.mount({ 'b.py': 'print("b")', 'a.py': 'print("a")' });
  expect(await output(engine.run('python'))).toMatchObject({ exitCode: 0, stdout: 'a\n' });
});

test('respects cwd when looking for Python files', async () => {
  await engine.fs.mount({ 'a.py': 'print("root")', app: { files: { 'z.py': 'print("app")' } } });
  expect((await output(engine.run('python', { cwd: '/app' }))).stdout).toBe('app\n');
});

test('exits non-zero without any Python file', async () => {
  expect((await output(engine.run('python'))).exitCode).not.toBe(0);
});

test('forwards args to the python binary', async () => {
  await engine.fs.mount({ 'main.py': 'import sys; print(sys.argv[1:])' });
  expect((await output(engine.run('python', ['/main.py', 'x']))).stdout).toBe("['x']\n");
  expect((await output(engine.run('python', ['-c', 'print(6 * 7)']))).stdout).toBe('42\n');
});

test('returns the exit code', async () => {
  await engine.fs.mount({ 'main.py': 'raise SystemExit(3)' });
  expect(await engine.run('python')).toEqual({ exitCode: 3, killed: false });
});

test('reports exceptions on stderr', async () => {
  await engine.fs.mount({ 'main.py': 'raise ValueError("bad")' });
  const result = await output(engine.run('python'));
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('ValueError: bad');
});

test('reads stdin', async () => {
  await engine.fs.mount({ 'main.py': 'print(input()[::-1])' });
  const proc = engine.run('python');
  await proc.stdin.write('abc\n');
  expect((await output(proc)).stdout).toBe('cba\n');
});

test('runs a REPL with repl: true', async () => {
  const proc = engine.run('python', { repl: true });
  const result = output(proc);
  await proc.stdin.write('print(1 + 1)\n');
  proc.stdin.close();
  expect((await result).stdout).toContain('2');
});

test('reads and writes the shared filesystem', async () => {
  await engine.fs.mount({
    'main.py': 'open("/out.txt", "w").write(open("/in.txt").read().upper())',
    'in.txt': 'hi'
  });
  await engine.run('python');
  expect(await engine.fs.readFile('/out.txt', 'utf8')).toBe('HI');
});

test('the standard library sysroot is invisible to the filesystem', async () => {
  await engine.fs.mount({ 'main.py': 'import json, os; print("usr" in os.listdir("/"))' });
  expect((await output(engine.run('python'))).stdout).toBe('True\n');
  expect(await engine.fs.readDir('/')).toEqual(['main.py']);
});

test('env is passed to the program', async () => {
  await engine.fs.mount({ 'main.py': 'import os; print(os.environ["NAME"])' });
  expect((await output(engine.run('python', { env: { NAME: 'py' } }))).stdout).toBe('py\n');
});
