import { expect, test } from 'vitest';

import { output, withTool } from '../helpers';

test('forwards arguments', async () => {
  const tool = await withTool();
  expect((await output(tool.run('/bin/main', ['args', 'a', 'b c']))).stdout).toBe('a\nb c\n');
});
