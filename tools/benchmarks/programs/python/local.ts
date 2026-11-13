// The engine's `python` toolchain (Python 3.11.3), natively.
import { $ } from 'bun';

import { download, PLATFORM } from '../../download.ts';

const RELEASE = 'https://github.com/astral-sh/python-build-standalone/releases/download/20230507';
const TARGET = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'win32-x64': 'x86_64-pc-windows-msvc-shared'
}[PLATFORM];
const python = (dir: string) => `${dir}/${process.platform === 'win32' ? 'python' : 'bin/python3'}`;

export async function setup(dir: string) {
  if (!TARGET) throw new Error(`no Python 3.11.3 release for ${PLATFORM}`);
  await download(dir, [`${RELEASE}/cpython-3.11.3+20230507-${TARGET}-install_only.tar.gz`]);
  return (await $`${python(dir)} --version`.text()).trim();
}

/** Runs main.py. */
export async function run(dir: string, program: string) {
  return $`${python(dir)} main.py`
    .cwd(program)
    .env({ ...process.env, PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1' })
    .text();
}
