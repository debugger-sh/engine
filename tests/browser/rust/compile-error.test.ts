import { expect, test } from 'vitest';

import { createEngine, output } from '../helpers';

test('compile errors exit non-zero', async () => {
  const engine = await createEngine({ 'main.rs': 'fn main() { nope }' });
  const result = await output(engine.run('rust'));
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain('error');
});
