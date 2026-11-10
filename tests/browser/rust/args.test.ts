import { expect, test } from 'vitest';

import { createEngine, output } from '../helpers';

test('forwards args and returns the exit code', async () => {
  const engine = await createEngine({
    'main.rs': 'fn main() { print!("{}", std::env::args().nth(1).unwrap()); std::process::exit(5) }'
  });
  expect(await output(engine.run('rust', ['arg']))).toMatchObject({ exitCode: 5, stdout: 'arg' });
});
