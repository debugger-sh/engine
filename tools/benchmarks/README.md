# Benchmarks (`tools/benchmarks`)

Measures the total time (including compiling and linking) to run each program in
`programs/<toolchain>/<program>/` three ways:

- **`local`**: the engine's toolchains (clang/lld 22.1.0, rustc 1.96.0, Python 3.11.3) run
  natively, after one untimed warm-up run.
- **`first`**: the engine in a fresh Chromium profile, so toolchains are downloaded.
- **`subsequent`**: the engine in a new page of that same profile, so toolchains come from the
  browser's HTTP cache.

The engine is timed from `Engine.create()` until the program exits (loading the page is not
timed), with the network throttled to 100 Mbps down / 15 Mbps up, roughly the global average
mobile network speed (Speedtest Global Index).

```sh
npm run build                                      # benchmark a release build, not `npm run dev`'s
npm run tools:benchmarks                           # everything, 10 runs each
npm run tools:benchmarks -- cpp python/hello-world --runs=20
```

## Programs

Each program is a directory in `programs/<toolchain>/`, mounted at `/` in the engine. Natively,
each toolchain has two scripts, both given the toolchain's directory (`.toolchains/<toolchain>`):

- `setup.sh <toolchain dir>` runs once before the toolchain's trials, downloading native builds
  of the engine's toolchain for macOS on Apple silicon (skipped if already downloaded).
- `toolchain.sh <toolchain dir> <build dir>` runs each trial in the program's directory. Like the
  engine, it compiles sources to objects, then links them with lld, then runs the executable.
  Given `--version` instead of a build directory, it prints the toolchain's version.

The engine's output must match the native output.

## Output

- `output/raw.json`: `{ meta, datapoints: [{ toolchain, program, series, trial, ms }] }`
- `output/summary.json`: `{ meta, summary: { [toolchain]: { [program]: { [series]: stats } } } }`,
  where `stats` is `{ n, mean, median, stdev, min, max }` in milliseconds.

`meta` records the date, the number of runs, the machine, the browser, the network, and the version of
each native toolchain.

`python3 figure.py [program]` (with matplotlib) plots `summary.json` as `output/figure.png`: the mean of
each series, per toolchain, for one program (`hello-world` by default).
