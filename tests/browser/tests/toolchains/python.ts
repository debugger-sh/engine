import { expect, test } from 'vitest';

import { createEngine, output } from '../../helpers';

test('forwards args to the python binary', async () => {
  const engine = await createEngine({ 'main.py': 'import sys; print(sys.argv[1:])' });
  expect((await output(engine.run('python', ['/main.py', 'x']))).stdout).toBe("['x']\n");
  expect((await output(engine.run('python', ['-c', 'print(6 * 7)']))).stdout).toBe('42\n');
});

test('env is passed to the program', async () => {
  const engine = await createEngine({ 'main.py': 'import os; print(os.environ["NAME"])' });
  expect((await output(engine.run('python', { env: { NAME: 'py' } }))).stdout).toBe('py\n');
});

test('reports exceptions on stderr', async () => {
  const engine = await createEngine({ 'main.py': 'raise ValueError("bad")' });
  expect(await output(engine.run('python'))).toMatchObject({
    exitCode: 1,
    stderr: expect.stringContaining('ValueError: bad')
  });
});

test('returns the exit code', async () => {
  const engine = await createEngine({ 'main.py': 'raise SystemExit(3)' });
  expect(await engine.run('python')).toEqual({ exitCode: 3, killed: false });
});

test('reads and writes the shared filesystem', async () => {
  const engine = await createEngine({
    'main.py': 'open("/out.txt", "w").write(open("/in.txt").read().upper())',
    'in.txt': 'hi'
  });
  await engine.run('python');
  expect(await engine.fs.readFile('/out.txt', 'utf8')).toBe('HI');
});

test('runs the first Python file (alphabetically)', async () => {
  const engine = await createEngine({ 'b.py': 'print("b")', 'a.py': 'print("a")' });
  expect(await output(engine.run('python'))).toMatchObject({ exitCode: 0, stdout: 'a\n' });
});

test('exits non-zero without any Python file', async () => {
  const engine = await createEngine();
  expect((await engine.run('python')).exitCode).not.toBe(0);
});

test('runs a REPL with repl: true', async () => {
  const engine = await createEngine();
  const proc = engine.run('python', { repl: true });
  const result = output(proc);
  await proc.stdin.write('print(1 + 1)\n');
  proc.stdin.close();
  expect((await result).stdout).toContain('2');
});

test('input() reads stdin', async () => {
  const engine = await createEngine({ 'main.py': 'print(input()[::-1])' });
  const proc = engine.run('python');
  await proc.stdin.write('abc\n');
  expect((await output(proc)).stdout).toBe('cba\n');
});

test('the standard library is invisible to the filesystem', async () => {
  const engine = await createEngine({
    'main.py': 'import json, os; print("usr" in os.listdir("/"))'
  });
  expect((await output(engine.run('python'))).stdout).toBe('True\n');
  expect(await engine.fs.readDir('/')).toEqual(['main.py']);
});
