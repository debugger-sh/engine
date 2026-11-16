# Shared by the toolchains' build scripts, which source it inside their Docker images. Each
# toolchain's folder is at /toolchain, /work persists between builds (sources and build trees)
# and the artifacts are written to /out.

TARGET=wasm32-wasip1
WASI_SDK=/opt/wasi-sdk
# The C and C++ flags for wasm32-wasip1: the WebAssembly features that wasi-sdk and Rust target.
CFLAGS="-mcpu=lime1"
cd /work

# A field of the upstream source in provenance.json, e.g. `upstream revision`.
upstream() {
  python3 -c "import json, sys; print(json.load(open('/toolchain/provenance.json'))['upstream'][sys.argv[1]])" "$1"
}

# A revision (or tag) of a repository, fetched shallowly and checked out in place, with an
# optional patch committed on top. Only files whose contents change are rewritten, which keeps
# builds incremental (the LLVM patch touches headers that almost every file includes).
fetch() {
  git init -q "$1"
  git -C "$1" fetch -q --depth 1 "$2" "$3"
  local commit=FETCH_HEAD index=$PWD/$1/.git/patched
  if [[ -n ${4:-} ]]; then
    # The patch is applied in a separate index, so the checkout below can skip unchanged files.
    # The commit is dated, so its hash (which compilers embed in their version) is reproducible.
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

# Configures a CMake cross build for wasm32-wasip1 into build/<name>. The compiler checks are
# skipped, since they can't link against a sysroot before it is complete.
configure() {
  cmake -G Ninja -B "build/$1" -S "$2" -DCMAKE_TOOLCHAIN_FILE="$WASI_SDK/share/cmake/wasi-sdk-p1.cmake" \
    -DCMAKE_BUILD_TYPE=MinSizeRel -DCMAKE_C_COMPILER_WORKS=ON -DCMAKE_CXX_COMPILER_WORKS=ON "${@:3}"
}

# Configures LLVM (in an llvm-project checkout, with the projects given) for wasm32-wasip1 into
# build/llvm, with more CMake options. Mirrors YoWASP's build (https://github.com/YoWASP/clang): no
# threads, mmap emulation, and a larger stack, since compiling C++ can easily overflow the default
# one. For size: LTO, and none of the optional features (assertions, backtraces, compression, ...).
# Full LTO would be smaller still, but takes more memory than Docker usually has.
#
# First builds the native tools this needs into build/native: TableGen, and an llvm-config that is
# configured the same way, so that it describes an installation of the WebAssembly build it's put in.
configure_llvm() {
  local options=(-DLLVM_ENABLE_PROJECTS="$2" -DLLVM_TARGETS_TO_BUILD=WebAssembly -DLLVM_ENABLE_PIC=OFF
    -DLLVM_ENABLE_ZLIB=OFF -DLLVM_ENABLE_ZSTD=OFF -DLLVM_ENABLE_LIBXML2=OFF
    -DLLVM_INCLUDE_TESTS=OFF -DLLVM_INCLUDE_BENCHMARKS=OFF -DCLANG_INCLUDE_TESTS=OFF)
  cmake -G Ninja -B build/native -S "$1/llvm" -DCMAKE_BUILD_TYPE=Release "${options[@]}"
  ninja -C build/native llvm-min-tblgen llvm-tblgen llvm-config $([[ $2 == *clang* ]] && echo clang-tblgen)

  local flags="$CFLAGS -flto=thin -D_WASI_EMULATED_MMAN"
  configure llvm "$1/llvm" "${options[@]}" "${@:3}" \
    -DCMAKE_C_FLAGS="$flags" -DCMAKE_CXX_FLAGS="$flags" \
    -DCMAKE_EXE_LINKER_FLAGS="-flto=thin -lwasi-emulated-mman -Wl,--max-memory=4294967296 -Wl,-z,stack-size=8388608,--stack-first" \
    -DLLVM_NATIVE_TOOL_DIR=/work/build/native/bin \
    -DLLVM_DEFAULT_TARGET_TRIPLE=$TARGET \
    -DLLVM_ENABLE_THREADS=OFF \
    -DLLVM_ENABLE_ASSERTIONS=OFF \
    -DLLVM_ENABLE_BACKTRACES=OFF \
    -DLLVM_ENABLE_CRASH_OVERRIDES=OFF \
    -DLLVM_ENABLE_UNWIND_TABLES=OFF \
    -DLLVM_ENABLE_TELEMETRY=OFF \
    -DLLVM_INCLUDE_UTILS=OFF \
    -DLLVM_INCLUDE_EXAMPLES=OFF \
    -DLLVM_INCLUDE_DOCS=OFF
}

# Installs wasi-libc (wasi-sdk's, but without the debug info that would otherwise end up in
# every program, and that a debugger would step into) into a sysroot.
wasi_libc() {
  fetch wasi-libc https://github.com/WebAssembly/wasi-libc "wasi-sdk-$(head -1 "$WASI_SDK/VERSION" | cut -d. -f1)"
  configure wasi-libc wasi-libc -DCMAKE_SYSROOT="$1" -DCMAKE_INSTALL_PREFIX="$1" \
    -DCMAKE_C_FLAGS="$CFLAGS" -DTARGET_TRIPLE=$TARGET -DBUILD_SHARED=OFF
  ninja -C build/wasi-libc install
}

# Optimizes a linked module with Binaryen (for size, unless another level is given), dropping its
# names and debug info. The module must have kept its `target_features` section (so it can't be
# linked with --strip-all).
optimize() {
  /opt/binaryen/bin/wasm-opt "${3:--Os}" --strip-debug --strip-producers "$1" -o "$2"
}

# Packs a directory's contents reproducibly (an unchanged directory packs byte-for-byte the
# same), compressed by the archive's extension: .tar.gz, .tar.xz or .tar.zst.
pack() {
  local compress=(gzip -9n)
  case $2 in
    *.xz) compress=(xz -9e) ;;
    *.zst) compress=(zstd -19 -q) ;;
  esac
  tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -cf - -C "$1" . | "${compress[@]}" > "$2"
}
