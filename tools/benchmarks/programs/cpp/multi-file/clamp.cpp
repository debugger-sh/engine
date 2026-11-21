#include "ops.h"

int clamp(int x, int lo, int hi) { return min_val(max_val(x, lo), hi); }
