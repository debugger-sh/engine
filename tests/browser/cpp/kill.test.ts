import { expect, test } from 'vitest';

import { createEngine, HELLO, sleep } from '../helpers';

test('kill stops the build', async () => {
  const engine = await createEngine({ 'main.cpp': HELLO });
  const proc = engine.run('cpp');
  await sleep(100);
  proc.kill();
  expect(await proc).toEqual({ exitCode: 137, killed: true });
});
