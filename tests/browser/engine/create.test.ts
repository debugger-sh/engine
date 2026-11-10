import { Engine } from 'debugger-sh';
import { expect, test } from 'vitest';

test('create returns an engine with an empty filesystem', async () => {
  const engine = await Engine.create();
  expect(await engine.fs.readDir('/')).toEqual([]);
  engine.dispose();
});
