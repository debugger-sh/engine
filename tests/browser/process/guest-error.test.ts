import { expect, test } from 'vitest';

import { output, withTool } from '../helpers';

test('guest errors exit with 134', async () => {
  const tool = await withTool();
  const result = await output(tool.run('/bin/main', ['trap']));
  expect(result.exitCode).toBe(134);
  expect(result.stderr).toMatch(/^\/bin\/main: /);
});
