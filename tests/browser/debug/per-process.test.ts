import { expect, test } from 'vitest';

import { createEngine } from '../helpers';

const CPP = '#include <cstdio>\nint main() {\n  int x = 41;\n  x++;\n  printf("%d\\n", x);\n}';

test('each process has its own debugger', async () => {
  const engine = await createEngine({ 'main.cpp': CPP });
  const [a, b] = [engine.run('cpp', { debug: true }), engine.run('cpp', { debug: true })];
  expect(a.debugger).not.toBe(b.debugger);
  a.kill();
  b.kill();
});
