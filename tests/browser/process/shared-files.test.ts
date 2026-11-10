import { expect, test } from 'vitest';

import { output, withTool } from '../helpers';

test('processes see each other’s files', async () => {
  const tool = await withTool();
  await tool.run('/bin/main', ['write', '/shared.txt', 'shared']);
  expect((await output(tool.run('/bin/main', ['read', '/shared.txt']))).stdout).toBe('shared');
});
