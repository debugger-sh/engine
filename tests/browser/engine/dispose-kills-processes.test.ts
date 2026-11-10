import { expect, test } from 'vitest';

import { sleep, withTool } from '../helpers';

test('dispose kills running processes', async () => {
  const tool = await withTool();
  const proc = tool.run('/bin/main', ['loop']);
  await sleep(200);
  tool.dispose();
  expect(await proc).toEqual({ exitCode: 137, killed: true });
});
