#include <cstdint>
#include <cstdio>

// CPU-bound, deterministic, no I/O in the hot loop. Sized to take a few hundred ms
// at -O0 so the timer has signal on both native and wasm-in-engine.
int main() {
  uint64_t acc = 0;
  for (uint64_t i = 1; i < 50000000ULL; i++) {
    acc += i * 2654435761ULL;
    acc ^= acc >> 13;
  }
  printf("%llu\n", (unsigned long long)acc);
  return 0;
}
