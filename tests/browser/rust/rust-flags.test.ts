import { expect, test } from 'vitest';

import { createEngine } from '../helpers';

test('rustFlags are passed to rustc', async () => {
  const engine = await createEngine({
    'main.rs': '#[cfg(not(x))] fn main() { std::process::exit(1) } #[cfg(x)] fn main() {}'
  });
  expect((await engine.run('rust', { rustFlags: ['--cfg', 'x'] })).exitCode).toBe(0);
});
