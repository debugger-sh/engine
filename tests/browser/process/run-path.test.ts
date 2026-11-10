import { expect, test } from 'vitest';

import { withTool } from '../helpers';

test('runs an executable from an absolute path', async () => {
  const tool = await withTool();
  expect(await tool.run('/bin/main', ['exit', '3'])).toEqual({ exitCode: 3, killed: false });
});
