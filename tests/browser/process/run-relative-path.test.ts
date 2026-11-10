import { expect, test } from 'vitest';

import { withTool } from '../helpers';

test('runs an executable from a relative path, resolved against cwd', async () => {
  const tool = await withTool();
  expect(await tool.run('./main', ['exit', '4'], { cwd: '/bin' })).toEqual({
    exitCode: 4,
    killed: false
  });
});
