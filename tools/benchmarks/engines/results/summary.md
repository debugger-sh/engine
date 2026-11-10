| Language | Scenario             | Old engine mean | Rewrite mean | Old median | Rewrite median | Speedup (mean) | n (old/new) |
| -------- | -------------------- | --------------- | ------------ | ---------- | -------------- | -------------- | ----------- |
| C/C++    | Cold start           | 5.34s ± 1.45    | 4.62s ± 1.43 | 6.02s      | 5.09s          | **1.16×**      | 30/30       |
| C/C++    | Re-run, no change    | 4.49s ± 1.36    | 0.08s ± 0.02 | 5.05s      | 0.07s          | **57.89×**     | 90/90       |
| C/C++    | Re-run, small change | 4.50s ± 1.35    | 1.34s ± 0.89 | 5.09s      | 1.68s          | **3.36×**      | 90/90       |
| Rust     | Cold start           | 6.49s ± 0.91    | 5.25s ± 0.46 | 6.17s      | 5.09s          | **1.23×**      | 30/30       |
| Rust     | Re-run, no change    | 5.41s ± 0.67    | 0.31s ± 0.11 | 5.21s      | 0.27s          | **17.55×**     | 90/90       |
| Rust     | Re-run, small change | 5.41s ± 0.58    | 0.29s ± 0.09 | 5.19s      | 0.28s          | **18.44×**     | 89/90       |
| Python   | Cold start           | 2.15s ± 0.13    | 1.60s ± 0.10 | 2.16s      | 1.61s          | **1.34×**      | 30/30       |
| Python   | Re-run, no change    | 1.31s ± 0.09    | 0.09s ± 0.05 | 1.30s      | 0.07s          | **14.19×**     | 90/90       |
| Python   | Re-run, small change | 1.32s ± 0.08    | 0.08s ± 0.04 | 1.31s      | 0.06s          | **15.62×**     | 90/90       |

| Language | Program    | Scenario             | Old mean | Rewrite mean | Speedup |
| -------- | ---------- | -------------------- | -------- | ------------ | ------- |
| C/C++    | containers | Cold start           | 6.66s    | 5.94s        | 1.12×   |
| C/C++    | containers | Re-run, no change    | 5.76s    | 0.08s        | 69.14×  |
| C/C++    | containers | Re-run, small change | 5.72s    | 2.16s        | 2.65×   |
| C/C++    | fib        | Cold start           | 5.96s    | 5.16s        | 1.15×   |
| C/C++    | fib        | Re-run, no change    | 5.05s    | 0.07s        | 68.47×  |
| C/C++    | fib        | Re-run, small change | 5.09s    | 1.74s        | 2.93×   |
| C/C++    | hello      | Cold start           | 3.41s    | 2.76s        | 1.24×   |
| C/C++    | hello      | Re-run, no change    | 2.67s    | 0.08s        | 35.22×  |
| C/C++    | hello      | Re-run, small change | 2.67s    | 0.12s        | 22.05×  |
| Rust     | containers | Cold start           | 6.93s    | 5.62s        | 1.23×   |
| Rust     | containers | Re-run, no change    | 5.72s    | 0.38s        | 15.25×  |
| Rust     | containers | Re-run, small change | 5.81s    | 0.32s        | 18.08×  |
| Rust     | fib        | Cold start           | 6.30s    | 5.12s        | 1.23×   |
| Rust     | fib        | Re-run, no change    | 5.48s    | 0.31s        | 17.92×  |
| Rust     | fib        | Re-run, small change | 5.35s    | 0.29s        | 18.21×  |
| Rust     | hello      | Cold start           | 6.23s    | 5.02s        | 1.24×   |
| Rust     | hello      | Re-run, no change    | 5.04s    | 0.24s        | 20.63×  |
| Rust     | hello      | Re-run, small change | 5.07s    | 0.27s        | 19.11×  |
| Python   | containers | Cold start           | 2.22s    | 1.71s        | 1.30×   |
| Python   | containers | Re-run, no change    | 1.40s    | 0.15s        | 9.32×   |
| Python   | containers | Re-run, small change | 1.40s    | 0.14s        | 9.89×   |
| Python   | fib        | Cold start           | 2.12s    | 1.54s        | 1.38×   |
| Python   | fib        | Re-run, no change    | 1.27s    | 0.07s        | 18.58×  |
| Python   | fib        | Re-run, small change | 1.29s    | 0.06s        | 20.84×  |
| Python   | hello      | Cold start           | 2.11s    | 1.56s        | 1.35×   |
| Python   | hello      | Re-run, no change    | 1.26s    | 0.06s        | 21.59×  |
| Python   | hello      | Re-run, small change | 1.27s    | 0.05s        | 25.34×  |

1 failed run(s) excluded:

- old rust/fib change: Error: page.evaluate: Error: {"type":"error","error":{"type":"object","message":"null"}}
  at https://localhost:45049/page/bench.js:20:46
  at async timed (https://localhost:45049/page/bench.js:42
