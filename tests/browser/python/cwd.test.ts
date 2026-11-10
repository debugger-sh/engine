import { expect, test } from 'vitest';

import { createEngine, output } from '../helpers';

test('looks for Python files under cwd', async () => {
  const engine = await createEngine({
    'a.py': 'print("root")',
    app: { files: { 'z.py': 'print("app")' } }
  });
  expect((await output(engine.run('python', { cwd: '/app' }))).stdout).toBe('app\n');
});
