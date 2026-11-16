struct Point {
  int x;
  int y;
};

struct Rectangle {
  Point p1;
  Point p2;
};

int main() {
  Rectangle rect{{1, 2}, {3, 4}};
  return 0;
}