import { expect, test } from 'vitest';

import { createEngine, HELLO, output } from '../helpers';

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
