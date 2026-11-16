void baz(int v) {
  int q = v * 2;
}

void bar(int v) {
  int w = v + 1;
}

void foo(int a) {
  int x = a + 1;
  baz(x);
  bar(x);
  int y = x + 2;
}

int main() {
  int seed = 1;
  foo(seed);
  return 0;
}
