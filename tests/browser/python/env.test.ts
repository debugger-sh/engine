import { expect, test } from 'vitest';

import { createEngine, output } from '../helpers';

test('env is passed to the program', async () => {
  const engine = await createEngine({ 'main.py': 'import os; print(os.environ["NAME"])' });
  expect((await output(engine.run('python', { env: { NAME: 'py' } }))).stdout).toBe('py\n');
});
