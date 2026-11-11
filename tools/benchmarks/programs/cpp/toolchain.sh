#!/usr/bin/env bash
# Compiles each C/C++ source in the working directory to an object (in parallel), links them
# with lld and runs the executable, like the engine's `cpp` toolchain.
# Usage: toolchain.sh <toolchain dir> <build dir> | --version
set -euo pipefail
if [ "$2" = --version ]; then exec "$1/bin/clang" --version; fi

objects=() jobs=()
for src in $(find . -type f \( -name '*.c' -o -name '*.cc' -o -name '*.cp' -o -name '*.cpp' -o -name '*.cxx' -o -name '*.c++' \)); do
  mkdir -p "$2/$(dirname "$src")"
  "$1/bin/clang++" -x c++ -std=c++23 -O0 -g -gdwarf-5 -fstandalone-debug -c "$src" -o "$2/$src.o" &
  objects+=("$2/$src.o") jobs+=($!)
done
for job in "${jobs[@]}"; do wait "$job"; done

"$1/bin/clang++" -fuse-ld=lld "${objects[@]}" -o "$2/main"
"$2/main"
