# Library Rewrite

We would like to rewrite the library to have a more ergonomic interface. This document serves to explain the new interface; implementation can be described in another document.

## Initialization

The engine represents a workspace which can be shared by concurrent processes which operate on it.

```ts
/**
 * Creates an engine.
 *
 * Note that this is an async function as it may need to do some initialization of WASM modules, etc.
 *
 * Update: This method no longer accepts a language parameter, as language is no longer a property
 * of the engine.
 */
const engine = await Engine.create();
```

## Filesystem

The new engine filesystem is a shared, in-memory filesystem. Whereas the previous filesystem was a simple object that was serialized and sent to the worker, the new filesystem is shared simultaneously by all concurrent processes, such that both the processes and the main thread can simultaneously modify the filesystem and observe the results immediately.

### Mounting

To quickly populate the contents of a filesystem, we can mount it. This provides, among other things, the same interface as the previous version of the library.

```ts
await engine.fs.mount('/', {
  'main.cpp': '#include <stdio>',
  data: {
    'res.txt': 'Jacob\nFabio\nYousef'
  }
});
```

`mount` provides an overload that allows us to specify the location of the mount point (which defaults to `"/"`):

```ts
// These two calls are identical
await engine.fs.mount(/* Filesystem */);
await engine.fs.mount('/' /* Filesystem */);
```

`mount` additively injects files (it never removes files which already exist).

### File I/O

We can read files with the following methods:

```ts
readFile(path: string): Promise<Uint8Array>;
readText(path: string): Promise<string>;      // Read as UTF-8
```

Support for additional encodings may be considered later.

We can write files using:

```ts
write(path: string, contents: string | Uint8Array): Promise<void>;
```

For example:

```ts
const data = await engine.fs.readFile('/data/res.txt');
await engine.fs.write('/data/res.copy.txt', data);
```

### Other file operations

The following other file operations are supported:

```ts
interface FileStat {
  kind: "file" | "directory";
  size: number;
}

interface DirectoryEntry extends FileStat {
  name: string;
}

mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
remove(path: string, options?: { recursive?: boolean }): Promise<void>;
rename(from: string, to: string): Promise<void>;
stat(path: string): Promise<FileStat>;
readDir(path: string): Promise<DirectoryEntry[]>;
```

## Processes

This will be the most significant rewrite of the engine library. Previously, the `run()` method would have exclusive control of the engine (i.e. in order to call `run()` again, the previous call would either need to finish or be explicitly stopped). Furthermore, the effect of calling `run()` would depend on which language toolchain is being used (depending on which language is selected, either the C/C++, Rust, or Python toolchains would be invoked). In the new version, we will scope execution of a toolchain to a specific "process" in a way that allows multiple processes to be invoked simultaneously.

### Running processes

Processes can be instantiated with the following overloads:

```ts
run<C extends CommandLike>(command: C, options?: CommandOptions<C>): Process;
run<C extends CommandLike>(command: C, args: string[], options?: CommandOptions<C>): Process;
```

with the following helper types:

```ts
/**
 * A command to run. This will be interpreted as either a language toolchain name or
 * a WASI executable (either raw bytes, a URL to fetch, or a path within the workspace).
 */
type CommandLike = Uint8Array | string | Toolchain;

/**
 * A language toolchain to run.
 *
 * Running these will be treated as one process even though they logically
 * comprise multiple subprocesses (e.g. compiling, linking, executing).
 */
type Toolchain = keyof ToolchainOptionsMap;

/**
 * Toolchains may allow supplying toolchain-specific options.
 */
type CommandOptions<C extends CommandLike> = C extends Toolchain
  ? BaseOptions & ToolchainOptionsMap[C]
  : BaseOptions;

interface ToolchainOptionsMap {
  python: PythonOptions;
  cpp: CppOptions;
  rust: RustOptions;
}

interface BaseOptions {
  /**
   * Absolute path to a directory to run this command from.
   */
  cwd?: string;

  /**
   * Environment variables to supply to the command.
   * For toolchains/subprocesses, this will be shared by all steps.
   */
  env?: Record<string, string>;

  /**
   * Whether to allow debugging this process.
   *
   * Defaults to `false`. If `false`, accesses to `process.debugger` will no-op.
   */
  debug?: boolean;
}

interface PythonOptions {
  /**
   * See the existing usage of this option.
   * Note that this is moved from the existing debugger interface.
   */
  filterInternals?: boolean;
}

interface CppOptions {
  /**
   * List of file globs for determining C/C++ sources to compile.
   *
   * Defaults to `["**\*.{c,cc,cp,cpp,cxx,c++}"]`
   */
  sources?: string[];

  /**
   * Additional flags to apply when invoking the compiler.
   */
  cxxFlags?: string[];

  /**
   * Additional flags to apply when invoking the linker.
   */
  lldFlags?: string[];
}

interface RustOptions {
  /**
   * List of file globs for determining Rust sources to compile.
   *
   * Defaults to `["**\*.rs"]`
   */
  sources?: string[];

  /**
   * Additional flags to apply when invoking `rustc`.
   */
  rustFlags?: string[];
}
```

Note: processes begin to run as soon as they are instantiated (with a caveat for processes in debug mode, see more details below).

#### Argument semantics

For regular WASI programs, `args` is treated directly as the arguments array passed to the program. For language toolchains, which represent a sequence of several build steps, the meaning of `args` may have a special contextual meaning, as described below.

##### `cpp`

If the user program is successfully produced (compiled, linked, and possibly instrumented), `args` is forwarded to that user program to serve as its arguments array.

##### `rust`

Same behaviour as `cpp`.

##### `python`

No special handling is applied to `args`: it is forwarded perfectly to the `python` binary.

### Waiting for a process to complete

Processes are then-able objects, so they can be awaited just like a promise and return a `ProcessResult`.

```ts
const result = await engine.run('cpp');
console.log(result); // { exitCode: 0, killed: false }

class ProcessResult {
  /**
   * The exit code of the process.
   *
   * For toolchains that invoke multiple steps, this will be the first non-zero
   * exit code if any intermediate steps fail.
   */
  exitCode: number;

  /**
   * Whether or not the process was killed.
   */
  killed: boolean;
}
```

Notice that under ordinary circumstances, processes do not trigger exceptions during their lifecycle. The only time that awaiting a process would trigger an exception is through an unexpected library error.

A process can be killed at any time via the `kill()` method. This causes anyone awaiting the process to immediately wake up with a `killed` process result, and functions similarly to the existing `stop()` method:

```ts
const process = engine.run('cpp');

/* Some time passes... */

process.kill();
```

### Process I/O

Each process object provides the `stdin`, `stdout`, and `stderr` objects, which are similar to their existing counterparts. The interface looks like:

```ts
/**
 * Note that for toolchains which run multiple steps,
 * stdin/stdout/stderr are shared among all steps, as before.
 */
const process = engine.run('cpp', { stdin: true });
console.log(process.stdin.closed); // false

/** Write chunks and close stream */
await process.stdin.write('CS198!');
process.stdin.close();
console.log(process.stdin.closed); // true

/** Listen for incremental output */
process.stdout.on('data', (chunk) => terminal.write(chunk));
```

### Debugging a process

The existing debugger interface is preserved, but each call to `run` creates a new `Debugger` instance tied to that process. Ordinarily, processes will make forward progress after `run` is called; however, in the case that debugging is enabled, they will only make progress pending the completion of the DAP handshake.

```ts
const process = engine.run('cpp', { debug: true });

/** Setup callbacks for handling DAP events */
process.debugger.on('event', (msg) => {
  /* ... */
});

/** Send DAP initialize request */
process.debugger.send({ type: 'request', command: 'initialize' /* ... */ });
```

As is currently the case, the debugger for a compiler-enabled toolchain (e.g. C/C++, Rust) debugs only the execution step in a toolchain (i.e. the user's code). Access to the debugger for a process with `debug: false` will no-op.

If `debug: true` is enabled for a non-toolchain command (e.g. an arbitrary WASI executable), debugging will proceed if the executable had been produced by a compiler toolchain. That is, these executables will be debugged via DWARF inspection and WASM instrumentation.
