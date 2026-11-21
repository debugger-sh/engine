#include <cstdio>

#include "ops.h"

int main() {
  const int xs[] = {3, -1, 4, 1, 5, 9, 2, 6};
  const int n = sizeof(xs) / sizeof(xs[0]);

  const int total = sum(xs, n);
  const int prod = product(xs, n);
  const int lo = clamp(sub(total, 10), 0, 20);
  const int hi = clamp(add(total, 10), 0, 50);
  const int spread = abs_val(sub(hi, lo));
  const int scaled = div(mul(spread, max_val(xs[0], xs[n - 1])), min_val(2, 3));

  printf("%d %d %d\n", total, prod, scaled);
}
