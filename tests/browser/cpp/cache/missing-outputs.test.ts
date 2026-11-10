import { expect, test } from 'vitest';

import { createEngine } from '../../helpers';

test('missing objects or dependency files cause a recompile', async () => {
  const engine = await createEngine({ 'main.cpp': 'int main() { return 3; }' });
  await engine.run('cpp');
  await engine.fs.remove('/build/main.cpp.o');
  expect((await engine.run('cpp')).exitCode).toBe(3);
  await engine.fs.remove('/build/main.cpp.d');
  expect((await engine.run('cpp')).exitCode).toBe(3);
});
