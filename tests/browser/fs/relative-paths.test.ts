import { expect, test } from 'vitest';

import { createEngine } from '../helpers';

test('relative paths are relative to the root', async () => {
  const { fs } = await createEngine();
  await fs.writeFile('data.txt', 'x');
  expect(await fs.readFile('/data.txt', 'utf8')).toBe('x');
  expect(await fs.readFile('./dir/../data.txt', 'utf8')).toBe('x');
});
