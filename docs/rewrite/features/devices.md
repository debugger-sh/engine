# Devices

Right now, there are two main ways for a process to communicate with the host: over standard IO, and via the filesystem. I would like introduce a third way: devices.

Devices will be a small, process-local extension to the filesystem that allows communicating over a shared channel with the host. These can be thought of as device drivers that the guest process interacts with via the filesystem, and through which the main thread can communicate with the guest program. Devices can be configured via a new `devices` option in `run()`:

```ts
const proc = engine.run('cmd', {
  devices: {
    '/dev/gfx': dev1,
    test_dev: dev2
  }
});
```

where `dev1` and `dev2` are devices, as explained below. Devices are registered with arbitrary paths in the filesystem. When `cmd` interfaces with `/dev/gfx` or `test_dev` via the filesystem, they will interact with the device instead. Devices always take precedence over the filesystem: if there happens to be a file named `/dev/gfx` or `test_dev`, they will get shadowed by the device. Importantly, devices are **not** stored as part of the filesystem: each process has a local table of devices. Devices can be created under any path, even if its parent directories do not exist; creating such a device does **not** modify the filesystem to create intermediate directories.

## Device Types

Two kinds of devices will be supported for now for simplicity.

```ts
interface BaseOptions {
  /* ... */
  devices?: Record<string, Device>;
}

type Device = Pipe | SharedArrayBuffer;
```

### Pipes

A pipe is a one-way communication interface that behaves in exactly the same way as `stdin` currently does. It is a buffered byte-stream built on top of a circular buffer which can be written to and read from indiscriminately. For example:

```ts
const pipe = new Pipe();
const proc = engine.run('cmd', {
  devices: { '/dev/test': pipe }
});

await pipe.write('hello world!'); // Writes UTF8 bytes

// ... now `proc` can read "hello world!" from /dev/test,
// or alternatively, we can read it as shown below ...

const chunk = await pipe.read();
console.log(new TextDecoder().decode(chunk));

// Assuming that `proc` did not read from the pipe, the above
// would output "hello world!" to the console
```

The full interface of `Pipe` is:

```ts
interface Readable
  extends AsyncIterable<Uint8Array>, EventEmitter<{ data: [Uint8Array]; end: [] }> {
  /**
   * Resolves with the next bytes available.
   * Will wait until bytes are available or EOF is reached.
   * If the stream is closed and there is no buffered data, the result will be empty.
   */
  read(): Promise<Uint8Array>;

  /**
   * Asynchronously reads each chunk until end-of-file.
   *
   * This effectively calls `read` in a loop.
   */
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array>;

  /**
   * Asynchronously reads each line until end-of-file.
   *
   * Each string returned will have its final newline removed.
   *
   * This effectively calls `read` in a loop.
   */
  lines(): AsyncIterable<string>;

  /** Whether `close()` has been called. */
  readonly closed: boolean;
}

interface Writable {
  /**
   * Writes a chunk. Waits while the internal buffer is full, and resolves once every byte
   * is buffered. Throws if `close()` was called.
   */
  write(chunk: Uint8Array | string): Promise<void>;

  /** Close the stream for writing. Attempting to write again throws. */
  close(): void;
}

interface PipeOptions {
  /**
   * The number of bytes this pipe's underlying buffer should be created with.
   *
   * Defaults to 4096 (4 KiB).
   */
  capacity?: number;
}

export class Pipe implements Readable, Writable {
  constructor(options?: PipeOptions);

  /**
   * Enables flowing mode for this pipe. By default, pipes start out in
   * "paused" mode, where bytes must be explicitly consumed by calling `read`.
   *
   * In flowing mode, bytes are automatically consumed by the pipe and forwarded
   * to any consumers, whether event listeners or calls to `read()`.
   *
   * Note that flowing mode is the default for `stdout` and `stderr`
   * when not setting up your own `stdout` and `stderr`.
   */
  flow(): void;
}
```

As you can infer from the above, a process may read or write to a pipe such that reads will read its own data. This kind of access pattern is usually not what you want (usually only the host reads and only the guest writes, or vice versa), but this behaviour is not constrained by the library.

Also note that the pipe lifetime is independent from the process lifetime. That is, a pipe can be instantiated independently from a process, shared by multiple processes, etc. Pipes also do not reset either from process to process, such that one process could write to a pipe, and the next could read data written by the previous process, etc.

Note that pipes also support observing their output via callbacks like `pipe.on("data", chunk => /* ... */)`. `on` **does not** affect the state of a pipe (it does not read from the pipe). However, when `read` resolves with non-empty data, `on` fires to anyone who is listening on the pipe. `end` fires when the stream is closed and there is no data remaining in the buffer.

### Flowing Mode

A pipe can either be in "paused mode" (the default for user-created pipes) or "flowing mode" (the default for library-created stdio pipes). A paused pipe can transition to flowing mode by calling `flow` on it.

In flowing mode, an internal loop continuously reads from the ring buffer. When data arrives, any waiters on `read` resolves with the received data, and any listeners to `data` or `end` fire.

#### Implications for Standard IO

Standard I/O should be implemented in terms of pipes. The current interface should be preserved, but the underlying implementation should be built on top of pipes. The `BaseOptions` should therefore support:

```ts
interface BaseOptions {
  /* ... */
  stdin?: Pipe;
  stdout?: Pipe;
  stderr?: Pipe;
}
```

so that processes I/O can be wired together like so:

```ts
const pipe = new Pipe();
const p1 = engine.run('cmd1', { stdout: pipe });
const p2 = engine.run('cmd2', { stdin: pipe });
```

This will also change the process interface slightly. The stdio of each process will be exposed as a pipe, cast as either the `Readable` or `Writable` variant.

```ts
interface Process {
  /* ... */

  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
}
```

By default, processes that were spawned without explicitly configuring `stdout`/`stderr` will have no readers, and therefore programs that write enough output will eventually block while waiting for a reader on the other end to consume from the buffer. For that reason, and only in the case that `BaseOptions` was not manually configured, the default behaviour of `stdout` and `stderr` is to call `flow` on the pipe used by these processes (this is handled separately for each stream). Listeners to the default `stderr` and `stdout` can still listen to bytes read e.g. via `on("data")`.

It is intended that the creator of a pipe is responsible for closing it. Pipes created externally and passed to the engine should be closed after they are done to avoid infinite reading loops. Pipes created internally by the engine for the default `stdout` and `stderr` will be automatically closed when the process exits.

For device pipes, processes can indiscriminately read and write to a pipe, potentially seeing its own data. The one exception is standard IO: these system calls should not allow a process to e.g. read from its own stdout, or write to its own stdin. This should be handled directly as an edge case in the implementation of the Wasmer `VirtualFile` needed for devices.

A consequence of this design is that `stdout` and `stderr` may be interleaved in a way that does not preserve their relative ordering. That is an acceptable (and realistic) consequence of this design.

### SharedArrayBuffer

For explicit access to shared memory, a `SharedArrayBuffer` can be passed as a device. This enables a read-write block of memory to be configured. Atomic access is not guaranteed to this buffer, and system calls do the most sensible thing (e.g. `stat` returns a size that matches the size of the buffer in byte, `read` and `write` allow direct access to the buffer). This kind of device would enable frame buffers, and other more sophisticated device drivers, to be built on top of. One could also imagine the consumer of the library implementing their own version of `Pipe` on top of a circular buffer backed by a `SharedArrayBuffer`.

## Implementation Details

This change should not significantly complicate the library, and should actually remove/consolidate some of the existing parts of the library. For example, the core circular buffer of `stdin`, rather than being reimplemented, will become the core mechanism behind a pipe. There will not be a separate device file for Python debugging: that will be handled via device pipes (probably two of them) specifically for debugging.

For toolchains, devices are only passed to the final step (the user program), not the compiler/linker.

For now, we should use the same SPSC queue currently implemented by `stdin`. I am fully aware that this will race if there are multiple writers or multiple readers, and I accept that risk. Eventually, the library can be extended to support multiple readers and writers by locking.
