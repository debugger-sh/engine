import { expect, test } from 'vitest';

import { createEngine, dap, output } from '../helpers';

test('debugging Python stops at breakpoints', async () => {
  const engine = await createEngine({ 'main.py': 'x = 1\ny = x + 1\nprint(y)\n' });
  const proc = engine.run('python', { debug: true });
  const result = output(proc);
  const client = dap(proc.debugger);
  await client.start('/main.py', [2]);
  expect((await client.event('stopped')).body).toMatchObject({ reason: 'breakpoint' });
  expect(client.request('stackTrace', { threadId: 1 }).body.stackFrames[0]).toMatchObject({
    line: 2
  });
  client.request('continue', { threadId: 1 });
  expect(await result).toMatchObject({ exitCode: 0, stdout: '2\n' });
});
