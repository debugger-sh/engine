import { expect, test } from 'vitest';

import { output, withTool } from '../helpers';

test('files written by the main thread are visible to processes', async () => {
  const tool = await withTool();
  await tool.fs.writeFile('/hello.txt', 'from host');
  expect((await output(tool.run('/bin/main', ['read', '/hello.txt']))).stdout).toBe('from host');
});
