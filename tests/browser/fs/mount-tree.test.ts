import { expect, test } from 'vitest';

import { createEngine } from '../helpers';

test('mount creates files and directories from a tree', async () => {
  const { fs } = await createEngine({
    'main.cpp': 'int main() {}',
    data: { files: { 'res.txt': 'Jacob' } }
  });
  expect(await fs.readDir('/')).toEqual(['data', 'main.cpp']);
  expect(await fs.readFile('/data/res.txt', 'utf8')).toBe('Jacob');
});
