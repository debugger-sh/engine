import { expect, test } from 'vitest';

import { createEngine } from '../../helpers';

test('only stale sources are recompiled', async () => {
  const engine = await createEngine({
    'main.cpp': 'int a(); int main() { return a(); }',
    'a.cpp': 'int a() { return 1; }'
  });
  await engine.run('cpp');
  const { modified } = await engine.fs.stat('/build/main.cpp.o');
  await engine.fs.writeFile('a.cpp', 'int a() { return 2; }');
  expect((await engine.run('cpp')).exitCode).toBe(2);
  expect((await engine.fs.stat('/build/main.cpp.o')).modified).toBe(modified);
});
