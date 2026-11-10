import { expect, test } from 'vitest';

import { createEngine } from '../../helpers';

test('changed flags cause a recompile', async () => {
  const engine = await createEngine({ 'main.cpp': 'int main() { return VALUE; }' });
  expect((await engine.run('cpp', { cxxFlags: ['-DVALUE=1'] })).exitCode).toBe(1);
  expect((await engine.run('cpp', { cxxFlags: ['-DVALUE=2'] })).exitCode).toBe(2);
});
