# Toolchains

The toolchains the engine runs, built from source for `wasm32-wasip1`.

## Build a toolchain

```sh
npm run tools:toolchain <name> build
```

Builds the toolchain into `<name>/output`, then runs `npm run test` against it. Builds are cached
in the Docker volume `debugger-sh-toolchain-<name>`; remove it to start from scratch.

## Release a toolchain

```sh
npm run tools:toolchain <name> release
```

Builds the toolchain, then releases it as the library's version on its
[debugger-sh](https://github.com/debugger-sh) fork, and points `provenance.json` at the release.
Requires `gh auth login` with push access to the fork.

## Layout

- `Dockerfile` and `common.sh`: the shared build image and build steps.
- `<name>/build.sh`: builds the toolchain, writing each artifact to `/out`.
- `<name>/provenance.json`: the `upstream` revision it's built from, its `fork`, and the URL of
  each of its `artifacts`, which are inlined into the library (see `getToolchainArtifact`).
- `<name>/changes.patch`: our changes to the upstream revision, as a single commit. To change it:

```sh
git clone <repository> && cd <repository name>
git checkout <revision> && git am <toolchain>/changes.patch
# Amend the commit
git format-patch --stdout <revision> > <toolchain>/changes.patch
```
