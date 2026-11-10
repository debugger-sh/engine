import { expect, test } from 'vitest';

import { createEngine, output } from '../helpers';

test('compile errors exit non-zero, reported on stderr', async () => {
  const engine = await createEngine({ 'main.cpp': 'int main() { return x; }' });
  const result = await output(engine.run('cpp'));
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain('error');
});
