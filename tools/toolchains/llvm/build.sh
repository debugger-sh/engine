#!/usr/bin/env bash
# Builds LLVM (clang and lld) for wasm32-wasip1 inside the Docker image, from the LLVM revision in
# provenance.json with changes.patch applied:
#
#  * /out/llvm.wasm: clang and lld as one multicall binary, dispatched on argv[0]
#    (`clang`, `clang++` or `wasm-ld`).
#  * /out/sysroot.tar.zst: clang's headers, compiler-rt, wasi-libc and libc++.
#
# /work persists between runs (sources and build trees), so rebuilds are incremental.
set -euo pipefail
source /toolchain/common.sh

SYSROOT=/work/sysroot
fetch llvm "$(upstream repository)" "$(upstream revision)" /toolchain/changes.patch

# Clang and LLD, as one multicall binary. That picks up every LLVM tool that is configured, so all
# the others are left out, as is every part of LLD but its WebAssembly linker.
tools=()
for tool in llvm/llvm/tools/*/; do
  name=$(basename "$tool" | tr a-z- A-Z_)
  [[ $name == LLVM_DRIVER ]] || tools+=("-DLLVM_TOOL_${name}_BUILD=OFF")
done
configure_llvm llvm "clang;lld" "${tools[@]}" \
  -DLLVM_TOOL_LLVM_DRIVER_BUILD=ON \
  -DCLANG_TOOL_CLANG_SCAN_DEPS_BUILD=OFF \
  -DCLANG_TOOL_CLANG_INSTALLAPI_BUILD=OFF \
  -DCLANG_ENABLE_STATIC_ANALYZER=OFF \
  -DCLANG_INCLUDE_DOCS=OFF \
  -DLLD_BUILD_TOOLS=OFF \
  -DLLD_WASM_ONLY=ON
ninja -C build/llvm llvm-driver clang-resource-headers

# The sysroot, following wasi-sdk's recipe (https://github.com/WebAssembly/wasi-sdk), without
# exceptions or shared libraries.
rm -rf "$SYSROOT"
wasi_libc "$SYSROOT"

configure compiler-rt llvm/compiler-rt -DCMAKE_SYSROOT="$SYSROOT" -DCMAKE_INSTALL_PREFIX="$SYSROOT" \
  -DCMAKE_C_FLAGS="$CFLAGS" -DCMAKE_ASM_FLAGS="$CFLAGS" \
  -DLLVM_ENABLE_PER_TARGET_RUNTIME_DIR=ON \
  -DCOMPILER_RT_BAREMETAL_BUILD=ON \
  -DCOMPILER_RT_DEFAULT_TARGET_ONLY=ON \
  -DCOMPILER_RT_HAS_FPIC_FLAG=OFF \
  -DCOMPILER_RT_INCLUDE_TESTS=OFF \
  -DCOMPILER_RT_BUILD_SANITIZERS=OFF \
  -DCOMPILER_RT_BUILD_XRAY=OFF \
  -DCOMPILER_RT_BUILD_LIBFUZZER=OFF \
  -DCOMPILER_RT_BUILD_PROFILE=OFF \
  -DCOMPILER_RT_BUILD_CTX_PROFILE=OFF \
  -DCOMPILER_RT_BUILD_MEMPROF=OFF \
  -DCOMPILER_RT_BUILD_ORC=OFF \
  -DCOMPILER_RT_BUILD_GWP_ASAN=OFF
ninja -C build/compiler-rt install

configure libcxx llvm/runtimes -DCMAKE_SYSROOT="$SYSROOT" -DCMAKE_INSTALL_PREFIX="$SYSROOT" \
  -DCMAKE_C_FLAGS="$CFLAGS" -DCMAKE_CXX_FLAGS="$CFLAGS" \
  -DLLVM_ENABLE_RUNTIMES="libcxx;libcxxabi" \
  -DLLVM_COMPILER_CHECKED=ON \
  -DUNIX=ON \
  -DLIBCXX_ENABLE_SHARED=OFF \
  -DLIBCXX_ENABLE_EXCEPTIONS=OFF \
  -DLIBCXX_ENABLE_THREADS=ON \
  -DLIBCXX_HAS_PTHREAD_API=ON \
  -DLIBCXX_ENABLE_ABI_LINKER_SCRIPT=OFF \
  -DLIBCXX_CXX_ABI=libcxxabi \
  -DLIBCXX_ABI_VERSION=2 \
  -DLIBCXX_LIBDIR_SUFFIX=/$TARGET \
  -DLIBCXX_INCLUDE_TESTS=OFF \
  -DLIBCXX_INCLUDE_BENCHMARKS=OFF \
  -DLIBCXXABI_ENABLE_SHARED=OFF \
  -DLIBCXXABI_ENABLE_EXCEPTIONS=OFF \
  -DLIBCXXABI_ENABLE_THREADS=ON \
  -DLIBCXXABI_HAS_PTHREAD_API=ON \
  -DLIBCXXABI_SILENT_TERMINATE=ON \
  -DLIBCXXABI_USE_LLVM_UNWINDER=OFF \
  -DLIBCXXABI_LIBDIR_SUFFIX=/$TARGET
ninja -C build/libcxx install-cxx install-cxxabi

cp -r build/llvm/lib/clang/*/include/. "$SYSROOT/include/"
optimize build/llvm/bin/llvm /out/llvm.wasm
pack "$SYSROOT" /out/sysroot.tar.zst
ls -lh /out
