import { expect, test } from 'vitest';

import { createEngine } from '../helpers';

test('link errors exit non-zero', async () => {
  const engine = await createEngine({ 'main.cpp': 'int f(); int main() { return f(); }' });
  expect((await engine.run('cpp')).exitCode).not.toBe(0);
});
