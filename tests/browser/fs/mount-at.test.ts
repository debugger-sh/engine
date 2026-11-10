import { expect, test } from 'vitest';

import { createEngine } from '../helpers';

test('mount at a directory', async () => {
  const { fs } = await createEngine();
  await fs.mount({ 'a.txt': 'a' }, { at: '/deep/dir' });
  expect(await fs.readFile('/deep/dir/a.txt', 'utf8')).toBe('a');
});
