#!/usr/bin/env bash
# Downloads the engine's Rust toolchain (rustc and the standard library 1.96.0), natively for
# macOS on Apple silicon. Usage: setup.sh <toolchain dir>
set -euo pipefail
[ -d "$1" ] && exit 0
rm -rf "$1.part" && mkdir -p "$1.part"
for component in rustc rust-std; do
  curl -fL "https://static.rust-lang.org/dist/$component-1.96.0-aarch64-apple-darwin.tar.xz" |
    tar -xJ -C "$1.part" --strip-components=2
done
mv "$1.part" "$1"
