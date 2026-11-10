import { expect, test } from 'vitest';

import { output, withTool } from '../helpers';

test('sysroot network errors exit with 127', async () => {
  const tool = await withTool();
  const result = await output(
    tool.run('/bin/main', { sysroot: `${location.origin}/missing.tar.gz` })
  );
  expect(result).toMatchObject({ exitCode: 127, stderr: '/bin/main: network error (404)\n' });
});
