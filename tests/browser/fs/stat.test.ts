import { expect, test } from 'vitest';

import { createEngine } from '../helpers';

test('stat files and directories', async () => {
  const { fs } = await createEngine({ 'a.txt': 'abc', dir: { files: {} } });
  expect(await fs.stat('a.txt')).toMatchObject({ kind: 'file', size: 3 });
  expect(await fs.stat('dir')).toMatchObject({ kind: 'directory' });
});
