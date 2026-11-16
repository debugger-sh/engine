void baz(int v) {
  int q = v * 2;
}

void bar(int v) {
  baz(v);
  int w = v + 1;
}

void foo(int a) {
  bar(a);
  int x = a + 3;
}

int main() {
  foo(1);
  return 0;
}