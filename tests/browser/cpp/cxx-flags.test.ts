import { expect, test } from 'vitest';

import { createEngine } from '../helpers';

test('cxxFlags are passed to the compiler', async () => {
  const engine = await createEngine({ 'main.cpp': 'int main() { return VALUE; }' });
  expect((await engine.run('cpp', { cxxFlags: ['-DVALUE=7'] })).exitCode).toBe(7);
});
