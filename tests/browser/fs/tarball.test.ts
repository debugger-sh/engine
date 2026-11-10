import { expect, test } from 'vitest';

import { createEngine } from '../helpers';

test('tarballs round-trip through export and mount', async () => {
  const source = await createEngine({
    'a.txt': 'a',
    dir: { files: { 'b.bin': new Uint8Array([0, 255]) } }
  });
  const { fs } = await createEngine();
  await fs.mount(await source.fs.export({ format: 'tar' }), { at: '/copy' });
  expect(await fs.readFile('/copy/a.txt', 'utf8')).toBe('a');
  expect(await fs.readFile('/copy/dir/b.bin')).toEqual(new Uint8Array([0, 255]));
});
