import { expect, test } from 'vitest';

import { createEngine } from '../helpers';

test('readFile of a missing file rejects', async () => {
  const { fs } = await createEngine();
  await expect(fs.readFile('/missing')).rejects.toThrow();
});
