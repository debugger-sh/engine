import EventEmitter from 'events';

import { gate_doom, gate_idle, gate_new } from '../../pkg/engine';
import type { Debugger } from './debugger';
import { internal, Internals, tick } from './util';

export interface ProcessResult {
  /**
   * The exit code of the process.
   *
   * For toolchains that invoke multiple steps, this will be the first non-zero
   * exit code if any intermediate steps fail.
   */
  exitCode: number;
  /** Whether or not the process was killed. */
  killed: boolean;
}

/** The standard streams of a process, shared by all of its steps. */
export type Stdio = { stdin: Pipe; stdout: Pipe; stderr: Pipe };

/**
 * A running process. Await it (it is thenable) to obtain its {@link ProcessResult}.
 */
export class Process implements PromiseLike<ProcessResult> {
  public readonly stdin: Writable;
  public readonly stdout: Readable;
  public readonly stderr: Readable;

  /** The debugger for this process. Present only if `debug: true` was passed. */
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
    /** Writes a message to this process' stderr. */
    error(message: string): void;
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
      error: (message) => void stdio.stderr.write(`${message}\n`).catch(() => {})
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

  /** Immediately kills this process (and any steps it is running). */
  kill(): void {
    if (this.#finished || this.#killed) return;
    this.#killed = true;
    for (const kill of this.#killers) kill();
  }
}

// ╭──────────────────────────────────────────────────────────────────────────╮
// │ Pipes                                                                    │
// ╰──────────────────────────────────────────────────────────────────────────╯

/** The readable end of a {@link Pipe}. */
export interface Readable
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

/** The writable end of a {@link Pipe}. */
export interface Writable {
  /**
   * Writes a chunk. Waits while the internal buffer is full, and resolves once every byte
   * is buffered. Throws if `close()` was called.
   */
  write(chunk: Uint8Array | string): Promise<void>;

  /** Close the stream for writing. Attempting to write again throws. */
  close(): void;

  /** Whether `close()` has been called. */
  readonly closed: boolean;
}

export interface PipeOptions {
  /**
   * The number of bytes this pipe's underlying buffer should be created with.
   *
   * Defaults to 4096 (4 KiB).
   */
  capacity?: number;

  /**
   * Whether to close this pipe once a process it was given to (as stdio or as a device)
   * exits, for any reason. When disabled, the pipe is left open for reuse.
   *
   * Defaults to `true`.
   */
  close?: boolean;
}

/** A device which a process can access through the filesystem: a pipe, or a shared buffer. */
export type Device = Pipe | SharedArrayBuffer;

const HEADER = 16;
const [READ, WRITE, SEQUENCE, CLOSED] = [0, 1, 2, 3];
const encoder = new TextEncoder();

/**
 * A one-way, buffered byte stream, which may be written and read by the main thread and by
 * any number of processes (the race of multiple readers or writers is left unguarded).
 *
 * It is backed by a ring buffer in shared memory (see `PipeDevice` in `src/worker/io.rs`), laid
 * out as `[read index, write index, sequence, closed]` (4 x i32), then data. `sequence` is
 * bumped on every write and on close, so that a blocked reader never misses a wakeup.
 */
export class Pipe
  extends EventEmitter<{ data: [Uint8Array]; end: [] }>
  implements Readable, Writable
{
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
  }

  public get closed(): boolean {
    return Atomics.load(this.#header, CLOSED) !== 0;
  }

  public async write(value: Uint8Array | string): Promise<void> {
    if (this.closed) throw new Error('The pipe is closed');
    const chunk = typeof value === 'string' ? encoder.encode(value) : value;
    const size = this.#data.length;
    let offset = 0;

    while (offset < chunk.length) {
      const read = Atomics.load(this.#header, READ);
      const write = Atomics.load(this.#header, WRITE);
      // One slot is always kept empty to distinguish full from empty.
      const free = (read - write - 1 + size) % size;
      if (free === 0) {
        await Atomics.waitAsync(this.#header, READ, read).value;
        continue;
      }

      const count = Math.min(chunk.length - offset, free, size - write);
      this.#data.set(chunk.subarray(offset, offset + count), write);
      Atomics.store(this.#header, WRITE, (write + count) % size);
      this.#notify();
      offset += count;
    }
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
   * "paused" mode, where bytes must be explicitly consumed by calling `read`.
   *
   * In flowing mode, bytes are automatically consumed by the pipe and forwarded
   * to any consumers, whether event listeners or calls to `read()`.
   *
   * Note that flowing mode is the default for `stdout` and `stderr`
   * when not setting up your own `stdout` and `stderr`.
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
        Atomics.notify(this.#header, READ);
        this.emit('data', chunk);
        return chunk;
      }
      if (this.closed) {
        if (!this.#ended) this.emit('end');
        this.#ended = true;
        return new Uint8Array();
      }
      await Atomics.waitAsync(this.#header, SEQUENCE, sequence).value;
    }
  }

  #notify() {
    Atomics.add(this.#header, SEQUENCE, 1);
    Atomics.notify(this.#header, SEQUENCE);
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
