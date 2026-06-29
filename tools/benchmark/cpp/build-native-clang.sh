#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/versions.env"

# Build artifacts are large (~20GB). Override BENCH_BUILD_DIR to point at a volume
# with space (e.g. an external SSD). Default lives outside the repo tree by design.
BUILD_DIR="${BENCH_BUILD_DIR:-$HERE/.build}"
SRC_DIR="$BUILD_DIR/llvm-src"
CFG_DIR="$BUILD_DIR/llvm-build"
PREFIX="$BUILD_DIR/install"
JOBS="${BENCH_JOBS:-$(sysctl -n hw.ncpu 2>/dev/null || nproc)}"

for t in git cmake ninja; do command -v "$t" >/dev/null || { echo "missing: $t" >&2; exit 1; }; done
CCACHE_FLAG="OFF"; command -v ccache >/dev/null && CCACHE_FLAG="ON"

echo ">> build dir: $BUILD_DIR  (jobs=$JOBS, ccache=$CCACHE_FLAG)"
mkdir -p "$BUILD_DIR"

# --- Fetch the exact source commit (history-free; ~tree of one commit only) -----
if [ ! -e "$SRC_DIR/llvm/CMakeLists.txt" ]; then
  rm -rf "$SRC_DIR"; mkdir -p "$SRC_DIR"
  git -C "$SRC_DIR" init -q
  git -C "$SRC_DIR" remote add origin "$LLVM_FORK_URL"
  # Prefer fetching the bare commit; fall back to a shallow branch fetch if the
  # server disallows fetch-by-sha, then check the commit out explicitly.
  if git -C "$SRC_DIR" fetch -q --depth 1 origin "$LLVM_COMMIT"; then
    git -C "$SRC_DIR" checkout -q --detach FETCH_HEAD
  else
    git -C "$SRC_DIR" fetch -q --depth 50 origin
    git -C "$SRC_DIR" checkout -q --detach "$LLVM_COMMIT"
  fi
fi
GOT="$(git -C "$SRC_DIR" rev-parse HEAD)"
[ "$GOT" = "$LLVM_COMMIT" ] || { echo "commit mismatch: got $GOT want $LLVM_COMMIT" >&2; exit 1; }
echo ">> source at $GOT"

# --- Configure -----------------------------------------------------------------
# MATCHED to YoWASP (reference/yowasp-build.sh, the `llvm-build` step) because
# these change how the compiler behaves or how fast it runs:
#   MinSizeRel, ENABLE_ASSERTIONS=ON, ENABLE_THREADS=OFF (the wasm build is
#   single-threaded — matching this keeps the comparison fair), TARGETS=WebAssembly,
#   DEFAULT_TARGET_TRIPLE=wasm32-wasip1, PROJECTS="clang;lld".
# DROPPED (wasm cross-compile plumbing only, no native analog): the wasi-sdk
#   toolchain file, _WASI_EMULATED_MMAN, --max-memory / stack-size / --strip-all,
#   LLVM_NATIVE_TOOL_DIR + the separate tblgen cross-build (native builds tblgen
#   in-tree), LLVM_BUILD_STATIC / ENABLE_PIC=OFF.
# LTO: YoWASP links the wasm build with -flto (full). LTO isn't just deployment
#   pruning — it makes clang's own code faster, so the native baseline must be
#   LTO'd too, or we'd under-optimize native and bias the comparison toward the
#   engine. Default ThinLTO (feasible here, ~same perf as full). BENCH_LTO=full
#   matches YoWASP exactly but full-LTO linking clang can exceed 32GB RAM and OOM.
#   BENCH_LTO=off disables it (NOT recommended — handicaps the baseline).
case "${BENCH_LTO:-thin}" in
  thin) LTO_ARGS=(-DLLVM_ENABLE_LTO=Thin) ;;
  full) LTO_ARGS=(-DLLVM_ENABLE_LTO=Full) ;;
  off)  LTO_ARGS=() ;;
  *) echo "BENCH_LTO must be one of: thin|full|off" >&2; exit 1 ;;
esac

cmake -G Ninja -B "$CFG_DIR" -S "$SRC_DIR/llvm" \
  -DCMAKE_BUILD_TYPE=MinSizeRel \
  -DLLVM_ENABLE_ASSERTIONS=ON \
  -DLLVM_ENABLE_THREADS=OFF \
  -DLLVM_TARGETS_TO_BUILD=WebAssembly \
  -DLLVM_DEFAULT_TARGET_TRIPLE="$TARGET_TRIPLE" \
  -DLLVM_ENABLE_PROJECTS="clang;lld" \
  -DLLVM_CCACHE_BUILD="$CCACHE_FLAG" \
  -DLLVM_INCLUDE_TESTS=OFF \
  -DLLVM_INCLUDE_EXAMPLES=OFF \
  -DLLVM_INCLUDE_BENCHMARKS=OFF \
  -DLLVM_INCLUDE_DOCS=OFF \
  -DCLANG_INCLUDE_TESTS=OFF \
  -DCLANG_INCLUDE_DOCS=OFF \
  -DCLANG_LINKS_TO_CREATE="clang;clang++" \
  -DCMAKE_INSTALL_PREFIX="$PREFIX" \
  "${LTO_ARGS[@]}"

# --- Build only what we need: clang, clang++, lld, and llvm-dwarfdump -----------
cmake --build "$CFG_DIR" -j "$JOBS" \
  --target clang clang-resource-headers lld llvm-dwarfdump

mkdir -p "$PREFIX/bin"
for b in clang lld llvm-dwarfdump; do
  cp -f "$CFG_DIR/bin/$b" "$PREFIX/bin/$b" 2>/dev/null || true
done
ln -sf clang "$PREFIX/bin/clang++"
( cd "$PREFIX/bin" && for n in wasm-ld ld.lld lld-link; do ln -sf lld "$n"; done )

echo ">> done. native toolchain at: $PREFIX/bin"
echo ">> now run: $HERE/verify-toolchain.sh"
