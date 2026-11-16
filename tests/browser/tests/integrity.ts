import { toolchainProvenance } from 'debugger-sh';
import { expect, test, vi } from 'vitest';

import { eng } from '../helpers';

test('rejects changed sysroot and compiler bytes, then retries the same engine', async () => {
  const engine = await eng();
  const { artifacts } = toolchainProvenance.python;
  const fetch = globalThis.fetch;
  let corrupt = artifacts.sysroot;
  let network = true;
  const requests: Array<{ url: string; cache: RequestCache | undefined }> = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    requests.push({ url, cache: init?.cache });
    if (url === corrupt)
      return network
        ? new Response('', { status: 503 })
        : new Response(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    return fetch(input, init);
  });
  try {
    await expect(engine.run('python', ['-c', 'print(42)'])).outputs({
      exitCode: 127,
      error: {
        type: 'load',
        reason: 'network',
        url: artifacts.sysroot,
        message: 'network error (503)'
      }
    });
    network = false;
    await expect(engine.run('python', ['-c', 'print(42)'])).outputs({
      exitCode: 126,
      error: expect.objectContaining({ type: 'load', reason: 'integrity', url: artifacts.sysroot }),
      stderr: expect.stringContaining('toolchain checksum mismatch')
    });
    corrupt = artifacts.python;
    network = true;
    await expect(engine.run('python', ['-c', 'print(42)'])).outputs({
      exitCode: 127,
      error: {
        type: 'load',
        reason: 'network',
        url: artifacts.python,
        message: 'network error (503)'
      }
    });
    network = false;
    await expect(engine.run('python', ['-c', 'print(42)'])).outputs({
      exitCode: 126,
      error: expect.objectContaining({ type: 'load', reason: 'integrity', url: artifacts.python }),
      stderr: expect.stringContaining('toolchain checksum mismatch')
    });
    corrupt = '';
    await expect(engine.run('python', ['-c', 'print(42)'])).outputs({ stdout: '42\n' });
    expect(await engine.run('python', ['-c', 'raise SystemExit(127)'])).toEqual({
      exitCode: 127,
      killed: false
    });
    expect(await engine.run('python', ['-c', 'raise SystemExit(126)'])).toEqual({
      exitCode: 126,
      killed: false
    });
    expect(requests).toContainEqual({ url: artifacts.sysroot, cache: 'reload' });
    expect(requests).toContainEqual({ url: artifacts.python, cache: 'reload' });
  } finally {
    spy.mockRestore();
  }
});

test('C++ reports its early sysroot load failure as a host error', async () => {
  const engine = await eng({ 'main.cpp': 'int main() { return 0; }' });
  const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 503 }));
  try {
    await expect(engine.run('cpp')).outputs({
      exitCode: 127,
      error: {
        type: 'load',
        reason: 'network',
        url: toolchainProvenance.cpp.artifacts.sysroot,
        message: 'network error (503)'
      },
      stderr: expect.stringContaining('network error (503)')
    });
  } finally {
    spy.mockRestore();
  }
});
