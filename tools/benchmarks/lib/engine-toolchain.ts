/** Matches `src/python/worker/mod.rs` (`WASM_URL` / `STDLIB_URL`). */
export const PYTHON_VERSION = '3.11.3';

/** Matches `https://debugger-sh.github.io/engine/rustc.wasm` (rustc 1.96.0). */
export const RUSTC_VERSION = '1.96.0';

/** Matches `languages/cpp/index.ts` / engine C++ LLVM toolchain. */
export const LLVM_VERSION = '22.1.0';

/** python-build-standalone release that ships CPython 3.11.3. */
export const PYTHON_BUILD_STANDALONE_TAG = '20230507';

export const ENGINE_URLS = {
  pythonWasm: `https://runno.dev/langs/python-${PYTHON_VERSION}.wasm`,
  pythonStdlib: `https://runno.dev/langs/python-${PYTHON_VERSION}.tar.gz`,
  rustcWasm: 'https://debugger-sh.github.io/engine/rustc.wasm',
  rustSysroot: 'https://debugger-sh.github.io/engine/rust-sysroot.tar.gz'
} as const;
