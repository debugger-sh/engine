import { expect, test } from 'vitest';

import { sleep, withTool } from '../helpers';

test('killing processes mid-I/O never deadlocks the filesystem', async () => {
  const tool = await withTool();
  for (let i = 0; i < 20; i++) {
    const procs = Array.from({ length: 4 }, (_, j) =>
      tool.run('/bin/main', ['spam', `/spam${j}.txt`])
    );
    await sleep(20 + i * 5);
    procs.forEach((proc) => proc.kill());
    await tool.fs.writeFile('/after.txt', `${i}`);
  }
  expect(await tool.fs.readFile('/after.txt', 'utf8')).toBe('19');
  expect(await tool.run('/bin/main', ['exit', '9'])).toEqual({ exitCode: 9, killed: false });
});
