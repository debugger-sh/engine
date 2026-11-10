import { expect, test } from 'vitest';

import { createEngine } from '../helpers';

test('clang compiles C', async () => {
  const engine = await createEngine({ 'main.c': 'int main(void) { return 0; }' });
  const args = ['--target=wasm32-wasip1', '--sysroot=/', '-c', '/main.c', '-o', '/main.o'];
  expect((await engine.run('clang', args, { sysroot: 'cpp' })).exitCode).toBe(0);
  expect(await engine.fs.readDir('/')).toContain('main.o');
});
