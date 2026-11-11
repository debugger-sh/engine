# Benchmarks

Times how long each program in `programs/<toolchain>/<program>/` takes to compile and run:

- **cold**: in the engine, in a fresh browser (toolchains are downloaded)
- **warm**: in the engine, in the same browser again (toolchains are cached)
- **local**: with the same toolchains run natively (only with `--local`)

The network is throttled to 100 Mbps down / 15 Mbps up (the global average mobile speed).

```sh
npm run build                                       # benchmark a release build
npm run tools:benchmarks                            # all programs, 10 trials each
npm run tools:benchmarks -- cpp --runs=20 --local   # only cpp, 20 trials, also run locally
```

Results are written to `output/summary.json` (mean, median, stdev, min and max per series) and
`output/raw.json` (every trial). `python3 figure.py` plots them as `output/figure.png`.

To add a program, add a directory to `programs/<toolchain>/`. Each toolchain's `local.ts`
downloads it for your platform (macOS, Linux or Windows) and runs a program with it.
