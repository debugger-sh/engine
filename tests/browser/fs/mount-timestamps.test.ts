import { expect, test } from 'vitest';

import { createEngine } from '../helpers';

test('mount sets modified and accessed timestamps', async () => {
  const modified = '2026-11-09T12:00:00.000Z';
  const { fs } = await createEngine({
    'a.txt': { contents: 'a', modified, accessed: new Date(modified) }
  });
  expect(await fs.stat('a.txt')).toMatchObject({
    modified: Date.parse(modified),
    accessed: Date.parse(modified)
  });
});
