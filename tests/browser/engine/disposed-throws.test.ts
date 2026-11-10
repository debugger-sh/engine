import { Engine } from 'debugger-sh';
import { expect, test } from 'vitest';

test('using a disposed engine throws', async () => {
  const engine = await Engine.create();
  engine.dispose();
  expect(() => engine.run('cpp')).toThrow();
  await expect(engine.fs.readDir('/')).rejects.toThrow();
});
