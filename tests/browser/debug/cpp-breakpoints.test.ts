import { expect, test } from 'vitest';

import { createEngine, dap, output } from '../helpers';

const CPP = '#include <cstdio>\nint main() {\n  int x = 41;\n  x++;\n  printf("%d\\n", x);\n}';

test('debugging C++ stops at breakpoints and inspects variables', async () => {
  const engine = await createEngine({ 'main.cpp': CPP });
  const proc = engine.run('cpp', { debug: true });
  const result = output(proc);
  const client = dap(proc.debugger);
  await client.start('/main.cpp', [4]);

  expect((await client.event('stopped')).body).toMatchObject({ reason: 'breakpoint' });
  const [frame] = client.request('stackTrace', { threadId: 1 }).body.stackFrames;
  expect(frame).toMatchObject({ name: 'main', line: 4 });
  const [locals] = client.request('scopes', { frameId: frame.id }).body.scopes;
  const { variables } = client.request('variables', {
    variablesReference: locals.variablesReference
  }).body;
  expect(variables).toContainEqual(expect.objectContaining({ name: 'x', value: '41' }));

  client.request('continue', { threadId: 1 });
  await client.event('terminated');
  expect(await result).toMatchObject({ exitCode: 0, stdout: '42\n' });
});
