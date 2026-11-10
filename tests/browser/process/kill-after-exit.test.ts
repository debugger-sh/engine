import { expect, test } from 'vitest';

import { withTool } from '../helpers';

test('kill after exit has no effect', async () => {
  const tool = await withTool();
  const proc = tool.run('/bin/main', ['exit', '2']);
  await proc;
  proc.kill();
  expect(await proc).toEqual({ exitCode: 2, killed: false });
});
