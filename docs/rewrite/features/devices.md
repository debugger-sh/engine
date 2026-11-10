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

where `dev1` and `dev2` are devices, as explained below. Devices are registered with arbitrary paths in the filesystem. When `cmd` interfaces with `/dev/gfx` or `test_dev` via the filesystem, they will interact with the device instead. Devices always take precedence over the filesystem: if there happens to be a file named `/dev/gfx` or `test_dev`, they will get shadowed by the device.

## Device Types

Two kinds of devices will be supported for now for simplicity.

```ts
interface BaseOptions {
  /* ... */
  devices: Record<string, Device>;
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
   * If the pipe is closed and there is no buffered data, the result will be empty.
   */
  read(): Promise<Uint8Array>;

  /** Yields each chunk read until end-of-file. */
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array>;

  /** Whether `close()` has been called. */
  readonly closed: boolean;
}

interface Writable {
  /**
   * Writes a chunk. Waits while the pipe is full, and resolves once every byte
   * is buffered (not once it has been read). Throws if `close()` was called.
   */
  write(chunk: Uint8Array | string): Promise<void>;

  /** The host stops writing. Writing again throws. */
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
   * Continuously discard the output of this pipe.
   *
   * This is equivalent to calling `read()` in a loop until EOF.
   */
  discard(): void;
}
```

As you can infer from the above, a process may read or write to a pipe such that reads will read its own data. This kind of access pattern is usually not what you want (usually only the host reads and only the guest writes, or vice versa), but this behaviour is not constrained by the library.

Also note that the pipe lifetime is independent from the process lifetime. That is, a pipe can be instantiated independently from a process, shared by multiple processes, etc. Pipes also do not reset either from process to process, such that one process could write to a pipe, and the next could read data written by the previous process, etc.

Note that pipes also support observing their output via callbacks like `pipe.on("data", chunk => /* ... */)`. `on` **does not** affect the state of a pipe (it does not read from the pipe). However, when `read` resolves with non-empty data, `on` fires to anyone who is listening on the pipe.

One note

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

This will also change the process slightly:

```ts
interface Process {
  /* ... */

  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
}
```

By default, processes that were spawned without explicitly configuring `stdout`/`stderr` will have no readers, and therefore programs that write enough output will eventually block while waiting for a reader on the other end to consume from the buffer. For that reason, and only in the case that `BaseOptions` was not manually configured, the default behaviour of `stdout` and `stderr` is to call `discard` on the pipe used by these processes. Listeners to `stderr` and `stdout` can still listen to any bytes read via `on("data")`.

### SharedArrayBuffer

For explicit access to shared memory, a `SharedArrayBuffer` can be passed as a device. This enables a read-write block of memory to be configured. Atomic access is not guaranteed to this buffer, and system calls do the most sensible thing (e.g. `stat` returns a size that matches the size of the buffer in byte, `read` and `write` allow direct access to the buffer). This kind of device would enable frame buffers, and other more sophisticated device drivers, to be built on top of. One could also imagine the consumer of the library implementing their own version of `Pipe` on top of a circular buffer backed by a `SharedArrayBuffer`.
