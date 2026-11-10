import { expect, test } from 'vitest';

import { createEngine } from '../../helpers';

test('changed headers cause a recompile', async () => {
  const engine = await createEngine({
    'main.cpp': '#include "util.h"\nint main() { return X; }',
    'util.h': '#define X 1'
  });
  expect((await engine.run('cpp')).exitCode).toBe(1);
  await engine.fs.writeFile('util.h', '#define X 2');
  expect((await engine.run('cpp')).exitCode).toBe(2);
});
