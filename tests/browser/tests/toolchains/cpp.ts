import { expect, test } from 'vitest';

import { createEngine, HELLO, output, sleep } from '../../helpers';

test('forwards args to the program', async () => {
  const engine = await createEngine({
    'main.cpp': '#include <cstdio>\nint main(int c, char** v) { printf("%s %s", v[1], v[2]); }'
  });
  expect((await output(engine.run('cpp', ['a', 'b']))).stdout).toBe('a b');
});

test('places objects and the executable in buildDir', async () => {
  const engine = await createEngine({ dir: { files: { 'main.cpp': HELLO } } });
  await engine.run('cpp', { buildDir: '/out' });
  expect(await engine.fs.readDir('/out')).toEqual(['dir', 'main']);
  expect(await engine.fs.readDir('/out/dir')).toEqual(['main.cpp.d', 'main.cpp.o']);
});

test('clang compiles C', async () => {
  const engine = await createEngine({ 'main.c': 'int main(void) { return 0; }' });
  const args = ['--target=wasm32-wasip1', '--sysroot=/', '-c', '/main.c', '-o', '/main.o'];
  expect((await engine.run('clang', args, { sysroot: 'cpp' })).exitCode).toBe(0);
  expect(await engine.fs.readDir('/')).toContain('main.o');
});

test('compile errors exit non-zero, reported on stderr', async () => {
  const engine = await createEngine({ 'main.cpp': 'int main() { return x; }' });
  const result = await output(engine.run('cpp'));
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain('error');
});

test('cxxFlags are passed to the compiler', async () => {
  const engine = await createEngine({ 'main.cpp': 'int main() { return VALUE; }' });
  expect((await engine.run('cpp', { cxxFlags: ['-DVALUE=7'] })).exitCode).toBe(7);
});

test('returns the program’s exit code', async () => {
  const engine = await createEngine({ 'main.cpp': 'int main() { return 42; }' });
  expect(await engine.run('cpp')).toEqual({ exitCode: 42, killed: false });
});

test('compiles, links and runs', async () => {
  const engine = await createEngine({ 'main.cpp': HELLO });
  expect(await output(engine.run('cpp'))).toMatchObject({ exitCode: 0, stdout: 'hello\n' });
});

test('kill stops the build', async () => {
  const engine = await createEngine({ 'main.cpp': HELLO });
  const proc = engine.run('cpp');
  await sleep(100);
  proc.kill();
  expect(await proc).toEqual({ exitCode: 137, killed: true });
});

test('link errors exit non-zero', async () => {
  const engine = await createEngine({ 'main.cpp': 'int f(); int main() { return f(); }' });
  expect((await engine.run('cpp')).exitCode).not.toBe(0);
});

test('lldFlags are passed to the linker', async () => {
  const engine = await createEngine({ 'main.cpp': HELLO });
  expect((await engine.run('cpp', { lldFlags: ['--bogus-flag'] })).exitCode).not.toBe(0);
});

test('compiles multiple sources (in parallel)', async () => {
  const engine = await createEngine({
    'main.cpp': '#include <cstdio>\nint a(); int b(); int main() { printf("%d", a() + b()); }',
    'a.cpp': 'int a() { return 1; }',
    lib: { files: { 'b.cc': 'int b() { return 2; }' } }
  });
  expect((await output(engine.run('cpp'))).stdout).toBe('3');
});

test('no sources exits non-zero', async () => {
  const engine = await createEngine();
  expect((await engine.run('cpp')).exitCode).not.toBe(0);
});

test('sources and cwd select what is compiled', async () => {
  const engine = await createEngine({
    app: { files: { 'main.cpp': HELLO, 'broken.cpp': 'nope' } }
  });
  expect((await output(engine.run('cpp', { cwd: '/app', sources: ['main.cpp'] }))).stdout).toBe(
    'hello\n'
  );
});

test('programs read stdin', async () => {
  const engine = await createEngine({
    'main.cpp':
      '#include <iostream>\nint main() { std::string s; std::cin >> s; std::cout << s.size(); }'
  });
  const proc = engine.run('cpp');
  await proc.stdin.write('CS198!\n');
  expect((await output(proc)).stdout).toBe('6');
});

test('individual steps: clang++, lld and the executable', async () => {
  const engine = await createEngine({ 'main.cpp': HELLO });
  const flags = ['--target=wasm32-wasip1', '--sysroot=/', '-c', '/main.cpp', '-o', '/main.o'];
  expect((await engine.run('clang++', flags, { sysroot: 'cpp' })).exitCode).toBe(0);
  // prettier-ignore
  const lld = ['-L/lib/wasm32-wasip1', '/lib/wasm32-wasip1/crt1.o', '/main.o', '-lc++', '-lc++abi', '-lc',
    '/lib/wasm32-unknown-wasip1/libclang_rt.builtins.a', '-o', '/main'];
  expect((await engine.run('lld', lld, { sysroot: 'cpp' })).exitCode).toBe(0);
  expect((await output(engine.run('/main'))).stdout).toBe('hello\n');
});

test('the sysroot is invisible to the filesystem', async () => {
  const engine = await createEngine({ 'main.cpp': HELLO });
  await engine.run('cpp');
  expect(await engine.fs.readDir('/')).toEqual(['build', 'main.cpp']);
});

test('changed flags cause a recompile', async () => {
  const engine = await createEngine({ 'main.cpp': 'int main() { return VALUE; }' });
  expect((await engine.run('cpp', { cxxFlags: ['-DVALUE=1'] })).exitCode).toBe(1);
  expect((await engine.run('cpp', { cxxFlags: ['-DVALUE=2'] })).exitCode).toBe(2);
});

test('dependency files record hashes of sources and headers', async () => {
  const engine = await createEngine({
    'main.cpp': '#include "util.h"\nint main() { return X; }',
    'util.h': '#define X 1'
  });
  await engine.run('cpp');
  const dep = await engine.fs.readFile('/build/main.cpp.d', 'utf8');
  expect(dep).toMatch(/^\/main\.cpp: [0-9a-f]{8}$/m);
  expect(dep).toMatch(/^\/util\.h: [0-9a-f]{8}$/m);
});

test('changed headers cause a recompile', async () => {
  const engine = await createEngine({
    'main.cpp': '#include "util.h"\nint main() { return X; }',
    'util.h': '#define X 1'
  });
  expect((await engine.run('cpp')).exitCode).toBe(1);
  await engine.fs.writeFile('util.h', '#define X 2');
  expect((await engine.run('cpp')).exitCode).toBe(2);
});

test('missing objects or dependency files cause a recompile', async () => {
  const engine = await createEngine({ 'main.cpp': 'int main() { return 3; }' });
  await engine.run('cpp');
  await engine.fs.remove('/build/main.cpp.o');
  expect((await engine.run('cpp')).exitCode).toBe(3);
  await engine.fs.remove('/build/main.cpp.d');
  expect((await engine.run('cpp')).exitCode).toBe(3);
});

test('only stale sources are recompiled', async () => {
  const engine = await createEngine({
    'main.cpp': 'int a(); int main() { return a(); }',
    'a.cpp': 'int a() { return 1; }'
  });
  await engine.run('cpp');
  const { modified } = await engine.fs.stat('/build/main.cpp.o');
  await engine.fs.writeFile('a.cpp', 'int a() { return 2; }');
  expect((await engine.run('cpp')).exitCode).toBe(2);
  expect((await engine.fs.stat('/build/main.cpp.o')).modified).toBe(modified);
});

test('up-to-date sources are not recompiled', async () => {
  const engine = await createEngine({ 'main.cpp': HELLO });
  await engine.run('cpp');
  const { modified } = await engine.fs.stat('/build/main.cpp.o');
  expect((await output(engine.run('cpp'))).stdout).toBe('hello\n');
  expect((await engine.fs.stat('/build/main.cpp.o')).modified).toBe(modified);
});
