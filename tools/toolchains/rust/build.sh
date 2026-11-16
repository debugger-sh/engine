#!/usr/bin/env bash
# Builds rustc for wasm32-wasip1 inside the Docker image, from the Rust revision in
# provenance.json with changes.patch applied (and the llvm toolchain's changes to its LLVM):
#
#  * /out/rustc.wasm: rustc, which compiles crates to objects (that are linked with lld).
#  * /out/sysroot.tar.zst: the standard library for wasm32-wasip1.
#
# /work persists between runs (sources and build trees), so rebuilds are incremental.
set -euo pipefail
source /toolchain/common.sh

fetch rust "$(upstream repository)" "$(upstream revision)" /toolchain/changes.patch
# The submodules that the compiler and standard library need, at the revisions Rust pins.
submodule() {
  fetch "rust/$1" "$2" "$(git -C rust ls-tree HEAD "$1" | awk '{print $3}')" "${@:3}"
}
submodule src/llvm-project https://github.com/rust-lang/llvm-project /toolchain/llvm.patch
submodule library/backtrace https://github.com/rust-lang/backtrace-rs

# The LLVM that rustc.wasm links (bootstrap builds the build machine's), installed with the native
# llvm-config, which describes the installation it's in (being configured the same way), and the
# wasi-libc that the standard library ships.
LLVM=/work/llvm
configure_llvm rust/src/llvm-project "" -DLLVM_BUILD_TOOLS=OFF -DCMAKE_INSTALL_PREFIX=$LLVM
ninja -C build/llvm install-llvm-headers install-llvm-libraries
mkdir -p $LLVM/bin && cp build/native/bin/llvm-config $LLVM/bin/
wasi_libc /work/wasi-sysroot

# For size: the compiler is optimized for size, with LTO, and the standard library is built without
# backtraces, which WASI can't produce. Full LTO would be smaller, but takes too much memory.
HOST=$(uname -m | sed 's/x86_64/X86/; s/aarch64/AArch64/')
cat > rust/bootstrap.toml <<EOF
change-id = "ignore"

[llvm]
download-ci-llvm = false
targets = "WebAssembly;$HOST"
experimental-targets = ""

[build]
# Fewer jobs than cores, as compiling LLVM and rustc can take more memory than Docker has.
jobs = 6
host = ["$TARGET"]
target = ["$TARGET"]
docs = false
extended = false
tools = []
submodules = false

[rust]
optimize = "z"
lto = "thin"
codegen-units = 1
debug = false
debuginfo-level = 0
debug-assertions = false
incremental = false
strip = false
backtrace = false
llvm-tools = false
llvm-bitcode-linker = false
# Upstream code warns when it's built for a WASI host (e.g. about dependencies only others use).
deny-warnings = false

[target.$TARGET]
llvm-config = "$LLVM/bin/llvm-config"
linker = "/toolchain/clang++.sh"
# Links with the linker above, rather than one that comes with Rust, which isn't built.
rustflags = ["-Zunstable-options", "-Clink-self-contained=-linker"]
wasi-root = "/work/wasi-sysroot"
EOF
# rustc.wasm is built by the build machine's rustc (stage 1), which also builds the standard library
# that it ships (being the same version).
x() { (cd rust && WASI_SDK_PATH=$WASI_SDK python3 x.py build "$@"); }
x --stage 2 compiler/rustc
x --stage 1 library/std
optimize rust/build/$TARGET/stage2/bin/rustc.wasm /out/rustc.wasm

# The standard library, without the crates that only tests, proc macros and unwinding need.
SYSROOT=/work/sysroot
LIB=$SYSROOT/lib/rustlib/$TARGET/lib
rm -rf "$SYSROOT" && mkdir -p "$(dirname "$LIB")"
cp -R rust/build/host/stage1/lib/rustlib/$TARGET/lib "$LIB"
for crate in test proc_macro getopts rustc_literal_escaper sysroot rustc_std_workspace_std panic_unwind; do
  rm -f "$LIB"/lib${crate}-*
done
pack "$SYSROOT" /out/sysroot.tar.zst
ls -lh /out
