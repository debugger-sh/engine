import { expect, test } from 'vitest';

import { withTool } from '../helpers';

test('runs an executable from bytes', async () => {
  const tool = await withTool();
  const bytes = await tool.fs.readFile('/bin/main');
  expect(await tool.run(bytes, ['exit', '5'])).toEqual({ exitCode: 5, killed: false });
});
