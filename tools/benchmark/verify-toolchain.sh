#!/usr/bin/env bash
# Verfies that:
#   (1) the in-browser binary really is the pinned version/commit, and
#   (2) the native build matches it on every compiler-behavior axis.
# Exits non-zero on any mismatch. Set BENCH_VERIFY_REMOTE=1 to also re-download
# and re-fingerprint the hosted wasm binary (~75MB) in case there have been any updates.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/versions.env"
BUILD_DIR="${BENCH_BUILD_DIR:-$HERE/.build}"
PREFIX="$BUILD_DIR/install"
fail=0
ok()  { echo "  ok   $*"; }
bad() { echo "  FAIL $*"; fail=1; }

echo "== pinned identity =="
echo "  llvm $LLVM_VERSION @ $LLVM_COMMIT  ($LLVM_FORK_URL)"

# (1) Optional: re-verify the hosted in-browser binary.
if [ "${BENCH_VERIFY_REMOTE:-0}" = "1" ]; then
  echo "== remote binary =="
  tmp="$(mktemp)"; curl -sL "$WASM_BINARY_URL" -o "$tmp"
  got="$(shasum -a 256 "$tmp" | awk '{print $1}')"
  [ "$got" = "$WASM_BINARY_SHA256" ] && ok "sha256 matches pin" || bad "sha256 drifted: $got"
  if command -v wasmtime >/dev/null; then
    cp "$tmp" "$tmp.clang"
    ver="$(wasmtime run "$tmp.clang" --version 2>/dev/null)"
    grep -q "$LLVM_VERSION" <<<"$ver"  && ok "binary reports $LLVM_VERSION" || bad "binary version: $ver"
    grep -q "$LLVM_COMMIT"  <<<"$ver"  && ok "binary reports commit"       || bad "binary commit: $ver"
    grep -q "+assertions"   <<<"$ver"  && ok "binary +assertions"          || bad "binary assertions: $ver"
    rm -f "$tmp.clang"
  fi
  rm -f "$tmp"
fi

# (2) The native build.
CLANG="$PREFIX/bin/clang"
if [ ! -x "$CLANG" ]; then
  echo "== native build =="; bad "not built yet ($CLANG). Run build-native-clang.sh"
  echo; [ "$fail" = 0 ] && echo "PASS" || echo "INCOMPLETE"; exit "$fail"
fi

echo "== native build =="
nver="$($CLANG --version 2>/dev/null)"
grep -q "$LLVM_VERSION" <<<"$nver"        && ok "version $LLVM_VERSION"        || bad "version: $(head -1 <<<"$nver")"
grep -q "$LLVM_COMMIT"  <<<"$nver"        && ok "same commit as binary"        || bad "commit: $(head -1 <<<"$nver")"
grep -q "+assertions"   <<<"$nver"        && ok "+assertions (matches binary)" || bad "assertions off"
grep -qi "wasm32" <<<"$nver"              && ok "default target wasm32"        || bad "default target: $(grep -i target <<<"$nver")"

cache="$BUILD_DIR/llvm-build/CMakeCache.txt"
grep -q "LLVM_ENABLE_THREADS:BOOL=OFF"        "$cache" 2>/dev/null && ok "threads OFF (matches binary)" || bad "threads not OFF"
grep -q "CMAKE_BUILD_TYPE:STRING=MinSizeRel"  "$cache" 2>/dev/null && ok "MinSizeRel (matches binary)"  || bad "build type != MinSizeRel"

# Smoke compile: same target + flags the engine uses (src/worker/mod.rs:114).
# Requires the sysroot extracted at $BENCH_SYSROOT (see README); skipped otherwise.
if [ -n "${BENCH_SYSROOT:-}" ] && [ -d "$BENCH_SYSROOT" ]; then
  echo "== smoke compile (wasm32-wasip1, engine flags) =="
  tmpd="$(mktemp -d)"; printf '#include <iostream>\nint main(){std::cout<<"ok";}\n' > "$tmpd/t.cpp"
  if "$CLANG" -cc1 -triple "$TARGET_TRIPLE" -emit-obj -isysroot "$BENCH_SYSROOT" \
       -internal-isystem "$BENCH_SYSROOT/include/c++/v1" \
       -internal-isystem "$BENCH_SYSROOT/include" \
       -internal-isystem "$BENCH_SYSROOT/include/wasm32-wasip1" \
       -x c++ -std=c++23 -O0 -o "$tmpd/t.o" "$tmpd/t.cpp" 2>"$tmpd/err"; then
    ok "compiled hello.cpp to $TARGET_TRIPLE"
  else
    bad "smoke compile failed:"; sed 's/^/       /' "$tmpd/err"
  fi
  rm -rf "$tmpd"
else
  echo "  skip smoke compile (set BENCH_SYSROOT to the extracted llvm-resources sysroot)"
fi

echo; [ "$fail" = 0 ] && echo "PASS — native toolchain matches the in-browser binary" || echo "FAIL — see above"
exit "$fail"
