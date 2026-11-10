import { expect, test } from 'vitest';

import { createEngine } from '../helpers';

test('mount accepts bytes, base64 and utf8 contents', async () => {
  const { fs } = await createEngine({
    'bytes.bin': new Uint8Array([1, 2, 3]),
    'b64.txt': { contents: btoa('hello'), encoding: 'base64' },
    'utf8.txt': { contents: 'héllo', encoding: 'utf8' }
  });
  expect(await fs.readFile('bytes.bin')).toEqual(new Uint8Array([1, 2, 3]));
  expect(await fs.readFile('b64.txt', 'utf8')).toBe('hello');
  expect(await fs.readFile('utf8.txt', 'utf8')).toBe('héllo');
});
