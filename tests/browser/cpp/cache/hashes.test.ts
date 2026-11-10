import { expect, test } from 'vitest';

import { createEngine } from '../../helpers';

test('dependency files record hashes of sources and headers', async () => {
  const engine = await createEngine({
    'main.cpp': '#include "util.h"\nint main() { return X; }',
    'util.h': '#define X 1'
  });
  await engine.run('cpp');
  const dep = await engine.fs.readFile('/build/main.cpp.d', 'utf8');
  expect(dep).toMatch(/^\/main\.cpp: [0-9a-f]{8}$/m);
  expect(dep).toMatch(/^\/util\.h: [0-9a-f]{8}$/m);
});
