import { toolchainProvenance } from 'debugger-sh';
import { expect, test } from 'vitest';

import { eng, HELLO, sleep } from '../../helpers';

test('forwards args to the program', async () => {
  const engine = await eng({
    'main.cpp': '#include <cstdio>\nint main(int c, char** v) { printf("%s %s", v[1], v[2]); }'
  });
  await expect(engine.run('cpp', ['a', 'b'])).outputs({ stdout: 'a b' });
});

test('places objects and the executable in buildDir', async () => {
  const engine = await eng({ dir: { files: { 'main.cpp': HELLO } } });
  await engine.run('cpp', { buildDir: '/out' });
  expect(await engine.fs.readDir('/out')).toEqual(['dir', 'main']);
  expect(await engine.fs.readDir('/out/dir')).toEqual(['main.cpp.d', 'main.cpp.o']);
});

test('clang compiles C', async () => {
  const engine = await eng({ 'main.c': 'int main(void) { return 0; }' });
  const args = ['--target=wasm32-wasip1', '--sysroot=/', '-c', '/main.c', '-o', '/main.o'];
  expect((await engine.run('clang', args, { sysroot: 'cpp' })).exitCode).toBe(0);
  expect(await engine.fs.readDir('/')).toContain('main.o');
});

test('compile errors exit non-zero, reported on stderr', async () => {
  const engine = await eng({ 'main.cpp': 'int main() { return x; }' });
  await expect(engine.run('cpp')).outputs({
    exitCode: expect.toSatisfy((code) => code !== 0),
    stderr: expect.stringContaining('error')
  });
});

test('cxxFlags are passed to the compiler', async () => {
  const engine = await eng({ 'main.cpp': 'int main() { return VALUE; }' });
  expect((await engine.run('cpp', { cxxFlags: ['-DVALUE=7'] })).exitCode).toBe(7);
});

test('returns the program’s exit code', async () => {
  const engine = await eng({ 'main.cpp': 'int main() { return 42; }' });
  expect(await engine.run('cpp')).toEqual({ exitCode: 42, killed: false });
});

test('compiles, links and runs', async () => {
  const engine = await eng({ 'main.cpp': HELLO });
  await expect(engine.run('cpp')).outputs({ exitCode: 0, stdout: 'hello\n' });
});

test('compileOnly produces an executable without running guest code', async () => {
  const engine = await eng({ 'main.cpp': HELLO });
  await expect(engine.run('cpp', { compileOnly: true })).outputs({ exitCode: 0, stdout: '' });
  await expect(engine.run('/build/main')).outputs({ exitCode: 0, stdout: 'hello\n' });
});

test('cache receipts include sysroot identity and hash system headers', async () => {
  const engine = await eng({ 'main.cpp': HELLO });
  await engine.run('cpp', { compileOnly: true });
  const dep = await engine.fs.readFile('/build/main.cpp.d', 'utf8');
  expect(dep).toContain(`"sysroot":["${toolchainProvenance.cpp.artifacts.sysroot}"`);
  expect(dep).toContain(`"compiler":["${toolchainProvenance.cpp.artifacts.llvm}"`);
  expect(dep).toMatch(/^\/include\/c\+\+\/v1\/cstdio: [0-9a-f]{8}$/m);
});

test('kill stops the build', async () => {
  const engine = await eng({ 'main.cpp': HELLO });
  const proc = engine.run('cpp');
  await sleep(5);
  proc.kill();
  expect(await proc).toEqual({ exitCode: 137, killed: true });
});

test('link errors exit non-zero', async () => {
  const engine = await eng({ 'main.cpp': 'int f(); int main() { return f(); }' });
  expect((await engine.run('cpp')).exitCode).not.toBe(0);
});

test('lldFlags are passed to the linker', async () => {
  const engine = await eng({ 'main.cpp': HELLO });
  expect((await engine.run('cpp', { lldFlags: ['--bogus-flag'] })).exitCode).not.toBe(0);
});

test('compiles multiple sources (in parallel)', async () => {
  const engine = await eng({
    'main.cpp': '#include <cstdio>\nint a(); int b(); int main() { printf("%d", a() + b()); }',
    'a.cpp': 'int a() { return 1; }',
    lib: { files: { 'b.cc': 'int b() { return 2; }' } }
  });
  await expect(engine.run('cpp')).outputs({ stdout: '3' });
});

test('no sources exits non-zero', async () => {
  const engine = await eng();
  expect((await engine.run('cpp')).exitCode).not.toBe(0);
});

test('sources select what is compiled', async () => {
  const engine = await eng({
    app: { files: { 'main.cpp': HELLO, 'broken.cpp': 'nope' } }
  });
  await expect(engine.run('cpp', { sources: ['app/main.cpp'] })).outputs({ stdout: 'hello\n' });
});

test('programs read stdin', async () => {
  const engine = await eng({
    'main.cpp':
      '#include <iostream>\nint main() { std::string s; std::cin >> s; std::cout << s.size(); }'
  });
  const proc = engine.run('cpp', { stdin: true });
  await proc.stdin.write('CS198!\n');
  await expect(proc).outputs({ stdout: '6' });
});

test('individual steps: clang++, lld and the executable', async () => {
  const engine = await eng({ 'main.cpp': HELLO });
  const flags = ['--target=wasm32-wasip1', '--sysroot=/', '-c', '/main.cpp', '-o', '/main.o'];
  expect((await engine.run('clang++', flags, { sysroot: 'cpp' })).exitCode).toBe(0);
  // prettier-ignore
  const lld = ['-L/lib/wasm32-wasip1', '/lib/wasm32-wasip1/crt1.o', '/main.o', '-lc++', '-lc++abi', '-lc',
    '/lib/wasm32-unknown-wasip1/libclang_rt.builtins.a', '-o', '/main'];
  expect((await engine.run('lld', lld, { sysroot: 'cpp' })).exitCode).toBe(0);
  await expect(engine.run('/main')).outputs({ stdout: 'hello\n' });
});

test('the sysroot is invisible to the filesystem', async () => {
  const engine = await eng({ 'main.cpp': HELLO });
  await engine.run('cpp');
  expect(await engine.fs.readDir('/')).toEqual(['build', 'main.cpp']);
});

test('changed flags cause a recompile', async () => {
  const engine = await eng({ 'main.cpp': 'int main() { return VALUE; }' });
  expect((await engine.run('cpp', { cxxFlags: ['-DVALUE=1'] })).exitCode).toBe(1);
  expect((await engine.run('cpp', { cxxFlags: ['-DVALUE=2'] })).exitCode).toBe(2);
});

test('dependency files record hashes of sources and headers', async () => {
  const engine = await eng({
    'main.cpp': '#include "util.h"\nint main() { return X; }',
    'util.h': '#define X 1'
  });
  await engine.run('cpp');
  const dep = await engine.fs.readFile('/build/main.cpp.d', 'utf8');
  expect(dep).toMatch(/^\/main\.cpp: [0-9a-f]{8}$/m);
  expect(dep).toMatch(/^\/util\.h: [0-9a-f]{8}$/m);
});

test('changed headers cause a recompile', async () => {
  const engine = await eng({
    'main.cpp': '#include "util.h"\nint main() { return X; }',
    'util.h': '#define X 1'
  });
  expect((await engine.run('cpp')).exitCode).toBe(1);
  await engine.fs.writeFile('util.h', '#define X 2');
  expect((await engine.run('cpp')).exitCode).toBe(2);
});

test('missing objects or dependency files cause a recompile', async () => {
  const engine = await eng({ 'main.cpp': 'int main() { return 3; }' });
  await engine.run('cpp');
  await engine.fs.remove('/build/main.cpp.o');
  expect((await engine.run('cpp')).exitCode).toBe(3);
  await engine.fs.remove('/build/main.cpp.d');
  expect((await engine.run('cpp')).exitCode).toBe(3);
});

test('only stale sources are recompiled', async () => {
  const engine = await eng({
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
  const engine = await eng({ 'main.cpp': HELLO });
  await engine.run('cpp');
  const { modified } = await engine.fs.stat('/build/main.cpp.o');
  await expect(engine.run('cpp')).outputs({ stdout: 'hello\n' });
  expect((await engine.fs.stat('/build/main.cpp.o')).modified).toBe(modified);
});

test('changing sysroot identity invalidates otherwise unchanged objects', async () => {
  const engine = await eng({ 'main.cpp': 'int main() { return 0; }' });
  await engine.run('cpp', { compileOnly: true });
  const before = (await engine.fs.stat('/build/main.cpp.o')).modified;
  await sleep(5);
  await expect(
    engine.run('cpp', {
      compileOnly: true,
      sysroot: `${toolchainProvenance.cpp.artifacts.sysroot}#another-toolchain`
    })
  ).outputs({ exitCode: 0 });
  expect((await engine.fs.stat('/build/main.cpp.o')).modified).toBeGreaterThan(before);
});

test('PCH bytes invalidate objects independently of header bytes and PCH is never an object', async () => {
  const engine = await eng({
    'main.cpp': 'int main() { return VALUE; }',
    'support.h': '// unchanged header'
  });
  const pch = async (value: number) => {
    await expect(
      engine.run(
        'clang',
        [
          '-cc1',
          '-triple',
          'wasm32-wasip1',
          '-emit-pch',
          '-disable-free',
          '-isysroot',
          '/',
          '-internal-isystem',
          '/include/c++/v1',
          '-internal-isystem',
          '/include',
          '-internal-isystem',
          '/include/wasm32-wasip1',
          '-x',
          'c++-header',
          '-std=c++23',
          '-O0',
          '-debug-info-kind=standalone',
          '-dwarf-version=5',
          '-fcxx-exceptions',
          '-fexceptions',
          '-exception-model=wasm',
          '-target-feature',
          '+exception-handling',
          '-mllvm',
          '-wasm-enable-eh',
          '-mllvm',
          '-wasm-use-legacy-eh=true',
          `-DVALUE=${value}`,
          '/support.h',
          '-o',
          '/support.pch'
        ],
        { sysroot: 'cpp' }
      )
    ).outputs({ exitCode: 0 });
  };
  const options = { cxxFlags: ['-include-pch', '/support.pch'] };
  await pch(11);
  expect((await engine.run('cpp', options)).exitCode).toBe(11);
  const modified = (await engine.fs.stat('/build/main.cpp.o')).modified;
  expect((await engine.run('cpp', options)).exitCode).toBe(11);
  expect((await engine.fs.stat('/build/main.cpp.o')).modified).toBe(modified);
  await pch(22);
  expect((await engine.run('cpp', options)).exitCode).toBe(22);
  expect(await engine.fs.readDir('/build')).toEqual(['main', 'main.cpp.d', 'main.cpp.o']);
});
