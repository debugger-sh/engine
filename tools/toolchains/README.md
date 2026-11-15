# Toolchains

Build scripts for the toolchains the engine runs (compiled to `wasm32-wasip1`). Each toolchain
is a folder with a `Dockerfile` that builds it from source, so builds are reproducible on any
machine with Docker.

```sh
npm run tools:toolchain llvm build
```

Builds the toolchain into `<name>/output` (gitignored), then tests the library with it: the
`artifacts` in `provenance.json` temporarily point at the outputs (served locally) while the
library is built and `npm run test` runs. Sources and build trees are cached in a Docker volume
(`debugger-sh-toolchain-<name>`), so rebuilds are incremental; remove the volume to start from
scratch.

```sh
npm run tools:toolchain llvm release
```

Builds the toolchain, then releases it on the fork as the library's version (from
`package.json`): the changes are committed onto the upstream revision as the branch
`debugger-sh/<version>`, the outputs are attached to the GitHub release `<version>`, and
`provenance.json` is updated to point at them. Releasing again updates the branch and release in
place. This requires `gh auth login` with push access to the fork.

## Provenance

Each toolchain's `provenance.json` records:

- `upstream`: the `repository` and `revision` our changes are based on. The changes are kept in
  `changes.patch`, which is applied before building.
- `fork`: the [debugger-sh](https://github.com/debugger-sh) fork of the `repository`, and its
  latest `release`.
- `artifacts`: the URL of each artifact the library downloads, e.g. `sysroot`. These are inlined
  into the library when it's built (see `getToolchainArtifact`), and each is built as the output
  named after it, e.g. `output/sysroot.tar.gz`.

The patch is a series of commits (`git format-patch`), so to change it or upgrade the revision:

```sh
git clone <repository> && cd <repository name>
git checkout <revision> && git am <toolchain>/changes.patch
# Commit new changes, or rebase them onto a new revision (and update provenance.json).
git format-patch --stdout <revision> > <toolchain>/changes.patch
```

## llvm

Built from `llvmorg-23.1.5` with two changes:

- [llvm/llvm-project#92677](https://github.com/llvm/llvm-project/pull/92677) (via
  [YoWASP](https://github.com/YoWASP/clang)), which lets LLVM build for WASI.
- A libc++ locale fix that [wasi-sdk](https://github.com/WebAssembly/wasi-sdk) also carries.

It produces:

- `llvm`: clang and lld in one multicall binary, dispatched on `argv[0]` (`clang`, `clang++` or
  `wasm-ld`).
- `sysroot`: clang's headers, compiler-rt, wasi-libc and libc++ (without exceptions).
