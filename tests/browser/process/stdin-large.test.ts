import { expect, test } from 'vitest';

import { output, withTool } from '../helpers';

test('stdin larger than its buffer', async () => {
  const tool = await withTool();
  const proc = tool.run('/bin/main', ['cat']);
  const result = output(proc);
  const big = 'x'.repeat(100_000);
  await proc.stdin.write(big);
  proc.stdin.close();
  expect((await result).stdout).toBe(big);
});
