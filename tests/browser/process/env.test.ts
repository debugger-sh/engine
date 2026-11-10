import { expect, test } from 'vitest';

import { output, withTool } from '../helpers';

test('forwards environment variables', async () => {
  const tool = await withTool();
  const proc = tool.run('/bin/main', ['env', 'NAME'], { env: { NAME: 'value' } });
  expect((await output(proc)).stdout).toBe('value\n');
});
