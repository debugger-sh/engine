# Library Rewrite – Implementation

This document serves to flesh out implementation decisions as part of the library rewrite, beyond just the interface.

As a general principle, the three priorities of the rewrite are:

- **Simplicity.** Implementations should not be more complex than they need to be. Elegant, simple solutions that ignore rare edge cases are preferred to complex ones that address every edge case.
- **Speed.** The ability to compile, execute, and debug files quickly is a core aim of the library. Implementations should be done in a way that respects that. For example, true in-memory sharing of files is preferred to an RPC style approach that would introduce latency.
- **Correctness.** The library must be bug-free. In practice, this means that we must have a comprehensive suite of test cases that check the correctness of the implementation.

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

### Handling sysroots

Currently, the library unions the serialized user filesystem snapshot with the downloaded sysroot. This approach will not work with the new shared filesystem. During execution of a command, the sysroot should be treated as an overlay filesystem, so that the sysroot contents are visible locally to the executing toolchain but not to the outside world. Essentially, this looks like:

```rs
OverlayFileSystem::new(
  workspace.clone(),   // Shared filesystem (e.g. /main.cpp, /a.out, etc.)
  [sysroot.clone()],   // Sysroot filesystem: /include, /lib, …
)
```
