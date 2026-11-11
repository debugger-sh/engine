#!/usr/bin/env bash
# Downloads the engine's Python (3.11.3), natively for macOS on Apple silicon.
# Usage: setup.sh <toolchain dir>
set -euo pipefail
[ -d "$1" ] && exit 0
rm -rf "$1.part" && mkdir -p "$1.part"
curl -fL https://github.com/astral-sh/python-build-standalone/releases/download/20230507/cpython-3.11.3+20230507-aarch64-apple-darwin-install_only.tar.gz |
  tar -xz -C "$1.part" --strip-components=1
mv "$1.part" "$1"
