import { expect, test } from 'vitest';

import { createEngine, dap } from '../helpers';

const CPP = '#include <cstdio>\nint main() {\n  int x = 41;\n  x++;\n  printf("%d\\n", x);\n}';

test('any WASI executable with DWARF can be debugged', async () => {
  const engine = await createEngine({ 'main.cpp': CPP });
  await engine.run('cpp');
  const proc = engine.run('/build/main', { debug: true });
  const client = dap(proc.debugger);
  await client.start('/main.cpp', [5]);
  expect((await client.event('stopped')).body).toMatchObject({ reason: 'breakpoint' });
  client.request('continue', { threadId: 1 });
  expect((await proc).exitCode).toBe(0);
});
