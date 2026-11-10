import { expect, test } from 'bun:test';
import { Engine } from 'debugger-sh';

import { withTool } from './helpers';

test('create returns an engine with an empty filesystem', async () => {
  const engine = await Engine.create();
  expect(await engine.fs.readDir('/')).toEqual([]);
  engine.dispose();
});

test('engines have independent filesystems', async () => {
  const [a, b] = await Promise.all([Engine.create(), Engine.create()]);
  await a.fs.writeFile('/a.txt', 'a');
  expect(await b.fs.readDir('/')).toEqual([]);
  a.dispose();
  b.dispose();
});

test('dispose kills running processes', async () => {
  const engine = await withTool();
  const proc = engine.run('/bin/main', ['cat']);
  await Bun.sleep(500);
  engine.dispose();
  expect(await proc).toEqual({ exitCode: 137, killed: true });
});

test('using a disposed engine throws', async () => {
  const engine = await Engine.create();
  engine.dispose();
  expect(() => engine.run('cpp')).toThrow();
  await expect(engine.fs.readDir('/')).rejects.toThrow();
});
