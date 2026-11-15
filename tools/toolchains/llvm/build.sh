#!/usr/bin/env bash
# Builds LLVM (clang and lld) for wasm32-wasip1 inside the Docker image, from the LLVM revision in
# provenance.json with changes.patch applied:
#
#  * /out/llvm.wasm: clang and lld as one multicall binary, dispatched on argv[0]
#    (`clang`, `clang++` or `wasm-ld`).
#  * /out/sysroot.tar.gz: clang's headers, compiler-rt, wasi-libc and libc++.
#
# /work persists between runs (sources and build trees), so rebuilds are incremental.
set -euo pipefail

TARGET=wasm32-wasip1
CFLAGS="-mcpu=lime1"
TOOLCHAIN=/opt/wasi-sdk/share/cmake/wasi-sdk-p1.cmake
SYSROOT=/work/sysroot
cd /work

# A revision (or tag) of a repository, fetched shallowly and checked out in place, with an
# optional patch committed on top. Only files whose contents change are rewritten, which keeps
# the build incremental (the LLVM patch touches headers that almost every file includes).
fetch() {
  git init -q "$1"
  git -C "$1" fetch -q --depth 1 "$2" "$3"
  local commit=FETCH_HEAD index=$PWD/$1/.git/patched
  if [[ -n ${4:-} ]]; then
    # The patch is applied in a separate index, so the checkout below can skip unchanged files.
    # The commit is dated, so its hash (which LLVM embeds in its version) is reproducible.
    GIT_INDEX_FILE=$index git -C "$1" read-tree FETCH_HEAD
    GIT_INDEX_FILE=$index git -C "$1" apply --cached "$4"
    commit=$(GIT_AUTHOR_DATE='@0 +0000' GIT_COMMITTER_DATE='@0 +0000' \
      git -C "$1" -c user.name=toolchain -c user.email=toolchain@localhost commit-tree \
      "$(GIT_INDEX_FILE=$index git -C "$1" write-tree)" -p FETCH_HEAD -m "$4")
  fi
  git -C "$1" update-index -q --refresh || true
  git -C "$1" checkout -q --force "$commit"
  git -C "$1" clean -fdq
}

read -r repository revision < <(python3 -c "import json; p = json.load(open('/toolchain/provenance.json'))['upstream']; print(p['repository'], p['revision'])")
fetch llvm "$repository" "$revision" /toolchain/changes.patch
fetch wasi-libc https://github.com/WebAssembly/wasi-libc wasi-sdk-34

# Configures a cross build for wasm32-wasip1 with wasi-sdk. The compiler checks are skipped,
# since they can't link against the sysroot before it is complete.
configure() {
  cmake -G Ninja -B "build/$1" -S "$2" -DCMAKE_TOOLCHAIN_FILE="$TOOLCHAIN" \
    -DCMAKE_BUILD_TYPE=MinSizeRel -DCMAKE_C_COMPILER_WORKS=ON -DCMAKE_CXX_COMPILER_WORKS=ON "${@:3}"
}

# The native TableGen tools used while building LLVM.
cmake -G Ninja -B build/native -S llvm/llvm -DCMAKE_BUILD_TYPE=Release \
  -DLLVM_ENABLE_PROJECTS=clang -DLLVM_TARGETS_TO_BUILD=WebAssembly \
  -DLLVM_INCLUDE_TESTS=OFF -DLLVM_INCLUDE_BENCHMARKS=OFF -DCLANG_INCLUDE_TESTS=OFF
ninja -C build/native llvm-min-tblgen llvm-tblgen clang-tblgen

# The multicall binary picks up every LLVM tool that is configured, so all are disabled.
tools=()
for tool in llvm/llvm/tools/*/; do
  name=$(basename "$tool" | tr a-z- A-Z_)
  [[ $name == LLVM_DRIVER ]] || tools+=("-DLLVM_TOOL_${name}_BUILD=OFF")
done

# Mirrors YoWASP's build (https://github.com/YoWASP/clang): no threads, mmap emulation,
# and a larger stack, since compiling C++ can easily overflow the default one.
configure llvm llvm/llvm "${tools[@]}" \
  -DCMAKE_C_FLAGS="$CFLAGS -flto=thin -D_WASI_EMULATED_MMAN" \
  -DCMAKE_CXX_FLAGS="$CFLAGS -flto=thin -D_WASI_EMULATED_MMAN" \
  -DCMAKE_EXE_LINKER_FLAGS="-flto=thin -lwasi-emulated-mman -Wl,--max-memory=4294967296 -Wl,-z,stack-size=8388608,--stack-first,--strip-all" \
  -DLLVM_NATIVE_TOOL_DIR=/work/build/native/bin \
  -DLLVM_ENABLE_PROJECTS="clang;lld" \
  -DLLVM_TARGETS_TO_BUILD=WebAssembly \
  -DLLVM_DEFAULT_TARGET_TRIPLE=$TARGET \
  -DLLVM_TOOL_LLVM_DRIVER_BUILD=ON \
  -DLLVM_ENABLE_THREADS=OFF \
  -DLLVM_ENABLE_PIC=OFF \
  -DLLVM_INCLUDE_UTILS=OFF \
  -DLLVM_INCLUDE_TESTS=OFF \
  -DLLVM_INCLUDE_EXAMPLES=OFF \
  -DLLVM_INCLUDE_BENCHMARKS=OFF \
  -DLLVM_INCLUDE_DOCS=OFF \
  -DCLANG_TOOL_CLANG_SCAN_DEPS_BUILD=OFF \
  -DCLANG_TOOL_CLANG_INSTALLAPI_BUILD=OFF \
  -DCLANG_ENABLE_STATIC_ANALYZER=OFF \
  -DCLANG_INCLUDE_TESTS=OFF \
  -DCLANG_INCLUDE_DOCS=OFF \
  -DLLD_BUILD_TOOLS=OFF
ninja -C build/llvm llvm-driver clang-resource-headers

# The sysroot, following wasi-sdk's recipe (https://github.com/WebAssembly/wasi-sdk), without
# exceptions or shared libraries.
rm -rf "$SYSROOT"
configure wasi-libc wasi-libc -DCMAKE_SYSROOT="$SYSROOT" -DCMAKE_INSTALL_PREFIX="$SYSROOT" \
  -DCMAKE_C_FLAGS="$CFLAGS" -DTARGET_TRIPLE=$TARGET -DBUILD_SHARED=OFF
ninja -C build/wasi-libc install

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
cp build/llvm/bin/llvm /out/llvm.wasm
# Reproducibly, so that an unchanged sysroot is byte-for-byte identical.
tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -cf - -C "$SYSROOT" . \
  | gzip -n > /out/sysroot.tar.gz
ls -lh /out
