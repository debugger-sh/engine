#!/usr/bin/env bash
# Native baseline benchmark: compile ONE program with the pinned host toolchain
# (.build-host clang, targets the host arch), then run it N times and report
# min/avg wall-clock. This is the native baseline to compare engine timings against.
#
# Usage:   ./run-benchmark.sh <program.(cpp|c)> [-- prog args...]
# Env:     BENCH_ITERS=5  BENCH_OPT=O2  BENCH_STD=c++23
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
HOST_BIN="${BENCH_HOST_BIN:-$HERE/.build-host/install/bin}"

case "$SRC" in *.c) DRV=clang; LANG_ARGS=() ;; *) DRV=clang++; LANG_ARGS=(-std="$STD") ;; esac
[ -x "$HOST_BIN/$DRV" ] || { echo "missing compiler: $HOST_BIN/$DRV (run build-host-clang.sh first)" >&2; exit 1; }
SDK="$(xcrun --show-sdk-path 2>/dev/null || true)"

base="$(basename "$SRC")"; base="${base%.*}"
out_native="$HERE/$base.bench.bin"

echo "== compile (-$OPT) =="
"$HOST_BIN/$DRV" "${LANG_ARGS[@]}" "-$OPT" ${SDK:+-isysroot "$SDK"} "$SRC" -o "$out_native"
echo "  native -> $out_native"

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

echo "== run ($ITERS iters) =="
read -r n_min n_avg < <(timeit "$out_native" ${PROG_ARGS[@]+"${PROG_ARGS[@]}"})
printf "  %-8s  min %8.3f ms   avg %8.3f ms\n" native "$(python3 -c "print($n_min*1000)")" "$(python3 -c "print($n_avg*1000)")"
