import { expect, test } from 'vitest';

import { createEngine } from '../helpers';

test('exits non-zero without any Python file', async () => {
  const engine = await createEngine();
  expect((await engine.run('python')).exitCode).not.toBe(0);
});
