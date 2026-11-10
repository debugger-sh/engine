import { expect, test } from 'vitest';

import { createEngine, dap, output, sleep } from '../helpers';

const CPP = '#include <cstdio>\nint main() {\n  int x = 41;\n  x++;\n  printf("%d\\n", x);\n}';

test('debugged processes wait for the DAP handshake', async () => {
  const engine = await createEngine({ 'main.cpp': CPP });
  const proc = engine.run('cpp', { debug: true });
  let finished = false;
  const result = output(proc).finally(() => (finished = true));
  const client = dap(proc.debugger);
  client.request('initialize');
  await client.event('initialized');
  await sleep(500);
  expect(finished).toBe(false);
  client.request('configurationDone');
  expect(await result).toMatchObject({ exitCode: 0, stdout: '42\n' });
});
