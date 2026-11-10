import { expect, test } from 'vitest';

import { createEngine } from '../helpers';

test('no sources exits non-zero', async () => {
  const engine = await createEngine();
  expect((await engine.run('cpp')).exitCode).not.toBe(0);
});
