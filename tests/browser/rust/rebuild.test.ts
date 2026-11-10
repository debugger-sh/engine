import { expect, test } from 'vitest';

import { createEngine } from '../helpers';

test('rebuilds pick up changes', async () => {
  const engine = await createEngine({ 'main.rs': 'fn main() { std::process::exit(1) }' });
  expect((await engine.run('rust')).exitCode).toBe(1);
  await engine.fs.writeFile('main.rs', 'fn main() { std::process::exit(2) }');
  expect((await engine.run('rust')).exitCode).toBe(2);
});
