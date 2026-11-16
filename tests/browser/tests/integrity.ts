import { toolchainProvenance } from 'debugger-sh';
import { expect, test, vi } from 'vitest';

import { eng } from '../helpers';

test('rejects changed sysroot and compiler bytes, then retries the same engine', async () => {
  const engine = await eng();
  const { artifacts } = toolchainProvenance.python;
  const fetch = globalThis.fetch;
  let corrupt = artifacts.sysroot;
  const requests: Array<{ url: string; cache: RequestCache | undefined }> = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    requests.push({ url, cache: init?.cache });
    if (url === corrupt) return new Response(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    return fetch(input, init);
  });
  try {
    await expect(engine.run('python', ['-c', 'print(42)'])).outputs({
      exitCode: 126,
      stderr: expect.stringContaining('toolchain checksum mismatch')
    });
    corrupt = artifacts.python;
    await expect(engine.run('python', ['-c', 'print(42)'])).outputs({
      exitCode: 126,
      stderr: expect.stringContaining('toolchain checksum mismatch')
    });
    corrupt = '';
    await expect(engine.run('python', ['-c', 'print(42)'])).outputs({ stdout: '42\n' });
    expect(requests).toContainEqual({ url: artifacts.sysroot, cache: 'reload' });
    expect(requests).toContainEqual({ url: artifacts.python, cache: 'reload' });
  } finally {
    spy.mockRestore();
  }
});
