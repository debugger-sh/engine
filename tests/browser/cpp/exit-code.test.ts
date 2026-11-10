import { expect, test } from 'vitest';

import { createEngine } from '../helpers';

test('returns the program’s exit code', async () => {
  const engine = await createEngine({ 'main.cpp': 'int main() { return 42; }' });
  expect(await engine.run('cpp')).toEqual({ exitCode: 42, killed: false });
});
