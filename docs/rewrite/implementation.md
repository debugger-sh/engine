# Library Rewrite – Implementation

This document serves to flesh out implementation decisions as part of the library rewrite, beyond just the interface.

As a general principle, the three priorities of the rewrite are:

- **Simplicity.** Implementations should not be more complex than they need to be. Elegant, simple solutions that ignore rare edge cases are preferred to complex ones that address every edge case.
- **Speed.** The ability to compile, execute, and debug files quickly is a core aim of the library. Implementations should be done in a way that respects that. For example, true in-memory sharing of files is preferred to an RPC style approach that would introduce latency.
- **Correctness.** The library must be bug-free. In practice, this means that we must have a comprehensive suite of test cases that check the correctness of the implementation. Each component of the interface must have a small unit test which verifies its correctness.

During implementation, study the [Wasmer WASI SDK](https://github.com/wasmerio/wasmer-sdk) and [Wasmer](https://github.com/wasmerio/wasmer) repositories. Clone them locally if they are not already available. These should be treated as high quality reference sources from which you can gain information about how to write quality Rust code, how to set up shared in-memory filesystems, and how to interface with the existing Wasmer code.

## Filesystem

Migrating to a shared in-memory filesystem is a significant implementation challenge. An example of how this might work that is relevant for our purposes is the [Wasmer WASI SDK](https://github.com/wasmerio/wasmer-sdk), which exposes the following interface:

```ts
import { Wasmer } from '@wasmer/sdk/node';

const wasmer = new Wasmer();
const sandbox = await wasmer.sandboxes.create({
  packages: ['python/python@=3.13.20'],
  files: {
    'main.py': 'print(sum(number * number for number in range(10)))'
  }
});

const output = await sandbox.command('python', ['/workspace/main.py']).run();

console.log(output.text());
```

In their case, `sandbox` is analogous to our `engine`. In Wasmer, only the `/workspace` folder is shared, whereas in our case, the whole root directory will be shared across processes. Consider cloning this repository and digging around to see what parts can be borrowed for the new implementation.

The filesystem must be shared in-memory with zero-copy access. Please study the `wasmer-sdk` source to understand how this should be done, since it has effectively solves this problem. Please do not re-implement the filesystem operations e.g. on top of a `SharedArrayBuffer`; use the functionality that the Wasmer Rust crate already provides while adhering to the rest of this document and the interface guidelines. The library may not depend on the `@wasmer/sdk`: it must borrow this functionality from the `wasmer` crate (not the SDK) or implement it on its own.

### Handling sysroots

Currently, the library unions the serialized user filesystem snapshot with the downloaded sysroot. This approach will not work with the new shared filesystem. During execution of a command, the sysroot should be treated as an overlay filesystem, so that the sysroot contents are visible locally to the executing toolchain but not to the outside world. Essentially, this looks like:

```rs
OverlayFileSystem::new(
  workspace.clone(),   // Shared filesystem (e.g. /main.cpp, /a.out, etc.)
  [sysroot.clone()],   // Sysroot filesystem: /include, /lib, …
)
```

Note that the sysroots should **not** be visible to or written into the main filesystem. Note that `OverlayFileSystem` might copy files on write or create marker files on rename: this behaviour is expected and acceptible since toolchains will rarely modify their sysroots. When in doubt, just trust whatever the `OverlayFileSystem` does (ideally, no additional logic will be necessary).

## Toolchain Optimizations

With the engine rewrite, there are a number of important optimizations that should considerably help with the latency of compiling and running code. These optimizations particularly apply to compiled languages, although some (such as module resolution) should apply to all of them. Implement these optimizations in the simplest way possible, with no changes to the library interface.

### Module Resolution

A WASI binary must first be downloaded from the network and compiled into a WASM module before it can be run. The library should ensure module re-use in two ways:

1. Across sessions, for a given URL, the binary should not be re-downloaded. Once a toolchain has been downloaded, it should be cached by the browser to avoid the latency of a redownload. We will control versioning of toolchain artifacts via URL rewrites (we control the version of these binaries). Using `{ cache: "force-cache" }` should be sufficient.
2. Within a given session, we should cache WASM module compilation. Prefer sending modules via `postMessage` once they have been compiled rather than re-compiling.

To be clear, this only needs to be done when fetching modules from the web. Dynamically generated WASM binaries from user code may be recompiled as needed.

### Sysroot Caching

It should be possible to avoid downloading/loading the same toolchain sysroot more than once. We should, at the very least, avoid re-downloading by employing `force-cache` as described above. If we are able to represent sysroots as a secondary mount in the Wasmer overlay filesystem, then there should be a creative way to re-use a sysroot that has already been created and mount it into the overlay filesystem. Ideally, sysroot initialization becomes a zero-copy operation.

### Parallel Compilation

If multiple sources need to be compiled, compile them in parallel by spawning additional workers, up to `navigator.hardwareConcurrency`. This motivates the idea of having a pool of workers that are ready to do work. Workers should be spawned lazily as the number of sources requires. Workers should be re-used: a worker that finishes running a binary should not be dismantled, but rather used for another upcoming operation. Each worker is thus a stateless executor waiting to receive work to be done. If a worker crashes due to an unrecoverable error, it should be terminated and replaced (lazily, i.e. when a worker is next needed) with another worker. Alternatively, if an ongoing worker must be killed due to `kill()` being called on a process using it, it should similarly be terminated and replaced (lazily).

Note: you should not implement subprocess support in the Wasmer sense (i.e. support for `posix_spawn` and `fork`-style syscalls). It is fine if the main thread becomes the principal orchestrator of work, and the worker threads operate on top of a lightweight shared filesystem. You should keep the worker logic and orchestration logic simple and well-defined.

### Compilation Caching

> Only implement this optimization for the `cpp` toolchain.

Implement simple compilation caching using compiler-emitted (`-MMD`) dependency files (e.g. `/build/main.cpp.d`) and file hashes. In particular, only recompile a source if it is stale. A source is stale when its object file or `.d` file is missing, or when the source or any header listed in its `.d` file is missing or has a file hash different from when it was last compiled. To keep track of file hashes, extend the compiler's `.d` file with information about the file hashes, such that a e.g. `main.cpp.d` might look like:

```Makefile
main.cpp.o: main.c util.h config.h
main.c: {hash of main.c}
util.h: {hash of util.h}
config.h: {hash of config.h}
```

The advantage of this approach is that it requires no additional data structures: all information about whether a source needs to be compiled can be found just by looking at the filesystem.

## Processes

### Debugging

Do not change the core debugging logic or code. For example, the core DWARF parsing code and instrumentation code should not fundamentally be changed.

### Toolchains

Right now, the library defines only three toolchains: `cpp`, `rust` and `python`. However, we may desire to add additional toolchains add a later date. As a result, the implementations of the toolchains should not be overly hardcoded or fixed to the given ones, but engineered in an extensible way.
