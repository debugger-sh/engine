import { expect, test } from 'vitest';

import { output, withTool } from '../helpers';

test('stdin is forwarded until closed', async () => {
  const tool = await withTool();
  const proc = tool.run('/bin/main', ['cat']);
  const result = output(proc);
  expect(proc.stdin.closed).toBe(false);
  await proc.stdin.write('CS198!');
  await proc.stdin.write(new TextEncoder().encode(' bytes'));
  proc.stdin.close();
  expect(proc.stdin.closed).toBe(true);
  expect((await result).stdout).toBe('CS198! bytes');
});
