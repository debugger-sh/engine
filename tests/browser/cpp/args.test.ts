import { expect, test } from 'vitest';

import { createEngine, output } from '../helpers';

test('forwards args to the program', async () => {
  const engine = await createEngine({
    'main.cpp': '#include <cstdio>\nint main(int c, char** v) { printf("%s %s", v[1], v[2]); }'
  });
  expect((await output(engine.run('cpp', ['a', 'b']))).stdout).toBe('a b');
});
