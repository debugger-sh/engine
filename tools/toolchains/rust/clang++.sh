#!/bin/sh
# Links rustc.wasm with wasi-sdk's clang++ (rustc passes it clang's arguments, after its name),
# with what LLVM needs that rustc doesn't link (as it links without default libraries): the C++ ABI
# library, wasi-libc's stand-ins for loading libraries and mmap emulation. And memory that can grow
# to 4 GiB, and a stack large enough for rustc, which runs on the main thread (WASI has no others).
exec /opt/wasi-sdk/bin/clang++ "$@" -lc++abi -ldl -lwasi-emulated-mman \
  -Wl,--max-memory=4294967296 -Wl,-z,stack-size=33554432
