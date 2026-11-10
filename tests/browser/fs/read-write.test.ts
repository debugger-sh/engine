import { expect, test } from 'vitest';

import { createEngine } from '../helpers';

test('writeFile and readFile', async () => {
  const { fs } = await createEngine();
  await fs.writeFile('/a.txt', 'text');
  await fs.writeFile('/b.bin', new Uint8Array([7]));
  expect(await fs.readFile('/a.txt', 'utf8')).toBe('text');
  expect(await fs.readFile('/b.bin')).toEqual(new Uint8Array([7]));
});
