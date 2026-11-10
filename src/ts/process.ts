import EventEmitter from 'events';

import { gate_doom, gate_idle, gate_new } from '../../pkg/engine';
import type { Debugger } from './debugger';
import { tick } from './util';

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
export type Stdio = { stdin: Stdin; stdout: Stdout; stderr: Stdout };

const encoder = new TextEncoder();

/**
 * A running process. Await it (it is thenable) to obtain its {@link ProcessResult}.
 */
export class Process implements PromiseLike<ProcessResult> {
  public readonly stdin: Stdin;
  public readonly stdout: Stdout;
  public readonly stderr: Stdout;

  /** The debugger for this process. Present only if `debug: true` was passed. */
  public readonly debugger?: Debugger;

  private readonly result: Promise<ProcessResult>;
  private readonly killers = new Set<() => void>();
  private finished = false;
  private killed = false;

  constructor(stdio: Stdio, debug: Debugger | undefined, body: (proc: Process) => Promise<number>) {
    ({ stdin: this.stdin, stdout: this.stdout, stderr: this.stderr } = stdio);
    this.debugger = debug;

    let kill!: (result: ProcessResult) => void;
    const killed = new Promise<ProcessResult>((resolve) => (kill = resolve));
    this.killers.add(() => kill({ exitCode: 137, killed: true }));

    // Start the body on the next tick, so that callers can attach listeners first.
    const ran = tick().then(() => body(this));
    this.result = Promise.race([ran.then((exitCode) => ({ exitCode, killed: false })), killed]);
    this.result.finally(() => (this.finished = true)).catch(() => {});
  }

  then<T = ProcessResult, E = never>(
    onfulfilled?: ((value: ProcessResult) => T | PromiseLike<T>) | null,
    onrejected?: ((reason: unknown) => E | PromiseLike<E>) | null
  ): Promise<T | E> {
    return this.result.then(onfulfilled, onrejected);
  }

  /** Immediately kills this process (and any steps it is running). */
  kill(): void {
    if (this.finished || this.killed) return;
    this.killed = true;
    for (const kill of this.killers) kill();
  }

  /**
   * Registers a function to run if this process is killed, until `release` is called.
   * If the process has already been killed, it runs immediately.
   * @internal
   */
  onKill(kill: () => void): () => void {
    if (this.killed) kill();
    this.killers.add(kill);
    return () => void this.killers.delete(kill);
  }

  /** Writes a message to this process' stderr. @internal */
  error(message: string) {
    this.stderr.emit('data', encoder.encode(`${message}\n`));
  }
}

export class Stdout extends EventEmitter<{ data: [Uint8Array] }> {}

/**
 * A process' standard input, backed by a ring buffer shared with its workers.
 *
 * Layout: `[read index, write index, sequence, closed]` (4 x i32), then data.
 * The worker owns the read index; we own the rest. `sequence` is bumped on every
 * write and on close, so that a blocked reader never misses a wakeup.
 */
export class Stdin {
  private static readonly SIZE = 4096;
  private static readonly HEADER = 16;
  private static readonly DATA = Stdin.SIZE - Stdin.HEADER;

  /** @internal */
  public readonly buffer = new SharedArrayBuffer(Stdin.SIZE);
  private readonly indices = new Int32Array(this.buffer, 0, 4);
  private readonly data = new Uint8Array(this.buffer, Stdin.HEADER);

  /** Whether {@link close} has been called. */
  public get closed(): boolean {
    return Atomics.load(this.indices, 3) !== 0;
  }

  /** Writes a chunk, waiting for space in the buffer as needed. */
  public async write(value: Uint8Array | string): Promise<void> {
    if (this.closed) throw new Error('stdin is closed');
    const chunk = typeof value === 'string' ? encoder.encode(value) : value;
    const N = Stdin.DATA;
    let offset = 0;

    while (offset < chunk.length) {
      const read = Atomics.load(this.indices, 0);
      const write = Atomics.load(this.indices, 1);
      // One slot is always kept empty to distinguish full from empty.
      const free = (read - write - 1 + N) % N;
      if (free === 0) {
        await Atomics.waitAsync(this.indices, 0, read).value;
        continue;
      }

      const count = Math.min(chunk.length - offset, free, N - write);
      this.data.set(chunk.subarray(offset, offset + count), write);
      Atomics.store(this.indices, 1, (write + count) % N);
      this.notify();
      offset += count;
    }
  }

  /** Closes stdin: once the buffer is drained, readers observe end-of-file. */
  public close(): void {
    Atomics.store(this.indices, 3, 1);
    this.notify();
  }

  private notify() {
    Atomics.add(this.indices, 2, 1);
    Atomics.notify(this.indices, 2);
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
