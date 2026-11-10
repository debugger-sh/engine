/**
 * Simple benchmark programs. `source(tag)` embeds `tag` in a string literal, so that a
 * "small change" is a one-token edit; `expected(tag)` is the program's stdout.
 */
export const programs = {
  cpp: {
    hello: {
      source: (tag) => `#include <cstdio>\nint main() { printf("hello ${tag}\\n"); }\n`,
      expected: (tag) => `hello ${tag}\n`
    },
    fib: {
      source: (tag) => `#include <iostream>
int fib(int n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }
int main() {
  for (int i = 0; i < 20; i++) std::cout << fib(i) << " ";
  std::cout << "${tag}" << std::endl;
}
`,
      expected: (tag) => '0 1 1 2 3 5 8 13 21 34 55 89 144 233 377 610 987 1597 2584 4181 ' + tag + '\n'
    },
    containers: {
      source: (tag) => `#include <iostream>
#include <map>
#include <string>
#include <vector>
struct Point { int x, y; };
int main() {
  std::vector<Point> points;
  for (int i = 0; i < 10; i++) points.push_back({i, i * i});
  std::map<std::string, int> counts;
  for (const char* w : {"a", "b", "a", "c", "b", "a"}) counts[w]++;
  int sum = 0;
  for (const auto& p : points) sum += p.y;
  std::cout << sum;
  for (const auto& [k, v] : counts) std::cout << " " << k << "=" << v;
  std::cout << " ${tag}" << std::endl;
}
`,
      expected: (tag) => `285 a=3 b=2 c=1 ${tag}\n`
    }
  },
  rust: {
    hello: {
      source: (tag) => `fn main() {\n    println!("hello ${tag}");\n}\n`,
      expected: (tag) => `hello ${tag}\n`
    },
    fib: {
      source: (tag) => `fn fib(n: u32) -> u32 {
    if n < 2 { n } else { fib(n - 1) + fib(n - 2) }
}
fn main() {
    for i in 0..20 {
        print!("{} ", fib(i));
    }
    println!("${tag}");
}
`,
      expected: (tag) => '0 1 1 2 3 5 8 13 21 34 55 89 144 233 377 610 987 1597 2584 4181 ' + tag + '\n'
    },
    containers: {
      source: (tag) => `use std::collections::BTreeMap;
struct Point { x: i32, y: i32 }
fn main() {
    let points: Vec<Point> = (0..10).map(|i| Point { x: i, y: i * i }).collect();
    let mut counts = BTreeMap::new();
    for w in ["a", "b", "a", "c", "b", "a"] {
        *counts.entry(w).or_insert(0) += 1;
    }
    let sum: i32 = points.iter().map(|p| p.y + p.x - p.x).sum();
    print!("{}", sum);
    for (k, v) in &counts {
        print!(" {}={}", k, v);
    }
    println!(" ${tag}");
}
`,
      expected: (tag) => `285 a=3 b=2 c=1 ${tag}\n`
    }
  },
  python: {
    hello: {
      source: (tag) => `print("hello ${tag}")\n`,
      expected: (tag) => `hello ${tag}\n`
    },
    fib: {
      source: (tag) => `def fib(n):
    return n if n < 2 else fib(n - 1) + fib(n - 2)

print(" ".join(str(fib(i)) for i in range(20)), "${tag}")
`,
      expected: (tag) => '0 1 1 2 3 5 8 13 21 34 55 89 144 233 377 610 987 1597 2584 4181 ' + tag + '\n'
    },
    containers: {
      source: (tag) => `from collections import Counter
from dataclasses import dataclass

@dataclass
class Point:
    x: int
    y: int

points = [Point(i, i * i) for i in range(10)]
counts = Counter(["a", "b", "a", "c", "b", "a"])
print(sum(p.y for p in points), *(f"{k}={v}" for k, v in sorted(counts.items())), "${tag}")
`,
      expected: (tag) => `285 a=3 b=2 c=1 ${tag}\n`
    }
  }
};

/** Source file name for each language. */
export const files = { cpp: 'main.cpp', rust: 'main.rs', python: 'main.py' };
