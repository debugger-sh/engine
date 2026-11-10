#!/usr/bin/env bash
# Downloads the toolchain assets both engines fetch into ./mirror/<host>/<path>.
set -euo pipefail
cd "$(dirname "$0")"
for url in \
  https://fabioibanez.github.io/website/llvm.core.wasm \
  https://fabioibanez.github.io/website/llvm-resources.tar.gz \
  https://debugger-sh.github.io/engine/rustc.wasm \
  https://debugger-sh.github.io/engine/rust-sysroot.tar.gz \
  https://runno.dev/langs/python-3.11.3.wasm \
  https://runno.dev/langs/python-3.11.3.tar.gz; do
  curl -fsSL --create-dirs -o "mirror/${url#https://}" "$url"
done
