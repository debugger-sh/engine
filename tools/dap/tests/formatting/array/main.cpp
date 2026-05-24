#pragma clang diagnostic ignored "-Wvla-cxx-extension"

int main() {
  int fixed[3] = {1, 2, 3};
  int n = 4;
  int dyn[n * 2];
  for (int i = 0; i < n; i++) dyn[i] = i * 10;
  return fixed[0];
}
