import { expect, test } from 'vitest';

import { createEngine } from '../helpers';

test('returns the exit code', async () => {
  const engine = await createEngine({ 'main.py': 'raise SystemExit(3)' });
  expect(await engine.run('python')).toEqual({ exitCode: 3, killed: false });
});
