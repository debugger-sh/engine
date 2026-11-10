import { expect, test } from 'vitest';

import { createEngine } from '../helpers';

test('export produces a tree with encodings and timestamps', async () => {
  const modified = '2026-11-09T12:00:00.000Z';
  const { fs } = await createEngine({
    'a.txt': { contents: 'a', modified },
    dir: { files: { 'b.bin': new Uint8Array([255]) } }
  });
  const tree = await fs.export();
  expect(tree['a.txt']).toMatchObject({ contents: 'a', encoding: 'utf8', modified });
  expect(tree['dir']).toMatchObject({
    files: { 'b.bin': { contents: btoa('\xff'), encoding: 'base64' } }
  });
  expect(tree['dir']).toHaveProperty('created');
});
