// The engine's `rust` toolchain (rustc and the standard library 1.96.0), natively.
import { $ } from 'bun';

import { download, PLATFORM } from '../../download.ts';

const TARGET = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'win32-x64': 'x86_64-pc-windows-msvc'
}[PLATFORM];

export async function setup(dir: string) {
  if (!TARGET) throw new Error(`no Rust 1.96.0 release for ${PLATFORM}`);
  const urls = ['rustc', 'rust-std'].map(
    (component) => `https://static.rust-lang.org/dist/${component}-1.96.0-${TARGET}.tar.xz`
  );
  await download(dir, urls, 2);
  return (await $`${dir}/bin/rustc --version`.text()).trim();
}

/** Compiles main.rs, links it with the standard library using lld and runs the executable. */
export async function run(dir: string, program: string, out: string) {
  const lld = `${dir}/lib/rustlib/${TARGET}/bin`;
  const link = {
    darwin: [`-Clink-arg=--ld-path=${lld}/gcc-ld/ld64.lld`],
    linux: ['-Clink-arg=-fuse-ld=lld', `-Clink-arg=-B${lld}/gcc-ld`],
    win32: ['-Clinker=rust-lld']
  }[process.platform as string];
  // The engine's rustc is a development build, which allows unstable (-Z) flags.
  await $`${dir}/bin/rustc main.rs -Cpanic=abort -Ccodegen-units=1 -Zthreads=1 ${link} -o ${out}/main.exe`
    .cwd(program)
    .env({ ...process.env, RUSTC_BOOTSTRAP: '1' });
  return $`${out}/main.exe`.text();
}
