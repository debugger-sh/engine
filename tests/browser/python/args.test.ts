import { expect, test } from 'vitest';

import { createEngine, output } from '../helpers';

test('forwards args to the python binary', async () => {
  const engine = await createEngine({ 'main.py': 'import sys; print(sys.argv[1:])' });
  expect((await output(engine.run('python', ['/main.py', 'x']))).stdout).toBe("['x']\n");
  expect((await output(engine.run('python', ['-c', 'print(6 * 7)']))).stdout).toBe('42\n');
});
