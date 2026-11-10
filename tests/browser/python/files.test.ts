import { expect, test } from 'vitest';

import { createEngine } from '../helpers';

test('reads and writes the shared filesystem', async () => {
  const engine = await createEngine({
    'main.py': 'open("/out.txt", "w").write(open("/in.txt").read().upper())',
    'in.txt': 'hi'
  });
  await engine.run('python');
  expect(await engine.fs.readFile('/out.txt', 'utf8')).toBe('HI');
});
