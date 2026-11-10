# Library Rewrite

We would like to rewrite the library to have a more ergonomic interface. This document serves to explain the new interface; implementation can be described in another document.

## Lifecycle

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

Once finished, the caller should `dispose` of the engine to release any resources it holds. This causes any running processes to be killed and any waiters to resolve, just like `proc.kill()`.

```ts
/**
 * Kills any running processes and releases any memory the engine holds on to.
 *
 * After calling this method, further attempts to interact with the engine will throw an error.
 */
engine.dispose();
```

## Filesystem

The new engine filesystem is a shared, in-memory filesystem. Whereas the previous filesystem was a simple object that was serialized and sent to the worker, the new filesystem is shared simultaneously by all concurrent processes, such that both the processes and the main thread can simultaneously modify the filesystem and observe the results immediately.

### Mounting a filesystem

To quickly populate the contents of a filesystem, we can use `mount`.

```ts
await engine.fs.mount({
  'main.cpp': {
    contents: '#include <stdio>',
    created: '2026-11-01T09:00:00Z',
    modified: '2026-11-09T12:00:00Z'
  },
  'uti.h': '#include <string>',
  data: {
    files: {
      'res.txt': 'Jacob\nFabio\nYousef'
    }
  }
});
```

`mount` provides an optional argument that allows us to specify the location of the mount point (it defaults to `"/"`):

```ts
// These two calls are identical
await engine.fs.mount(/* Filesystem */);
await engine.fs.mount(/* Filesystem */, { at: "/" });
```

`mount` additively injects files (it never removes files which already exist). If `mount` includes a file which conflicts with an existing one, `mount` overrides it.

`mount` supports simple file trees, tarballs, zips, and URLs. The full TypeScript interface is shown below:

```ts
/**
 * A file timestamp. Either an ISO 8601 string, a Date, or a milliseconds epoch.
 */
type Timestamp = string | Date | number;

/**
 * The timestamps of a file. Only files carry timestamps (`created` cannot be set yet).
 *
 * If a timestamp is not specified, it defaults to the current time.
 */
type Timestamps = {
  accessed?: Timestamp;
  modified?: Timestamp;
  created?: Timestamp;
};

/**
 * The contents of a file, either as bytes or a UTF-8 encoded string
 */
type FileContents = Uint8Array | string;

/**
 * A representation of a file, either as its contents or as its contents and metadata.
 *
 * `encoding` determines the encoding of string-valued `contents`, and defaults to `utf8`.
 */
type File = FileContents | (Timestamps & { contents: FileContents, encoding?: 'base64' | 'utf8' });

/**
 * A representation of a directory.
 */
type Directory = { files: FileTree };

/**
 * A tree of files in the filesystem.
 */
type FileTree = { [name: string]: File | Directory };

/**
 * Unions a representation of a filesystem into this one.
 *
 * `fs` can be a:
 *
 *  1. FileTree:    a simple representation of a filesystem to be unioned.
 *  2. Uint8Array:  the bytes of a tarball (.tar.gz) or zip to be unioned.
 *  2. string:      a URL to a tarball or zip to be fetched and unioned.
 *
 * `at` can be specified to optionally determine the root folder in the filesystem
 * whose contents will be unioned.
 */
fs.mount(fs: FileTree | Uint8Array | string, options?: { at?: string }): Promise<void>;
```

### Exporting a filesystem

A filesystem can also be exported to produce the same shape expected by `mount`. E.g.

```ts
// a FileTree
const tree = await engine.fs.export();

// a .tar.gz file (Uint8Array)
const tarball = await engine.fs.export({ format: 'tar' });

// the contents of the `build` folder as a zip archive (Uint8Array)
const buildZip = await engine.fs.export({ at: '/build', format: 'zip' });
```

The full TypeScript interface for `export` is shown below:

```ts
type ExportOptions = {
  /**
   * The format to export to. Defaults to "tree"
   *
   * If `tree` is selected, the exported object is JSON and includes maximal information
   * (binary files encoded as base-64 strings, file timestamps included).
   */
  format?: "zip" | "tarball" | "tree";

  /** The directory to be exported. Defaults to "/" */
  at?: string;

  /**
   * Glob patterns to include in the export, evaluated relative to `at`.
   *
   * Defaults to all files (["**\*"])
   */
  include?: string[];

    /**
   * Glob patterns to exclude in the export, evaluated relative to `at`.
   *
   * Defaults to no files ([])
   */
  exclude?: string[];
}

fs.export(options?: undefined): Promise<FileTree>;
fs.export(options: ExportOptions & { format: "zip" | "tarball" }): Promise<Uint8Array>;
fs.export(options: ExportOptions & { format: "tree" }): Promise<FileTree>;
```

### File I/O

We can read files with the following methods:

```ts
readFile(path: string, encoding: 'utf8'): Promise<string>;
readFile(path: string): Promise<Uint8Array>;
```

Support for additional encodings may be considered later.

We can write files using:

```ts
writeFile(path: string, contents: string | Uint8Array): Promise<void>;
```

For example:

```ts
const data = await engine.fs.readFile('/data/res.txt');
await engine.fs.writeFile('/data/res.copy.txt', data);
```

### Other file operations

The following other file operations are supported:

```ts
interface FileStat {
  kind: "file" | "directory";
  size: number;
  modified: number;
  accessed: number;
  created: number;
}

mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
remove(path: string, options?: { recursive?: boolean }): Promise<void>;
rename(from: string, to: string): Promise<void>;
stat(path: string): Promise<FileStat>;
readDir(path: string): Promise<string[]>; // List of file names
```

### Support for relative paths

The old version of this library may not have supported relative paths. For example, trying to read from `data.txt` may have thrown an error. The new version should support such paths.

This is true for all filesystem operations, whether inside the guest program or in the main thread JS API. The JS API should treat relative paths as relative to the root folder of the engine, such that `data.txt` and `/data.txt` refer to the same file.

## Processes

This will be the most significant rewrite of the engine library. Previously, the `run()` method would have exclusive control of the engine (i.e. in order to call `run()` again, the previous call would either need to finish or be explicitly stopped). Furthermore, the effect of calling `run()` would depend on which language toolchain is being used (depending on which language is selected, either the C/C++, Rust, or Python toolchains would be invoked). In the new version, we will scope execution of a toolchain to a specific "process" in a way that allows multiple processes to be invoked simultaneously.

### Running processes

Processes can be instantiated with the following overloads:

```ts
run<C extends CommandLike>(command: C, options: CommandOptions<C> & { debug: true }): DebuggableProcess;
run<C extends CommandLike>(command: C, options?: CommandOptions<C>): Process;
run<C extends CommandLike>(command: C, args: string[], options: CommandOptions<C> & { debug: true }): DebuggableProcess;
run<C extends CommandLike>(command: C, args: string[], options?: CommandOptions<C>): Process;
```

with the following helper types:

```ts
interface Process extends PromiseLike<ProcessResult> {
  readonly stdin: Stdin;
  readonly stdout: Stdout;
  readonly stderr: Stdout;

  /**
   * The debugger for this process. Present only if `debug: true` was passed.
   */
  readonly debugger?: Debugger;

  /**
   * Immediately kills this process.
   */
  kill(): void;
}

/**
 * A process spawned with `debug: true`.
 */
interface DebuggableProcess extends Process {
  readonly debugger: Debugger;
}

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
   * Environment variables to supply to the command.
   * For toolchains/subprocesses, this will be shared by all steps.
   */
  env?: Record<string, string>;

  /**
   * The sysroot to use while running this command.
   *
   * Sysroots are default filesystems that are invisibly unioned into the
   * main filesystem before running the command, and are only visible to this command.
   *
   * This can be either a toolchain (like "cpp" or "python"), in which case the
   * default sysroot for that toolchain will be used, or a URL to a tarball (.tar.gz)
   * or zip archive (.zip) to be downloaded as the sysroot.
   *
   * By default, when running a toolchain, the toolchain sysroot is used.
   */
  sysroot?: Toolchain | (string & {});

  /**
   * Whether to allow debugging this process.
   *
   * Defaults to `false`. If `false`, `proc.debugger` is `undefined`.
   */
  debug?: boolean;
}

interface PythonOptions {
  /**
   * See the existing usage of this option.
   * Note that this is moved from the existing debugger interface.
   */
  filterInternals?: boolean;

  /**
   * Whether to run an interactive REPL when no `args` are given.
   *
   * Defaults to `false`.
   */
  repl?: boolean;
}

interface CppOptions {
  /**
   * List of file globs, evaluated relative to `/`, for determining C/C++ sources to compile.
   *
   * Defaults to `["**\*.{c,cc,cp,cpp,cxx,c++}"]`
   */
  sources?: string[];

  /**
   * The directory where object files and compiled executables will be placed.
   *
   * Defaults to `/build`
   */
  buildDir?: string;

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
   * List of file globs, evaluated relative to `/`, for determining Rust sources to compile.
   *
   * Defaults to `["**\*.rs"]`
   */
  sources?: string[];

  /**
   * The directory where object files and compiled executables will be placed.
   *
   * Defaults to `/build`
   */
  buildDir?: string;

  /**
   * Additional flags to apply when invoking `rustc`.
   */
  rustFlags?: string[];
}
```

Note: processes begin to run as soon as they are instantiated (with a caveat for processes in debug mode, see more details below).

#### Command resolution order

To avoid ambiguity, treat `command` as:

1. A WASI executable to be downloaded if it is a URL (starts with `http://` or `https://`).
2. A WASI executable to be loaded from the filesystem if it is an absolute path (e.g. `/main`) or `.`-prefixed path relative to `/` (e.g. `./main`).
3. A toolchain or built-in command, if any (e.g. `clang++` or `python`).

Note that there is no ambiguity between (2) and (3): (2) requires an absolute path or `.` path for an executable to be loaded from the filesystem.

#### Argument semantics

For regular WASI programs, `args` is treated directly as the arguments array passed to the program. For language toolchains, which represent a sequence of several build steps, the meaning of `args` may have a special contextual meaning, as described below.

##### `cpp`

If the user program is successfully produced (compiled, linked, and possibly instrumented), `args` is forwarded to that user program to serve as its arguments array.

##### `rust`

Same behaviour as `cpp`.

##### `python`

If `args` are given, they are forwarded perfectly to the `python` binary. Otherwise, the first (alphabetical) Python file in the filesystem is run, or the process exits with a non-zero exit code if none is found. If `repl: true` is set (and no `args` are given), an interactive REPL is run instead.

### Waiting for a process to complete

Processes are thenable and implement `then` so they can be awaited like a promise and return a `ProcessResult`.

```ts
const result = await engine.run('cpp');
console.log(result); // { exitCode: 0, killed: false }

interface ProcessResult {
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

A process can be killed at any time via the `kill()` method. This causes anyone awaiting the process to immediately wake up with a `killed` process result, and functions similarly to the existing `stop()` method:

```ts
const proc = engine.run('cpp');

/* Some time passes... */

proc.kill();
```

If a process is killed, the resulting exit code will be 137 to mirror the Unix style `SIGKILL` exit code.

### Error handling

Under ordinary circumstances, processes do not trigger exceptions during their lifecycle. The only time that awaiting a process would trigger an exception is through an unexpected library error.

The following common errors should cause a non-zero exit code and output to `stderr`:

| Error                                                   | Exit Code | `stderr`                          |
| ------------------------------------------------------- | --------- | --------------------------------- |
| Unknown or missing command                              | `127`     | `{cmd}: command not found`        |
| Network error while fetching a command or its `sysroot` | `127`     | `{cmd}: network error ({status})` |
| Invalid WASI binary or directory                        | `126`     | `{cmd}: cannot execute`           |
| Guest WASI has an error                                 | `134`     | `{cmd}: {message}`                |

If the host (library) Wasm has an error, that should cause the process promise to reject.

### Process I/O

Each process object provides the `stdin`, `stdout`, and `stderr` objects, which are similar to their existing counterparts. The interface looks like:

```ts
/**
 * Note that for toolchains which run multiple steps,
 * stdin/stdout/stderr are shared among all steps, as before.
 *
 * For example, a single chunk of stdin could be partially eaten by the compiler/linker;
 * the remaining portion would be passed onto the user program.
 */
const proc = engine.run('cpp');
console.log(proc.stdin.closed); // false

/** Write chunks and close stream */
await proc.stdin.write('CS198!');
proc.stdin.close();
console.log(proc.stdin.closed); // true

/** Listen for incremental output */
proc.stdout.on('data', (chunk) => terminal.write(chunk));
```

### Debugging a process

The existing debugger interface is preserved, but each call to `run` creates a new `Debugger` instance tied to that process. Ordinarily, processes will make forward progress after `run` is called; however, in the case that debugging is enabled, they will only make progress pending the completion of the DAP handshake.

```ts
const proc = engine.run('cpp', { debug: true });

/** Setup callbacks for handling DAP events */
proc.debugger.on('event', (msg) => {
  /* ... */
});

/** Send DAP initialize request */
proc.debugger.send({ type: 'request', command: 'initialize' /* ... */ });
```

As is currently the case, the debugger for a compiler-enabled toolchain (e.g. C/C++, Rust) debugs only the execution step in a toolchain (i.e. the user's code). For a process without `debug: true`, `proc.debugger` is `undefined`.

If `debug: true` is enabled for a non-toolchain command (e.g. an arbitrary WASI executable), debugging will proceed as if the executable had been produced by a compiler toolchain. That is, these executables will be debugged via DWARF inspection and WASM instrumentation. Assume that the provided executable has debug info, i.e. the DWARF exists in the same location in the binary as if it were produced by a compiler/linker toolchain.

## Toolchains

### Object Files

For C/C++ and Rust, object files should be built into the `buildDir` specified in the command options. For example, if `/dir/main.cpp` is a source and `buildDir` is `/build`, then the object file will be compiled to `/build/dir/main.cpp.o`. Output executables should be placed directly into `buildDir` and are always named `main` (i.e. `/build/main`).

### Export individual toolchain steps

`run("cpp")` and `run("rust")` can be thought of as mini-build systems that do the barebones needed to compile, link and run a piece of code. However, users who want to engineer their own build systems should have the ability to run the individual steps as well. For instance, a user should be able to compile, link, and run a file like so:

```ts
await engine.run(
  'clang++',
  [
    /* compiler args */
  ],
  { sysroot: 'cpp' }
);

// Could also have done:
//
//  await engine.run("clang", [/* compiler args */]);
//  await engine.run("rustc", [/* compiler args */]);
//

await engine.run('lld', [/* compiler args */ '-o', '/main'], { sysroot: 'cpp' });
await engine.run('/main');
```

> Note that the `sysroot` option would need to be supplied to configure a sysroot to
> use for each command (or the user could configure the sysroot manually).

As a result, `run` has a hardcoded list of supported commands:

- **`cpp`**: A simple C++ toolchain and build system which compiles, links, runs, and optionally debugs C++ programs according to `CppOptions`.
- **`rust`**: A simple Rust toolchain which compiles, links, runs, and optionally debugs Rust programs according to `RustOptions`.
- **`python`**: A simple Python toolchain which interprets and optionally debugs Python programs.
- **`clang++`**, **`clang`**: The Clang compiler.
- **`rustc`**: The Rust compiler.
- **`lld`**: The LLVM linker.
