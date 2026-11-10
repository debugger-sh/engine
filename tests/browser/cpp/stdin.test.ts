import { expect, test } from 'vitest';

import { createEngine, output } from '../helpers';

test('programs read stdin', async () => {
  const engine = await createEngine({
    'main.cpp':
      '#include <iostream>\nint main() { std::string s; std::cin >> s; std::cout << s.size(); }'
  });
  const proc = engine.run('cpp');
  await proc.stdin.write('CS198!\n');
  expect((await output(proc)).stdout).toBe('6');
});
