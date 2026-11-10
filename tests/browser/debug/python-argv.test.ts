import { expect, test } from 'vitest';

import { createEngine, dap, output } from '../helpers';

test('debugged Python scripts see their own argv', async () => {
  const engine = await createEngine({
    app: { files: { 'run.py': 'import sys\nprint(sys.argv)\n' } }
  });
  const proc = engine.run('python', ['/app/run.py', 'arg'], { debug: true });
  const result = output(proc);
  await dap(proc.debugger).start();
  expect((await result).stdout).toBe("['/app/run.py', 'arg']\n");
});
