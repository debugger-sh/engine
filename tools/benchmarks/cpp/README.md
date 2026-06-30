# tools/benchmark/cpp

A reproducible **native aarch64 baseline** for **C/C++ programs**, to compare against
the engine's own execution timings. `build-host-clang.sh` builds clang/lld from the
_exact same pinned LLVM source and compiler-behavior flags_ as the WebAssembly compiler
the engine runs (`src/worker/mod.rs`), retargeted to the host arch so it emits native
binaries.

## Pinned identity

All pins live in [`versions.env`](./versions.env):

| What     | Value                                          |
| -------- | ---------------------------------------------- |
| Compiler | clang **22.1.0** + LLD 22.1.0                  |
| Source   | YoWASP fork `codeberg.org/YoWASP/llvm-project` |
| Commit   | `9560ae0f2cc440e4fc891fddbc119da6f56daa59`     |

YoWASP's own recipe is vendored verbatim in [`reference/`](./reference/).

## Same compiler, host target

`build-host-clang.sh` keeps every flag that affects compiler behavior or speed
identical to the engine's wasm compiler — only the target arch differs:

**Matched (must stay identical for fairness):**

- `CMAKE_BUILD_TYPE=MinSizeRel`
- `LLVM_ENABLE_ASSERTIONS=ON`
- `LLVM_ENABLE_THREADS=OFF`
- `LLVM_ENABLE_PROJECTS="clang;lld"`
- **LTO** — on by default (`BENCH_LTO=thin`). LTO makes clang's own code faster, so
  matching it keeps codegen quality consistent with the engine's compiler. `BENCH_LTO=full`
  matches YoWASP exactly but full-LTO linking clang can exceed 32GB RAM and OOM;
  `BENCH_LTO=off` disables it (not recommended).

**Differs:** `LLVM_TARGETS_TO_BUILD` / `LLVM_DEFAULT_TARGET_TRIPLE` are set to the host
arch (e.g. `AArch64` / `arm64-apple-darwin`) so the toolchain emits native binaries.

## Usage

```sh
BENCH_LTO=full ./build-host-clang.sh           # clone @ pinned commit, build host toolchain
./run-benchmark.sh benchmarks/xorshift.cpp     # compile + time the native binary
```

`build-host-clang.sh` fetches the pinned LLVM source itself (reusing `.build/llvm-src`
if present) and lands the toolchain in `.build-host/install/bin`.

`run-benchmark.sh` compiles the program with the host clang and reports min/avg
wall-clock over `BENCH_ITERS` runs (1 warmup). Of the matched build flags, only the
**LLVM version + `-O` level** affect generated code; `MinSizeRel`/assertions/threads/LTO
only change how clang itself runs, so they're kept identical for faithfulness but don't
influence the result.

Env: `BENCH_ITERS=5`, `BENCH_OPT=O2`, `BENCH_STD=c++23`, `BENCH_HOST_BIN`.

## Files

- `versions.env` — all pins (source of truth).
- `build-host-clang.sh` — reproducible host-targeting native build.
- `run-benchmark.sh` — compile a program with the host clang, time it, report min/avg.
- `benchmarks/` — sample programs for `run-benchmark.sh`.
- `reference/` — YoWASP's `build.sh` and version helper, vendored verbatim.
