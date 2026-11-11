#!/usr/bin/env bash
# Compiles main.rs to an object, links it with the standard library using lld and runs the
# executable, like the engine's `rust` toolchain.
# Usage: toolchain.sh <toolchain dir> <build dir> | --version
set -euo pipefail
if [ "$2" = --version ]; then exec "$1/bin/rustc" --version; fi
lib="$1/lib/rustlib/aarch64-apple-darwin/lib"

# The engine's rustc is a development build, which allows unstable (-Z) flags. Like the engine's
# `--emit=obj`, `-Zno-link` leaves the program's objects, including the allocator shim, unlinked.
RUSTC_BOOTSTRAP=1 "$1/bin/rustc" main.rs -Cpanic=abort -Ccodegen-units=1 -Zthreads=1 -Zno-link --out-dir "$2"

# The standard library's rlibs, in dependency order.
libs=()
for name in panic_abort std object memchr addr2line gimli cfg_if rustc_demangle std_detect hashbrown \
  rustc_std_workspace_alloc miniz_oxide adler2 unwind libc rustc_std_workspace_core alloc core compiler_builtins; do
  libs+=("$lib/lib$name"-*.rlib)
done
cc --ld-path="$lib/../bin/gcc-ld/ld64.lld" -nodefaultlibs "$2"/*.o "${libs[@]}" -lSystem -Wl,-dead_strip -o "$2/main"
"$2/main"
