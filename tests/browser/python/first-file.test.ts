import { expect, test } from 'vitest';

import { createEngine, output } from '../helpers';

test('runs the first Python file (alphabetically) under cwd', async () => {
  const engine = await createEngine({ 'b.py': 'print("b")', 'a.py': 'print("a")' });
  expect(await output(engine.run('python'))).toMatchObject({ exitCode: 0, stdout: 'a\n' });
});
