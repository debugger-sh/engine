# tools/benchmark/cpp

Contains everything needed for a reproducible toolchain for benchmarking the in-browser engine against a native baseline, for **C/C++ programs**. This directory currently sets up the **native compiler baseline**: a
clang/lld built from the _exact same source and compiler-behavior flags_ as the
WebAssembly compiler the engine runs (`src/worker/mod.rs`), but compiled to run on any native host.

## Pinned identity

All pins live in [`versions.env`](./versions.env) and are re-derivable with
`verify-toolchain.sh`:

| What              | Value                                                       |
| ----------------- | ----------------------------------------------------------- |
| Compiler          | clang **22.1.0** + LLD 22.1.0                               |
| Source            | YoWASP fork `codeberg.org/YoWASP/llvm-project`              |
| Commit            | `9560ae0f2cc440e4fc891fddbc119da6f56daa59`                  |
| In-browser binary | `…/llvm.core.wasm`, sha256 `24fbed47…3e7bf5` (75,532,134 B) |
| Build config      | `+assertions`, target `wasm32-wasip1`                       |

The commit is confirmed two independent ways: it's baked into the hosted binary's
`--version` string which you can verify using `wasmtime run ./llvm.core.wasm --version`, and it's the `llvm-src` submodule pin in `YoWASP/clang`. YoWASP's own recipe is vendored verbatim in [`reference/`](./reference/).

## Flag mapping: YoWASP wasm build → native build

From `reference/yowasp-build.sh` (the `llvm-build` step). `build-native-clang.sh` keeps every flag that affects compiler behavior or speed, and drops only the wasm cross-compilation plumbing.

**Matched (must stay identical for fairness):**

- `CMAKE_BUILD_TYPE=MinSizeRel`
- `LLVM_ENABLE_ASSERTIONS=ON`
- `LLVM_ENABLE_THREADS=OFF` — the wasm build is single-threaded; matching this
  prevents the native compiler from getting an unfair parallelism advantage.
- `LLVM_TARGETS_TO_BUILD=WebAssembly`
- `LLVM_DEFAULT_TARGET_TRIPLE=wasm32-wasip1` — native clang compiles to the _same_
  target the engine does, so compile-time is apples-to-apples.
- `LLVM_ENABLE_PROJECTS="clang;lld"`
- **LTO** — YoWASP links the wasm build with `-flto`. This isn't only deployment
  pruning; LTO makes clang's own code faster (~5–15%). If native were built
  _without_ LTO it would be under-optimized vs the in-browser clang, making native
  look slow and biasing the comparison toward the engine. So LTO is **on by
  default** (`BENCH_LTO=thin`). See the full-vs-thin note below.

**Dropped (wasm-only, no native analog):** the wasi-sdk toolchain file,
`-D_WASI_EMULATED_MMAN`, `--max-memory` / `-z stack-size` / `--strip-all`,
`LLVM_NATIVE_TOOL_DIR` + the separate tblgen cross-build (native builds tblgen
in-tree), `LLVM_BUILD_STATIC` / `LLVM_ENABLE_PIC=OFF`.

## Usage

```sh
export BENCH_BUILD_DIR=/Volumes/ext/llvm-native      # any dir with ~30GB

./build-native-clang.sh            # clone @ pinned commit, configure, build
./verify-toolchain.sh              # confirm native build == in-browser binary

# Re-verify the hosted binary itself hasn't drifted (~75MB download):
BENCH_VERIFY_REMOTE=1 ./verify-toolchain.sh
```

The native toolchain lands in `$BENCH_BUILD_DIR/install/bin` (`clang`, `clang++`,
`lld`/`wasm-ld`, `llvm-dwarfdump`).

### Compiling apples-to-apples

To compile a program with the native clang the way the engine does, use the same
sysroot the engine fetches and the same `-cc1` flags from `src/worker/mod.rs`:

```sh
curl -sL "$(grep SYSROOT_URL versions.env | cut -d'"' -f2)" | tar xz -C /tmp/sysroot
export BENCH_SYSROOT=/tmp/sysroot      # verify-toolchain.sh smoke-tests with this

"$BENCH_BUILD_DIR/install/bin/clang" -cc1 -triple wasm32-wasip1 -emit-obj \
  -isysroot "$BENCH_SYSROOT" \
  -internal-isystem "$BENCH_SYSROOT/include/c++/v1" \
  -internal-isystem "$BENCH_SYSROOT/include" \
  -internal-isystem "$BENCH_SYSROOT/include/wasm32-wasip1" \
  -x c++ -std=c++23 -O0 -o out.o in.cpp
```

## Files

- `versions.env` — all pins (source of truth).
- `build-native-clang.sh` — reproducible native build.
- `verify-toolchain.sh` — checks native build matches the in-browser binary.
- `reference/` — YoWASP's `build.sh` and version helper, vendored verbatim.
