import { expect, test } from 'vitest';

import { eng } from '../../helpers';

test('forwards args to the python binary', async () => {
  const engine = await eng({ 'main.py': 'import sys; print(sys.argv[1:])' });
  await expect(engine.run('python', ['/main.py', 'x'])).outputs({ stdout: "['x']\n" });
  await expect(engine.run('python', ['-c', 'print(6 * 7)'])).outputs({ stdout: '42\n' });
});

test('env is passed to the program', async () => {
  const engine = await eng({ 'main.py': 'import os; print(os.environ["NAME"])' });
  await expect(engine.run('python', { env: { NAME: 'py' } })).outputs({ stdout: 'py\n' });
});

test('reports exceptions on stderr', async () => {
  const engine = await eng({ 'main.py': 'raise ValueError("bad")' });
  await expect(engine.run('python')).outputs({
    exitCode: 1,
    stderr: expect.stringContaining('ValueError: bad')
  });
});

test('returns the exit code', async () => {
  const engine = await eng({ 'main.py': 'raise SystemExit(3)' });
  expect(await engine.run('python')).toEqual({ exitCode: 3, killed: false });
});

test('reads and writes the shared filesystem', async () => {
  const engine = await eng({
    'main.py': 'open("/out.txt", "w").write(open("/in.txt").read().upper())',
    'in.txt': 'hi'
  });
  await engine.run('python');
  expect(await engine.fs.readFile('/out.txt', 'utf8')).toBe('HI');
});

test('runs the first Python file (alphabetically)', async () => {
  const engine = await eng({ 'b.py': 'print("b")', 'a.py': 'print("a")' });
  await expect(engine.run('python')).outputs({ exitCode: 0, stdout: 'a\n' });
});

test('exits non-zero without any Python file', async () => {
  const engine = await eng();
  expect((await engine.run('python')).exitCode).not.toBe(0);
});

test('runs a REPL with repl: true', async () => {
  const engine = await eng();
  const proc = engine.run('python', { repl: true });
  const result = expect(proc).outputs({ stdout: expect.stringContaining('2') });
  await proc.stdin.write('print(1 + 1)\n');
  proc.stdin.close();
  await result;
});

test('input() reads stdin', async () => {
  const engine = await eng({ 'main.py': 'print(input()[::-1])' });
  const proc = engine.run('python');
  await proc.stdin.write('abc\n');
  await expect(proc).outputs({ stdout: 'cba\n' });
});

test('the standard library is invisible to the filesystem', async () => {
  const engine = await eng({
    'main.py': 'import json, os; print("usr" in os.listdir("/"))'
  });
  await expect(engine.run('python')).outputs({ stdout: 'True\n' });
  expect(await engine.fs.readDir('/')).toEqual(['main.py']);
});
