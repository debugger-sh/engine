import { expect, test } from 'vitest';

import { createEngine } from '../helpers';

test('zips round-trip through export and mount', async () => {
  const source = await createEngine({ 'a.txt': 'a', dir: { files: { 'b.txt': 'b' } } });
  const zip = await source.fs.export({ format: 'zip' });
  expect([zip[0], zip[1]]).toEqual([0x50, 0x4b]); // "PK"
  const { fs } = await createEngine();
  await fs.mount(zip);
  expect(await fs.readFile('/dir/b.txt', 'utf8')).toBe('b');
});
