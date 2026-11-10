import { expect, test } from 'vitest';

import { createEngine } from '../helpers';

test('places objects and the executable in buildDir', async () => {
  const engine = await createEngine({ src: { files: { 'main.rs': 'fn main() {}' } } });
  await engine.run('rust', { buildDir: '/out' });
  expect(await engine.fs.readDir('/out')).toContain('main');
  expect(await engine.fs.readDir('/out/src')).toContain('main.rs.o');
});
