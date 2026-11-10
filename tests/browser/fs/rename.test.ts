import { expect, test } from 'vitest';

import { createEngine } from '../helpers';

test('rename', async () => {
  const { fs } = await createEngine({ 'a.txt': 'a' });
  await fs.rename('a.txt', 'b.txt');
  expect(await fs.readDir('/')).toEqual(['b.txt']);
});
