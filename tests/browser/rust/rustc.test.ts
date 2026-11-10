import { expect, test } from 'vitest';

import { createEngine } from '../helpers';

test('rustc can be run on its own', async () => {
  const engine = await createEngine({ 'main.rs': 'fn main() {}' });
  const args = [
    '/main.rs',
    '--sysroot',
    '/',
    '--target',
    'wasm32-wasip1',
    '--emit=obj',
    '-o',
    '/main.o'
  ];
  expect((await engine.run('rustc', args, { sysroot: 'rust' })).exitCode).toBe(0);
  expect(await engine.fs.readDir('/')).toContain('main.o');
});
