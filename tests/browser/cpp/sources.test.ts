import { expect, test } from 'vitest';

import { createEngine, HELLO, output } from '../helpers';

test('sources and cwd select what is compiled', async () => {
  const engine = await createEngine({
    app: { files: { 'main.cpp': HELLO, 'broken.cpp': 'nope' } }
  });
  expect((await output(engine.run('cpp', { cwd: '/app', sources: ['main.cpp'] }))).stdout).toBe(
    'hello\n'
  );
});
