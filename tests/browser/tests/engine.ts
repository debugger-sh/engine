import { Engine } from 'debugger-sh';
import { expect, test } from 'vitest';

import { eng, sleep, withTool } from '../helpers';

test('create returns an engine with an empty filesystem', async () => {
  const engine = await Engine.create();
  expect(await engine.fs.readDir('/')).toEqual([]);
  engine.dispose();
});

test('dispose kills running processes', async () => {
  const tool = await withTool();
  const proc = tool.run('/bin/main', ['loop']);
  await sleep(200);
  tool.dispose();
  expect(await proc).toEqual({ exitCode: 137, killed: true });
});

test('using a disposed engine throws', async () => {
  const engine = await Engine.create();
  engine.dispose();
  expect(() => engine.run('cpp')).toThrow();
  await expect(engine.fs.readDir('/')).rejects.toThrow();
});

test('engines have independent filesystems', async () => {
  const [a, b] = await Promise.all([eng(), eng()]);
  await a.fs.writeFile('/a.txt', 'a');
  expect(await b.fs.readDir('/')).toEqual([]);
});
