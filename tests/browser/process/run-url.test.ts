import { expect, test } from 'vitest';

import { createEngine, output } from '../helpers';

test('runs an executable from a URL', async () => {
  const engine = await createEngine();
  const python = 'https://runno.dev/langs/python-3.11.3.wasm';
  const result = await output(engine.run(python, ['-c', 'print(6 * 7)'], { sysroot: 'python' }));
  expect(result).toMatchObject({ exitCode: 0, stdout: '42\n' });
});
