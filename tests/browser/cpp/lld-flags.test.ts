import { expect, test } from 'vitest';

import { createEngine, HELLO } from '../helpers';

test('lldFlags are passed to the linker', async () => {
  const engine = await createEngine({ 'main.cpp': HELLO });
  expect((await engine.run('cpp', { lldFlags: ['--bogus-flag'] })).exitCode).not.toBe(0);
});
