#include <string>

std::string greet(std::string name) {
  std::string copy = name;
  return copy;
}

int main() {
  return (int)greet("world").size();
}
