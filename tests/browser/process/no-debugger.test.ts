import { expect, test } from 'vitest';

import { withTool } from '../helpers';

test('the debugger is undefined without debug: true', async () => {
  const tool = await withTool();
  expect(tool.run('/bin/main', ['exit', '0']).debugger).toBeUndefined();
});
