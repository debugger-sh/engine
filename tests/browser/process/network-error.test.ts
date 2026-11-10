import { expect, test } from 'vitest';

import { createEngine, output } from '../helpers';

test('network errors exit with 127', async () => {
  const engine = await createEngine();
  const missing = `${location.origin}/missing.wasm`;
  const result = await output(engine.run(missing));
  expect(result).toMatchObject({ exitCode: 127, stderr: `${missing}: network error (404)\n` });
});
