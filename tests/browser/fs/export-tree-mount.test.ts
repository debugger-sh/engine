import { expect, test } from 'vitest';

import { createEngine } from '../helpers';

test('exported trees can be mounted', async () => {
  const source = await createEngine({
    'a.txt': 'a',
    dir: { files: { 'b.bin': new Uint8Array([1, 255]) } }
  });
  const { fs } = await createEngine(await source.fs.export());
  expect(await fs.readFile('a.txt', 'utf8')).toBe('a');
  expect(await fs.readFile('dir/b.bin')).toEqual(new Uint8Array([1, 255]));
});
