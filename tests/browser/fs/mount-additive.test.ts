import { expect, test } from 'vitest';

import { createEngine } from '../helpers';

test('mount is additive and overrides conflicting files', async () => {
  const { fs } = await createEngine({ 'a.txt': 'a', 'b.txt': 'b' });
  await fs.mount({ 'b.txt': 'B', 'c.txt': 'c' });
  expect(await fs.readDir('/')).toEqual(['a.txt', 'b.txt', 'c.txt']);
  expect(await fs.readFile('b.txt', 'utf8')).toBe('B');
});
