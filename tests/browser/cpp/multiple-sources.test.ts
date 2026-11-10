import { expect, test } from 'vitest';

import { createEngine, output } from '../helpers';

test('compiles multiple sources (in parallel)', async () => {
  const engine = await createEngine({
    'main.cpp': '#include <cstdio>\nint a(); int b(); int main() { printf("%d", a() + b()); }',
    'a.cpp': 'int a() { return 1; }',
    lib: { files: { 'b.cc': 'int b() { return 2; }' } }
  });
  expect((await output(engine.run('cpp'))).stdout).toBe('3');
});
