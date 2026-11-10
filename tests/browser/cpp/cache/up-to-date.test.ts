import { expect, test } from 'vitest';

import { createEngine, HELLO, output } from '../../helpers';

test('up-to-date sources are not recompiled', async () => {
  const engine = await createEngine({ 'main.cpp': HELLO });
  await engine.run('cpp');
  const { modified } = await engine.fs.stat('/build/main.cpp.o');
  expect((await output(engine.run('cpp'))).stdout).toBe('hello\n');
  expect((await engine.fs.stat('/build/main.cpp.o')).modified).toBe(modified);
});
