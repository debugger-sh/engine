import { expect, test } from 'vitest';

import { createEngine } from '../helpers';

test('export at a directory with include and exclude globs', async () => {
  const { fs } = await createEngine({
    build: { files: { 'main.o': 'o', 'main.d': 'd', sub: { files: { 'x.o': 'x' } } } }
  });
  const tree = await fs.export({ at: '/build', include: ['**/*.o'], exclude: ['sub/**'] });
  expect(Object.keys(tree)).toEqual(['main.o']);
});
