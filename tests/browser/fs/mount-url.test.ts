import { expect, test } from 'vitest';

import { createEngine } from '../helpers';

test('mount fetches archives from URLs', async () => {
  const source = await createEngine({ 'a.txt': 'from url' });
  const tarball = await source.fs.export({ format: 'tarball' });
  const { fs } = await createEngine();
  await fs.mount(URL.createObjectURL(new Blob([tarball as Uint8Array<ArrayBuffer>])));
  expect(await fs.readFile('a.txt', 'utf8')).toBe('from url');
});
