import { expect, test } from 'vitest';

import { createEngine, output } from '../helpers';

test('unknown commands exit with 127', async () => {
  const engine = await createEngine();
  expect(await output(engine.run('nope'))).toMatchObject({
    exitCode: 127,
    stderr: 'nope: command not found\n'
  });
  expect(await output(engine.run('/missing'))).toMatchObject({
    exitCode: 127,
    stderr: '/missing: command not found\n'
  });
  expect(await output(engine.run('constructor'))).toMatchObject({ exitCode: 127 });
});
