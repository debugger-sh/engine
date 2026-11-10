import { expect, test } from 'vitest';

import { createEngine } from '../helpers';

test('remove files and directories', async () => {
  const { fs } = await createEngine({ 'a.txt': 'a', dir: { files: { 'b.txt': 'b' } } });
  await fs.remove('a.txt');
  await expect(fs.remove('dir')).rejects.toThrow();
  await fs.remove('dir', { recursive: true });
  expect(await fs.readDir('/')).toEqual([]);
});
