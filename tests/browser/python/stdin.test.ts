import { expect, test } from 'vitest';

import { createEngine, output } from '../helpers';

test('input() reads stdin', async () => {
  const engine = await createEngine({ 'main.py': 'print(input()[::-1])' });
  const proc = engine.run('python');
  await proc.stdin.write('abc\n');
  expect((await output(proc)).stdout).toBe('cba\n');
});
