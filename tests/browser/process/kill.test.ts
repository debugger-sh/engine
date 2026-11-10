import { expect, test } from 'vitest';

import { sleep, withTool } from '../helpers';

test('kill resolves immediately with 137', async () => {
  const tool = await withTool();
  const proc = tool.run('/bin/main', ['loop']);
  await sleep(200);
  proc.kill();
  expect(await proc).toEqual({ exitCode: 137, killed: true });
});
