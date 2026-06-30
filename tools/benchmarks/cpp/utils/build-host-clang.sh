#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/versions.env"

BUILD_DIR="${BENCH_HOST_BUILD_DIR:-$HERE/.build-host}"
CFG_DIR="$BUILD_DIR/llvm-build"
PREFIX="$BUILD_DIR/install"
JOBS="${BENCH_JOBS:-$(sysctl -n hw.ncpu 2>/dev/null || nproc)}"

# Reuse a previously fetched LLVM source tree if present; otherwise fetch our own.
SHARED_SRC="$HERE/.build/llvm-src"
SRC_DIR="$BUILD_DIR/llvm-src"
[ -e "$SHARED_SRC/llvm/CMakeLists.txt" ] && SRC_DIR="$SHARED_SRC"

for t in git cmake ninja; do command -v "$t" >/dev/null || { echo "missing: $t" >&2; exit 1; }; done
CCACHE_FLAG="OFF"; command -v ccache >/dev/null && CCACHE_FLAG="ON"

case "$(uname -m)" in
  arm64|aarch64) HOST_LLVM_TARGET=AArch64 ;;
  x86_64)        HOST_LLVM_TARGET=X86 ;;
  *) echo "unsupported host arch: $(uname -m)" >&2; exit 1 ;;
esac
HOST_TRIPLE="$(xcrun clang -dumpmachine 2>/dev/null || cc -dumpmachine 2>/dev/null || echo "$(uname -m)-apple-darwin")"

echo ">> build dir: $BUILD_DIR  (jobs=$JOBS, ccache=$CCACHE_FLAG)"
echo ">> host target: $HOST_LLVM_TARGET  triple: $HOST_TRIPLE"
mkdir -p "$BUILD_DIR"

if [ "$SRC_DIR" = "$BUILD_DIR/llvm-src" ] && [ ! -e "$SRC_DIR/llvm/CMakeLists.txt" ]; then
  rm -rf "$SRC_DIR"; mkdir -p "$SRC_DIR"
  git -C "$SRC_DIR" init -q
  git -C "$SRC_DIR" remote add origin "$LLVM_FORK_URL"
  if git -C "$SRC_DIR" fetch -q --depth 1 origin "$LLVM_COMMIT"; then
    git -C "$SRC_DIR" checkout -q --detach FETCH_HEAD
  else
    git -C "$SRC_DIR" fetch -q --depth 50 origin
    git -C "$SRC_DIR" checkout -q --detach "$LLVM_COMMIT"
  fi
fi
GOT="$(git -C "$SRC_DIR" rev-parse HEAD)"
[ "$GOT" = "$LLVM_COMMIT" ] || { echo "commit mismatch: got $GOT want $LLVM_COMMIT" >&2; exit 1; }
echo ">> source at $GOT ($SRC_DIR)"

# Same compiler-behavior flags as the engine's wasm compiler (MinSizeRel, assertions,
# threads off, projects, LTO). ONLY the target differs: host arch instead of WebAssembly.
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
  -DLLVM_TARGETS_TO_BUILD="$HOST_LLVM_TARGET" \
  -DLLVM_DEFAULT_TARGET_TRIPLE="$HOST_TRIPLE" \
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

cmake --build "$CFG_DIR" -j "$JOBS" \
  --target clang clang-resource-headers lld llvm-dwarfdump

mkdir -p "$PREFIX/bin"
for b in clang lld llvm-dwarfdump; do
  cp -f "$CFG_DIR/bin/$b" "$PREFIX/bin/$b" 2>/dev/null || true
done
ln -sf clang "$PREFIX/bin/clang++"
( cd "$PREFIX/bin" && for n in ld.lld lld-link; do ln -sf lld "$n"; done )

# Driver-mode compiles need clang's builtin headers (stdarg.h, etc.) next to the
# binary; the -cc1 wasm path doesn't, but the host path does.
res="$(ls -d "$CFG_DIR"/lib/clang/* 2>/dev/null | head -1)"
[ -n "$res" ] && { mkdir -p "$PREFIX/lib/clang"; cp -R "$res" "$PREFIX/lib/clang/$(basename "$res")"; }

echo ">> done. host toolchain at: $PREFIX/bin"
echo ">> now run: $HERE/run-benchmark.sh <program.cpp>"
