import { expect, test } from 'vitest';

import { createEngine, output } from '../helpers';

test('invalid binaries and directories exit with 126', async () => {
  const engine = await createEngine({ 'text.wasm': 'not wasm', dir: { files: {} } });
  expect(await output(engine.run('/text.wasm'))).toMatchObject({
    exitCode: 126,
    stderr: '/text.wasm: cannot execute\n'
  });
  expect(await output(engine.run('/dir'))).toMatchObject({
    exitCode: 126,
    stderr: '/dir: cannot execute\n'
  });
  expect((await engine.run(import.meta.url)).exitCode).toBe(126); // this (JavaScript) file
});
