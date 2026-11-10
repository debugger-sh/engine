import { expect, test } from 'vitest';

import { createEngine, HELLO, output } from '../helpers';

test('compiles, links and runs', async () => {
  const engine = await createEngine({ 'main.cpp': HELLO });
  expect(await output(engine.run('cpp'))).toMatchObject({ exitCode: 0, stdout: 'hello\n' });
});
