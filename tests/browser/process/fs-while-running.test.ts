import { expect, test } from 'vitest';

import { withTool } from '../helpers';

test('the filesystem stays usable while processes run', async () => {
  const tool = await withTool();
  const busy = tool.run('/bin/main', ['spam', '/spam.txt']);
  await tool.fs.writeFile('/busy.txt', 'ok');
  expect(await tool.fs.readFile('/busy.txt', 'utf8')).toBe('ok');
  busy.kill();
});
