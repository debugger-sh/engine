import { expect, test } from 'vitest';

import { createEngine, output } from '../helpers';

test('compiles, links and runs', async () => {
  const engine = await createEngine({ 'main.rs': 'fn main() { println!("hello"); }' });
  expect(await output(engine.run('rust'))).toMatchObject({ exitCode: 0, stdout: 'hello\n' });
});
