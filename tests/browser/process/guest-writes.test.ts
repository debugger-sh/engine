import { expect, test } from 'vitest';

import { withTool } from '../helpers';

test('files written by processes are visible to the main thread', async () => {
  const tool = await withTool();
  await tool.run('/bin/main', ['write', '/written.txt', 'from guest']);
  expect(await tool.fs.readFile('/written.txt', 'utf8')).toBe('from guest');
});
