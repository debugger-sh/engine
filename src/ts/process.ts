import EventEmitter from 'events';

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- only referenced by {@link} in doc comments
import type { RunOptions } from '.';
import { gate_doom, gate_idle, gate_new } from '../../pkg/engine';
import type { Debugger } from './debugger';
import { internal, Internals, tick } from './util';

export interface ProcessResult {
  /**
   * The exit code of the process.
   *
   * For language toolchains that run multiple steps, this will be the first non-zero
   * exit code if any intermediate steps fail.
   */
  exitCode: number;

  /** Whether or not the process was killed by calling {@link Process.kill}. */
  killed: boolean;
}

/** The standard streams of a process, shared by all of its steps. */
export type Stdio = { stdin: Pipe; stdout: Pipe; stderr: Pipe };

/**
 * Represents a process (or collection of processes) created by an engine.
 * Await it to wait for it to finish and see its {@link ProcessResult}.
 *
 * ```ts
 * const proc = engine.run("cpp");
 * for await (const line in proc.stdout.lines()) {
 *   console.log(line);
 * }
 * const result = await proc;
 * console.log(`Finished with exit code: ${result.exitCode}`);
 * ```
 */
export class Process implements PromiseLike<ProcessResult> {
  /**
   * The process's standard input.
   *
   * By default, this is closed so that programs reading from `stdin`
   * do not hang forever. To configure it, see {@link RunOptions.stdin}.
   */
  public readonly stdin: Writable;

  /**
   * The process's standard output.
   *
   * By default, the library automatically pulls data off the stream
   * to avoid programs filling up the buffer and hanging forever.
   * To manually control reading, pass your own {@link Pipe} to
   * {@link RunOptions.stdout}.
   */
  public readonly stdout: Readable;

  /**
   * The process's standard error.
   *
   * By default, the library automatically pulls data off the stream
   * to avoid programs filling up the buffer and hanging forever.
   * To manually control reading, pass your own {@link Pipe} to
   * {@link RunOptions.stdout}.
   */
  public readonly stderr: Readable;

  /**
   * The debugging interface for this process.
   * This will only be present if `{debug: true}` was passed in the options for running the process.
   */
  public readonly debugger?: Debugger;

  /** @internal */
  readonly [Internals]: {
    /** The pipes behind `stdin`, `stdout` and `stderr`. */
    stdio: Stdio;
    /**
     * Registers a function to run if this process is killed, returning a function which
     * unregisters it. If the process has already been killed, it runs immediately.
     */
    onKill(kill: () => void): () => void;
    /** Writes a message to this process' stderr, resolving once it is written. */
    error(message: string): Promise<void>;
  };

  readonly #result: Promise<ProcessResult>;
  readonly #killers = new Set<() => void>();
  #finished = false;
  #killed = false;

  /**
   * @internal
   * Once the process exits, `pipes` are closed, and those which flow are drained.
   */
  constructor(
    key: typeof Internals,
    stdio: Stdio,
    debug: Debugger | undefined,
    body: (proc: Process) => Promise<number>,
    pipes: Pipe[] = []
  ) {
    internal(key);
    ({ stdin: this.stdin, stdout: this.stdout, stderr: this.stderr } = stdio);
    this.debugger = debug;
    this[Internals] = {
      stdio,
      onKill: (kill) => {
        if (this.#killed) kill();
        this.#killers.add(kill);
        return () => void this.#killers.delete(kill);
      },
      error: (message) => stdio.stderr.write(`${message}\n`).catch(() => {})
    };

    let kill!: (result: ProcessResult) => void;
    const killed = new Promise<ProcessResult>((resolve) => (kill = resolve));
    this.#killers.add(() => kill({ exitCode: 137, killed: true }));

    // Start the body on the next tick, so that callers can attach listeners first.
    const ran = tick().then(() => body(this));
    this.#result = Promise.race([
      ran.then((exitCode) => ({ exitCode, killed: false })),
      killed
    ]).finally(() => {
      for (const pipe of pipes) pipe.close();
      return Promise.all(pipes.map((pipe) => pipe[Internals].drained()));
    });
    this.#result.finally(() => (this.#finished = true)).catch(() => {});
  }

  then<T = ProcessResult, E = never>(
    onfulfilled?: ((value: ProcessResult) => T | PromiseLike<T>) | null,
    onrejected?: ((reason: unknown) => E | PromiseLike<E>) | null
  ): Promise<T | E> {
    return this.#result.then(onfulfilled, onrejected);
  }

  /**
   * Immediately kills this process.
   */
  kill(): void {
    if (this.#finished || this.#killed) return;
    this.#killed = true;
    for (const kill of this.#killers) kill();
  }
}

// ╭──────────────────────────────────────────────────────────────────────────╮
// │ Pipes                                                                    │
// ╰──────────────────────────────────────────────────────────────────────────╯

interface ReadableEventsMap {
  data: [Uint8Array];
  text: [string];
  end: [];
}

/**
 * The readable end of a {@link Pipe}.
 */
export interface Readable extends AsyncIterable<Uint8Array>, EventEmitter<ReadableEventsMap> {
  /**
   * Emitted when bytes are available from the stream.
   * @param chunk The available bytes.
   */
  on(event: 'data', listener: (chunk: Uint8Array) => void): this;

  /**
   * Emitted with the UTF-8 text decoded from the stream.
   *
   * This is the same as decoding the data from the "data" event in streaming mode.
   *
   * @param text The decoded text.
   */
  on(event: 'text', listener: (text: string) => void): this;

  /**
   * Emitted after the writer closes the stream.
   *
   * This is guaranteed to be called after the `data` event is emitted for the final chunk of data.
   */
  on(event: 'end', listener: () => void): this;

  /**
   * Wait for bytes to be available for reading. If there is no data available,
   * this will block until bytes become available.
   *
   * @returns A promise which resolves with the next available chunk of bytes written.
   */
  read(): Promise<Uint8Array>;

  /**
   * Asynchronously reads each chunk until the stream is closed,
   * consuming from the stream as it reads.
   *
   * This calls {@link Readable.read} in loop.
   */
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array>;

  /**
   * Asynchronously reads each line until the stream is closed,
   * consuming from the stream as it reads.
   *
   * The returned strings will have their final newline removed.
   */
  lines(): AsyncIterable<string>;

  /**
   * Whether the stream has been closed by the writer.
   */
  readonly closed: boolean;
}

/**
 * The writable end of a {@link Pipe}.
 */
export interface Writable {
  /**
   * Writes data to the stream. If there is no space remaining in the stream's internal
   * buffer, it will wait until space becomes available, and resolve once all bytes
   * have been written.
   *
   * Throws if {@link Writable.close} was previously called.
   *
   * @param chunk An array of bytes or UTF8-encoded string to write to the stream.
   * @returns A promise that resolves once the data has been written.
   */
  write(chunk: Uint8Array | string): Promise<void>;

  /**
   * Permanently closes the stream for writing.
   * Readers will be notified of the end of stream.
   */
  close(): void;

  /** Whether the stream has been closed. */
  readonly closed: boolean;
}

export interface PipeOptions {
  /**
   * The maximum number of bytes this pipe's underlying buffer is able to hold.
   *
   * Defaults to 4096 (4 KiB).
   *
   * Any non-negative value is allowed. Passing 0 results in the pipe being already closed.
   */
  capacity?: number;

  /**
   * When `true`, this pipe will automatically be closed by any process using it
   * as soon as that process finishes running.
   *
   * If set to `false`, the pipe will be kept open to allow for additional writes.
   * In this case, it is the responsibility of the pipe's creator to manually close it
   * when finished.
   *
   * Defaults to `true`.
   */
  close?: boolean;
}

/**
 * Represents a "device" that a process can interface with via the filesystem
 * to allow communicating with the outside environment or other processes.
 */
export type Device = Pipe | SharedArrayBuffer;

const HEADER = 16;
const [READ, WRITE, SEQUENCE, CLOSED] = [0, 1, 2, 3];
const encoder = new TextEncoder();

/**
 * A buffered byte stream for one-way communication between two threads.
 *
 * The canonical use case for pipes is standard IO. Internally, each process's
 * `stdin`, `stdout` and `stderr` streams are backed by pipes. In the case of
 * `stdin`, a thread (typically the browser's main thread) writes to one end
 * of the pipe, and another thread (typically a running process) reads from the
 * other end. For `stdout` and `stderr`, it is the opposite: the worker thread
 * writes while the main thread reads.
 *
 * You can override each process's standard IO streams with your own pipes,
 * or register pipes at predetermined paths before a program runs via {@link RunOptions.devices}
 * to communicate with a process beyond its standard IO. For example, the following
 * snippet shows how a Python program waits until data is written to a pipe:
 *
 * ```ts
 * const pipe = new Pipe();
 * await engine.fs.writeFile("main.py", 'print(open("/dev/in").read())');
 *
 * const proc = engine.run("python", { devices: { "/dev/in": pipe } });
 * await pipe.write("hello from the main thread");
 * pipe.close();
 *
 * for await (const line of proc.stdout.lines()) {
 *   console.log(line);
 * }
 * ```
 *
 * Pipes are intended for communication between a single reader and a single
 * writer. Nothing about the interface prevents multiple concurrent readers,
 * but know that this attempting to write to or read from the pipe concurrently
 * will cause race conditions.
 */
export class Pipe extends EventEmitter<ReadableEventsMap> implements Readable, Writable {
  /** @internal */
  readonly [Internals]: {
    buffer: SharedArrayBuffer;
    close: boolean;
    /** Resolves once a flowing pipe has ended (immediately, for a paused one). */
    drained(): Promise<void>;
  };
  readonly #header: Int32Array;
  readonly #data: Uint8Array;
  /** In flowing mode, the pending read of the internal loop, shared by every reader. */
  #next?: Promise<Uint8Array>;
  #ended = false;
  readonly #decoder = new TextDecoder();

  constructor({ capacity = 4096, close = true }: PipeOptions = {}) {
    super();
    // The ring buffer always keeps one byte empty (to distinguish full from empty).
    const buffer = new SharedArrayBuffer(HEADER + capacity + 1);
    this[Internals] = {
      buffer,
      close,
      drained: async () => {
        if (this.#next) while ((await this.read()).length);
      }
    };
    this.#header = new Int32Array(buffer, 0, 4);
    this.#data = new Uint8Array(buffer, HEADER);
    if (capacity === 0) this.close();
  }

  public get closed(): boolean {
    return Atomics.load(this.#header, CLOSED) !== 0;
  }

  public async write(value: Uint8Array | string): Promise<void> {
    const chunk = typeof value === 'string' ? encoder.encode(value) : value;
    const size = this.#data.length;
    let offset = 0;

    do {
      const sequence = Atomics.load(this.#header, SEQUENCE);
      if (this.closed) throw new Error('The pipe is closed');
      const read = Atomics.load(this.#header, READ);
      const write = Atomics.load(this.#header, WRITE);
      // One slot is always kept empty to distinguish full from empty.
      const free = (read - write - 1 + size) % size;
      if (free === 0) {
        await Atomics.waitAsync(this.#header, SEQUENCE, sequence).value;
        continue;
      }

      const count = Math.min(chunk.length - offset, free, size - write);
      this.#data.set(chunk.subarray(offset, offset + count), write);
      Atomics.store(this.#header, WRITE, (write + count) % size);
      this.#notify();
      offset += count;
    } while (offset < chunk.length);
  }

  public close(): void {
    Atomics.store(this.#header, CLOSED, 1);
    this.#notify();
  }

  public read(): Promise<Uint8Array> {
    return this.#next ?? this.#pull();
  }

  /**
   * Enables flowing mode for this pipe. By default, pipes start out in
   * "paused" mode, where bytes must be explicitly consumed by calling `read`
   * to prevent the internal buffer from filling up.
   *
   * In flowing mode, data is automatically consumed from the pipe by a continually
   * running reader and forwarded to any consumers, whether event listeners or calls to `read()`.
   *
   * Note that flowing mode is the default mode for `stdout` and `stderr`.
   * To create `stdout` and `stderr` in paused mode, create your own
   * pipes and pass them to {@link RunOptions.stdout} or {@link RunOptions.stderr}.
   */
  public flow(): void {
    if (this.#next) return;
    void (async () => {
      // The loop awaits each read before any reader does, so that it starts the next read
      // before they resume: `read()` never returns a chunk which was already read.
      while ((await (this.#next = this.#pull())).length);
    })();
  }

  public async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    for (let chunk; (chunk = await this.read()).length; ) yield chunk;
  }

  public async *lines(): AsyncIterable<string> {
    const decoder = new TextDecoder();
    let line = '';
    for await (const chunk of this) {
      const lines = (line + decoder.decode(chunk, { stream: true })).split('\n');
      line = lines.pop()!;
      yield* lines;
    }
    line += decoder.decode();
    if (line) yield line;
  }

  /** Consumes the next bytes in the buffer, waiting until some are written or the pipe is closed. */
  async #pull(): Promise<Uint8Array> {
    for (;;) {
      const sequence = Atomics.load(this.#header, SEQUENCE);
      const read = Atomics.load(this.#header, READ);
      const write = Atomics.load(this.#header, WRITE);
      if (read !== write) {
        // Only read the contiguous bytes before the buffer wraps.
        const end = read < write ? write : this.#data.length;
        const chunk = this.#data.slice(read, end);
        Atomics.store(this.#header, READ, end % this.#data.length);
        this.#notify();
        this.emit('data', chunk);
        this.#text(chunk);
        return chunk;
      }
      if (this.closed) {
        if (!this.#ended) {
          this.#text();
          this.emit('end');
          this.#ended = true;
        }
        return new Uint8Array();
      }
      await Atomics.waitAsync(this.#header, SEQUENCE, sequence).value;
    }
  }

  #text(chunk?: Uint8Array) {
    if (this.listenerCount('text')) {
      const text = this.#decoder.decode(chunk, { stream: true });
      if (text) this.emit('text', text);
    }
  }

  #notify() {
    Atomics.add(this.#header, SEQUENCE, 1);
    Atomics.notify(this.#header, SEQUENCE);
  }
}

/**
 * A pair of pipes for two-way communication with a process through a single device.
 *
 * Writes go to one pipe, which processes read from, and reads come from the other,
 * which processes write to. Closing a duplex closes both.
 *
 * ```ts
 * const dup = new Duplex();
 * const proc = engine.run("python", { devices: { "/dev/host": dup } });
 * await dup.write("ping\n");
 * console.log(await dup.read());
 * ```
 */
export class Duplex extends Pipe {
  /** @internal `write` is the pipe written to (and read by processes). */
  declare readonly [Internals]: Pipe[typeof Internals] & { write: Pipe };

  constructor(options: PipeOptions = {}) {
    super(options);
    this[Internals].write = new Pipe(options);
  }

  public override write(value: Uint8Array | string): Promise<void> {
    return this[Internals].write.write(value);
  }

  public override close(): void {
    // `write` is still absent when `super` closes a pipe without capacity.
    this[Internals].write?.close();
    super.close();
  }
}

// ╭──────────────────────────────────────────────────────────────────────────╮
// │ Worker Pool                                                              │
// ╰──────────────────────────────────────────────────────────────────────────╯

/** A message posted by a worker. */
export type WorkerMessage = { type: string; [key: string]: unknown };

/** A worker executing jobs on the engine's shared memory. */
export class PoolWorker {
  public readonly ready: Promise<void>;

  constructor(
    public readonly worker: Worker,
    public readonly gate: number
  ) {
    this.ready = new Promise((resolve, reject) => {
      const onReady = (e: MessageEvent<WorkerMessage>) => {
        worker.removeEventListener('message', onReady);
        if (e.data.type !== 'ready') return reject(new Error(String(e.data.message)));
        resolve();
      };
      worker.addEventListener('message', onReady);
      worker.addEventListener('error', (e) => reject(e.error ?? new Error(e.message)), {
        once: true
      });
    });
  }

  /**
   * Safely terminates this worker (see `src/worker/gate.rs`).
   *
   * Termination is asynchronous and unobservable, so the worker's stack and TLS block
   * can never be safely freed (as in `wasmer-sdk`): a killed worker leaks them.
   */
  async terminate() {
    gate_doom(this.gate);
    while (!gate_idle(this.gate)) await tick();
    this.worker.terminate();
  }
}

/**
 * A pool of reusable workers. Workers are spawned lazily, returned to the pool once
 * their job is done, and terminated (then lazily replaced) if they crash or are killed.
 */
export class Pool {
  private readonly idle: PoolWorker[] = [];
  private readonly all = new Set<PoolWorker>();

  constructor(private readonly spawn: (gate: number) => Worker) {}

  async acquire(): Promise<PoolWorker> {
    const reused = this.idle.pop();
    if (reused) return reused;
    const gate = gate_new();
    const worker = new PoolWorker(this.spawn(gate), gate);
    this.all.add(worker);
    try {
      await worker.ready;
    } catch (err) {
      void this.kill(worker);
      throw err;
    }
    return worker;
  }

  release(worker: PoolWorker) {
    if (this.all.has(worker)) this.idle.push(worker);
  }

  async kill(worker: PoolWorker) {
    this.all.delete(worker);
    const index = this.idle.indexOf(worker);
    if (index >= 0) this.idle.splice(index, 1);
    await worker.terminate();
  }

  dispose() {
    for (const worker of [...this.all]) void this.kill(worker);
  }
}
