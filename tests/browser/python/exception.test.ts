import { expect, test } from 'vitest';

import { createEngine, output } from '../helpers';

test('reports exceptions on stderr', async () => {
  const engine = await createEngine({ 'main.py': 'raise ValueError("bad")' });
  expect(await output(engine.run('python'))).toMatchObject({
    exitCode: 1,
    stderr: expect.stringContaining('ValueError: bad')
  });
});
