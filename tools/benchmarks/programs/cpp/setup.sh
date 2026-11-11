#!/usr/bin/env bash
# Downloads the engine's C++ toolchain (clang and lld 22.1.0), natively for macOS on Apple silicon.
# Usage: setup.sh <toolchain dir>
set -euo pipefail
[ -d "$1" ] && exit 0
rm -rf "$1.part" && mkdir -p "$1.part"
curl -fL https://github.com/llvm/llvm-project/releases/download/llvmorg-22.1.0/LLVM-22.1.0-macOS-ARM64.tar.xz |
  tar -xJ -C "$1.part" --strip-components=1 '*/bin/clang*' '*/bin/lld' '*/bin/ld64.lld' '*/lib/clang'
# Unlike Apple's, upstream clang needs to be told where the macOS SDK is.
echo "-isysroot $(xcrun --show-sdk-path)" > "$1.part/bin/clang++.cfg"
mv "$1.part" "$1"
