import { expect, test } from 'vitest';

import { createEngine } from '../helpers';

test('engines have independent filesystems', async () => {
  const [a, b] = await Promise.all([createEngine(), createEngine()]);
  await a.fs.writeFile('/a.txt', 'a');
  expect(await b.fs.readDir('/')).toEqual([]);
});
