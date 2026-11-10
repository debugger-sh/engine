import { expect, test } from 'vitest';

import { createEngine, dap } from '../helpers';

test('a failed build terminates the debug session', async () => {
  const engine = await createEngine({ 'main.cpp': 'nope' });
  const proc = engine.run('cpp', { debug: true });
  const client = dap(proc.debugger);
  client.request('initialize');
  await client.event('terminated');
  expect((await proc).exitCode).not.toBe(0);
});
