import { expect, test } from 'vitest';

import { sleep, withTool } from '../helpers';

test('killed workers are replaced', async () => {
  const tool = await withTool();
  const proc = tool.run('/bin/main', ['loop']);
  await sleep(200);
  proc.kill();
  await proc;
  expect(await tool.run('/bin/main', ['exit', '1'])).toEqual({ exitCode: 1, killed: false });
});
