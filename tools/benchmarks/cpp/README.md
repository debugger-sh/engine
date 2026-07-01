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
identical to the engine's wasm compiler.

**Matched (must stay identical for fairness):**

- `CMAKE_BUILD_TYPE=MinSizeRel`
- `LLVM_ENABLE_ASSERTIONS=ON`
- `LLVM_ENABLE_THREADS=OFF`
- `LLVM_ENABLE_PROJECTS="clang;lld"`
- **Full LTO** — matches YoWASP's `-flto` exactly

**Differs:** `LLVM_TARGETS_TO_BUILD` / `LLVM_DEFAULT_TARGET_TRIPLE` are set to the host
arch (e.g. `AArch64` / `arm64-apple-darwin`) so the toolchain emits native binaries.

## Build the native toolchain

```sh
./utils/build-host-clang.sh                    # clone @ pinned commit, build host toolchain
```

`build-host-clang.sh` fetches the pinned LLVM source itself (reusing `.build/llvm-src`
if present) and lands the toolchain in `utils/.build-host/install/bin`.

## Compare engine vs native

`compare.ts` times the same program both ways and prints the ratio: the native baseline
(via `run-benchmark.sh`) and the engine's isolated execution (`Engine.run({ profile: true })`,
reading `timing.runMs`). Build the engine library first (`npm run build` at the repo root).

```sh
npm run compare -- benchmarks/loop.cpp
```

```
== loop.cpp  (-O0, 5 iters) ==
  native  min   185.669 ms   avg   185.823 ms
  engine  min   163.171 ms   avg   163.567 ms   (runMs, isolated execution)
  ratio engine/native:  min 0.88x   avg 0.88x
```

Defaults to `-O0` because **the engine compiles user code at `-O0`** (`src/worker/mod.rs`);
that keeps it apples-to-apples. The engine spawns a fresh worker per run (re-fetching the
toolchain), so wall-clock is slow, but `runMs` measures only the program execution step.

You can also time the native side alone:

```sh
./utils/run-benchmark.sh benchmarks/loop.cpp   # compile + time the native binary
```

Env: `BENCH_ITERS=5`, `BENCH_OPT=O0`, `BENCH_STD=c++23`. `BENCH_JOBS` /
`BENCH_HOST_BUILD_DIR` tune the build.

## Files

- `versions.env` — LLVM source/commit pins (source of truth).
- `utils/build-host-clang.sh` — reproducible host-targeting native build.
- `utils/run-benchmark.sh` — compile a program with the host clang, time it, report min/avg.
- `compare.ts` — run a program through both the native binary and the engine, report the ratio.
- `benchmarks/` — sample programs.
- `reference/` — YoWASP's `build.sh` and version helper, vendored verbatim.
