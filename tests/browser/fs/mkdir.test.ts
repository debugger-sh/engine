import { expect, test } from 'vitest';

import { createEngine } from '../helpers';

test('mkdir, recursively and not', async () => {
  const { fs } = await createEngine();
  await fs.mkdir('/a');
  await fs.mkdir('/b/c/d', { recursive: true });
  await expect(fs.mkdir('/x/y')).rejects.toThrow();
  expect(await fs.readDir('/b/c')).toEqual(['d']);
});
