import { expect, test } from 'vitest';

import { createEngine, HELLO } from '../helpers';

test('places objects and the executable in buildDir', async () => {
  const engine = await createEngine({ dir: { files: { 'main.cpp': HELLO } } });
  await engine.run('cpp', { buildDir: '/out' });
  expect(await engine.fs.readDir('/out')).toEqual(['dir', 'main']);
  expect(await engine.fs.readDir('/out/dir')).toEqual(['main.cpp.d', 'main.cpp.o']);
});
