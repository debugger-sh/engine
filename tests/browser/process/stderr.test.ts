import { expect, test } from 'vitest';

import { output, withTool } from '../helpers';

test('captures stderr', async () => {
  const tool = await withTool();
  expect(await output(tool.run('/bin/main', ['stderr']))).toMatchObject({
    stdout: '',
    stderr: 'oops\n'
  });
});
