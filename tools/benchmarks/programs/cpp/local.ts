// The engine's `cpp` toolchain (clang and lld 22.1.0), natively.
import { $ } from 'bun';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { download, PLATFORM } from '../../download.ts';

const RELEASE = 'https://github.com/llvm/llvm-project/releases/download/llvmorg-22.1.0';
const ASSET = {
  'darwin-arm64': 'LLVM-22.1.0-macOS-ARM64',
  'linux-arm64': 'LLVM-22.1.0-Linux-ARM64',
  'linux-x64': 'LLVM-22.1.0-Linux-X64',
  'win32-x64': 'clang+llvm-22.1.0-x86_64-pc-windows-msvc'
}[PLATFORM];
/** Only clang, lld and clang's headers (Windows has copies, not symlinks, of each executable). */
const MEMBERS =
  process.platform === 'win32'
    ? ['*/bin/clang.exe', '*/bin/clang++.exe', '*/bin/lld-link.exe', '*/lib/clang']
    : [
        '*/bin/clang',
        '*/bin/clang++',
        '*/bin/clang-22',
        '*/bin/lld',
        '*/bin/ld*.lld',
        '*/lib/clang'
      ];

export async function setup(dir: string) {
  if (!ASSET) throw new Error(`no clang 22.1.0 release for ${PLATFORM}`);
  await download(dir, [`${RELEASE}/${ASSET}.tar.xz`], 1, MEMBERS);
  // Unlike Apple's, upstream clang needs to be told where the macOS SDK is.
  if (process.platform === 'darwin')
    await Bun.write(`${dir}/bin/clang++.cfg`, `-isysroot ${await $`xcrun --show-sdk-path`.text()}`);
  return (await $`${dir}/bin/clang --version`.text()).split('\n')[0];
}

/** Compiles each source to an object (in parallel), links them with lld and runs the executable. */
export async function run(dir: string, program: string, out: string) {
  const sources = (await readdir(program, { recursive: true })).filter((file) =>
    /\.(c|cc|cp|cpp|cxx|c\+\+)$/.test(file)
  );
  const objects = sources.map((_, i) => path.join(out, `${i}.o`));
  await Promise.all(
    sources.map((src, i) =>
      $`${dir}/bin/clang++ -x c++ -std=c++23 -O0 -g -gdwarf-5 -fstandalone-debug -c ${src} -o ${objects[i]}`.cwd(
        program
      )
    )
  );
  await $`${dir}/bin/clang++ -fuse-ld=lld ${objects} -o ${out}/main.exe`;
  return $`${out}/main.exe`.text();
}
