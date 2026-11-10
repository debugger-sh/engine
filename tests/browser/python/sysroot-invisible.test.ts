import { expect, test } from 'vitest';

import { createEngine, output } from '../helpers';

test('the standard library is invisible to the filesystem', async () => {
  const engine = await createEngine({
    'main.py': 'import json, os; print("usr" in os.listdir("/"))'
  });
  expect((await output(engine.run('python'))).stdout).toBe('True\n');
  expect(await engine.fs.readDir('/')).toEqual(['main.py']);
});
