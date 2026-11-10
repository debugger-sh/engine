import { expect, test } from 'vitest';

import { createEngine, HELLO } from '../helpers';

test('the sysroot is invisible to the filesystem', async () => {
  const engine = await createEngine({ 'main.cpp': HELLO });
  await engine.run('cpp');
  expect(await engine.fs.readDir('/')).toEqual(['build', 'main.cpp']);
});
