import { expect, test } from 'vitest';

import { withTool } from '../helpers';

test('processes run concurrently', async () => {
  const tool = await withTool();
  const looping = tool.run('/bin/main', ['loop']);
  expect(await tool.run('/bin/main', ['exit', '7'])).toEqual({ exitCode: 7, killed: false });
  looping.kill();
});
