import { expect, test } from 'vitest';

import { createEngine, output } from '../helpers';

test('runs a REPL with repl: true', async () => {
  const engine = await createEngine();
  const proc = engine.run('python', { repl: true });
  const result = output(proc);
  await proc.stdin.write('print(1 + 1)\n');
  proc.stdin.close();
  expect((await result).stdout).toContain('2');
});
