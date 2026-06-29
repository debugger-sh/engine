#!/usr/bin/env bash
# Program-runtime benchmark: compile ONE program two ways from the same pinned
# LLVM optimizer, then time both and report the wasm/native ratio.
#   wasm   : .build       clang (targets wasm32-wasip1)  -> run under wasmer (the engine's runtime)
#   native : .build-host  clang (targets the host arch)  -> run as a native binary
# Both at the same -O level, so the only variable is the target ISA / execution.
#
# Usage:   ./run-benchmark.sh <program.(cpp|c)> [-- prog args...]
# Env:     BENCH_ITERS=5  BENCH_OPT=O2  BENCH_STD=c++23
#          BENCH_WASI_SYSROOT=/tmp/sysroot  BENCH_RUNTIME=wasmer
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/versions.env"

[ $# -ge 1 ] || { echo "usage: $0 <program.(cpp|c)> [-- prog args...]" >&2; exit 1; }
SRC="$1"; shift
[ "${1:-}" = "--" ] && shift
PROG_ARGS=("$@")
[ -f "$SRC" ] || { echo "no such file: $SRC" >&2; exit 1; }

ITERS="${BENCH_ITERS:-5}"
OPT="${BENCH_OPT:-O2}"
STD="${BENCH_STD:-c++23}"
RUNTIME="${BENCH_RUNTIME:-wasmer}"
WASI="${BENCH_WASI_SYSROOT:-/tmp/sysroot}"
WASM_BIN="${BENCH_WASM_BIN:-$HERE/.build/install/bin}"
HOST_BIN="${BENCH_HOST_BIN:-$HERE/.build-host/install/bin}"

case "$SRC" in *.c) DRV=clang; LANG_ARGS=() ;; *) DRV=clang++; LANG_ARGS=(-std="$STD") ;; esac
for f in "$WASM_BIN/$DRV" "$HOST_BIN/$DRV"; do [ -x "$f" ] || { echo "missing compiler: $f (build it first)" >&2; exit 1; }; done
[ -d "$WASI" ] || { echo "wasi sysroot not found: $WASI  (see README: extract llvm-resources)" >&2; exit 1; }
command -v "$RUNTIME" >/dev/null || { echo "missing wasm runtime: $RUNTIME" >&2; exit 1; }
SDK="$(xcrun --show-sdk-path 2>/dev/null || true)"

base="$(basename "$SRC")"; base="${base%.*}"
out_wasm="$HERE/$base.wasm"; out_native="$HERE/$base.bench.bin"

echo "== compile (-$OPT) =="
# compiler-rt builtins live in the sysroot (we don't build compiler-rt); -resource-dir
# points clang there for both the runtime lib and the builtin headers.
"$WASM_BIN/$DRV" "${LANG_ARGS[@]}" --target=wasm32-wasip1 "-$OPT" \
  --sysroot="$WASI" -resource-dir "$WASI" "$SRC" -o "$out_wasm"
echo "  wasm   -> $out_wasm"
"$HOST_BIN/$DRV" "${LANG_ARGS[@]}" "-$OPT" ${SDK:+-isysroot "$SDK"} "$SRC" -o "$out_native"
echo "  native -> $out_native"

# Correctness: both builds should produce identical stdout.
n_out="$("$out_native" ${PROG_ARGS[@]+"${PROG_ARGS[@]}"} 2>/dev/null || true)"
w_out="$("$RUNTIME" run "$out_wasm" -- ${PROG_ARGS[@]+"${PROG_ARGS[@]}"} 2>/dev/null || true)"
if [ "$n_out" = "$w_out" ]; then echo "  output: identical"; else echo "  WARNING: native/wasm output differ"; fi

# perf_counter timing (macOS date has no sub-second); 1 warmup, then ITERS runs.
timeit() {  # args: <command...>  -> prints "min avg"
  python3 - "$ITERS" "$@" <<'PY'
import subprocess, sys, time
n=int(sys.argv[1]); cmd=sys.argv[2:]
subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)  # warmup
ts=[]
for _ in range(n):
    t=time.perf_counter()
    r=subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    ts.append(time.perf_counter()-t)
    if r.returncode!=0: sys.stderr.write("run failed\n"); sys.exit(1)
print(f"{min(ts):.6f} {sum(ts)/len(ts):.6f}")
PY
}

echo "== run ($ITERS iters, runtime=$RUNTIME) =="
read -r n_min n_avg < <(timeit "$out_native" ${PROG_ARGS[@]+"${PROG_ARGS[@]}"})
read -r w_min w_avg < <(timeit "$RUNTIME" run "$out_wasm" -- ${PROG_ARGS[@]+"${PROG_ARGS[@]}"})

ratio_min="$(python3 -c "print(f'{$w_min/$n_min:.2f}')")"
ratio_avg="$(python3 -c "print(f'{$w_avg/$n_avg:.2f}')")"
printf "  %-8s  min %8.3f ms   avg %8.3f ms\n" native "$(python3 -c "print($n_min*1000)")" "$(python3 -c "print($n_avg*1000)")"
printf "  %-8s  min %8.3f ms   avg %8.3f ms\n" wasm   "$(python3 -c "print($w_min*1000)")" "$(python3 -c "print($w_avg*1000)")"
echo "  ratio wasm/native:  min ${ratio_min}x   avg ${ratio_avg}x"
