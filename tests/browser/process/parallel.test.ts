import { expect, test } from 'vitest';

import { withTool } from '../helpers';

test('many processes run in parallel', async () => {
  const tool = await withTool();
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) => tool.run('/bin/main', ['exit', `${i}`]))
  );
  expect(results.map((r) => r.exitCode)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
});
