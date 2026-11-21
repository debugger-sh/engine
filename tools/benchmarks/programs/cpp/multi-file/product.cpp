#include "ops.h"

int product(const int* xs, int n) {
  int total = 1;
  for (int i = 0; i < n; i++) total = mul(total, xs[i]);
  return total;
}
