import init, { Fs, type InitOutput } from '../../pkg/engine';
import wasmBinary from '../../pkg/engine_bg.wasm';
import { Debugger } from './debugger';
import { Filesystem } from './fs';
import { Pool, Process, Stdin, type Stdio, Stdout, type WorkerMessage } from './process';
import {
  type BaseOptions,
  commands,
  type Context,
  type StepOptions,
  sysroots,
  type Toolchain,
  type ToolchainOptionsMap,
  toolchains
} from './toolchains';
import { internal, Internals } from './util';

/**
 * A command to run: a language toolchain or built-in command, or a WASI executable
 * (raw bytes, a URL to fetch, or a path within the workspace).
 */
export type CommandLike = Uint8Array | string | Toolchain;

/** Toolchains may allow supplying toolchain-specific options. */
export type CommandOptions<C extends CommandLike> = C extends Toolchain
  ? BaseOptions & ToolchainOptionsMap[C]
  : BaseOptions;

/** A process spawned with `debug: true`. */
export interface DebuggableProcess extends Process {
  readonly debugger: Debugger;
}

/** A failure to resolve a program: an exit code, and a message for stderr. */
type Failure = [code: number, message: string];

const isFailure = (value: unknown): value is Failure => Array.isArray(value);

/** Resolves a `sysroot` option (a toolchain name or a URL) to a URL. */
const sysrootUrl = (sysroot: string) =>
  Object.hasOwn(sysroots, sysroot) ? sysroots[sysroot] : sysroot;

/** The engine's WebAssembly module and the memory shared by all of its threads. */
let runtime: Promise<{ module: WebAssembly.Module; exports: InitOutput }> | undefined;

/** Compiled modules (or failures) of fetched commands, by URL. */
const modules = new Map<string, Promise<WebAssembly.Module | Failure>>();

/** Loaded sysroots (or failures), by URL. Shared by all engines, never copied. */
const sysrootCache = new Map<string, Promise<Fs | Failure>>();

async function fetchBytes(url: string): Promise<Uint8Array<ArrayBuffer> | Failure> {
  // Toolchain binaries are versioned by URL, so they can be cached indefinitely.
  const response = await fetch(url, { cache: 'force-cache' }).catch(() => undefined);
  if (!response?.ok) return [127, `network error (${response?.status ?? 0})`];
  return new Uint8Array(await response.arrayBuffer());
}

function cached<T>(
  cache: Map<string, Promise<T | Failure>>,
  url: string,
  load: () => Promise<T | Failure>
): Promise<T | Failure> {
  let promise = cache.get(url);
  if (!promise) {
    cache.set(url, (promise = load()));
    // Don't remember failures, so that they may be retried.
    const forget = () => cache.delete(url);
    promise.then((value) => isFailure(value) && forget(), forget);
  }
  return promise;
}

/**
 * An engine represents a workspace (a shared filesystem) on which any number of
 * concurrent processes operate.
 */
export class Engine {
  /** The shared, in-memory filesystem of this engine. */
  public readonly fs: Filesystem;

  readonly #pool: Pool;
  readonly #processes = new Set<Process>();
  #disposed = false;

  /** Creates an engine. */
  static async create(): Promise<Engine> {
    runtime ??= (async () => {
      const binary = wasmBinary as unknown as URL | Uint8Array<ArrayBuffer>;
      const module = await WebAssembly.compile(
        binary instanceof URL ? await (await fetch(binary)).arrayBuffer() : binary
      );
      const exports = await init({ module_or_path: module });
      return { module, exports };
    })();
    return new Engine(Internals, await runtime);
  }

  /** @internal */
  constructor(key: typeof Internals, runtime: { module: WebAssembly.Module; exports: InitOutput }) {
    internal(key);
    const { module, exports } = runtime;
    this.fs = new Filesystem(Internals, new Fs());
    this.#pool = new Pool((gate) => {
      const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      worker.postMessage({ type: 'init', module, memory: exports.memory, gate });
      return worker;
    });
  }

  /** Kills any running processes and releases the memory held by the engine. */
  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const process of this.#processes) process.kill();
    this.#pool.dispose();
    this.fs[Internals].dispose();
  }

  /**
   * Runs a command, returning the (already running) process.
   *
   * `command` is interpreted as, in order:
   *  1. A WASI executable to download, if it is a URL (`http://` or `https://`).
   *  2. A WASI executable in the filesystem, if it is an absolute or `.`-prefixed path.
   *  3. A toolchain (`cpp`, `rust`, `python`) or built-in command (`clang`, `clang++`, `lld`, `rustc`).
   *
   * With `debug: true`, the process waits for the DAP handshake on `proc.debugger`.
   */
  public run<C extends CommandLike>(
    command: C,
    options: CommandOptions<C> & { debug: true }
  ): DebuggableProcess;
  public run<C extends CommandLike>(command: C, options?: CommandOptions<C>): Process;
  public run<C extends CommandLike>(
    command: C,
    args: string[],
    options: CommandOptions<C> & { debug: true }
  ): DebuggableProcess;
  public run<C extends CommandLike>(
    command: C,
    args: string[],
    options?: CommandOptions<C>
  ): Process;
  public run(
    command: CommandLike,
    args?: string[] | (BaseOptions & PythonFilter),
    options?: BaseOptions & PythonFilter
  ): Process {
    if (this.#disposed) throw new Error('The engine has been disposed');
    if (!Array.isArray(args)) [args, options] = [[], args];
    options ??= {};

    const stdio = {
      stdin: new Stdin(Internals),
      stdout: new Stdout(Internals),
      stderr: new Stdout(Internals)
    };
    const debug = options.debug ? new Debugger(Internals, options.filterInternals) : undefined;
    const process = this.#spawn(stdio, debug, command, args, options);

    this.#processes.add(process);
    const finish = () => {
      this.#processes.delete(process);
      debug?.[Internals].receive({ type: 'stop' });
    };
    process.then(finish, finish);
    return process;
  }

  #spawn(
    stdio: Stdio,
    debug: Debugger | undefined,
    command: CommandLike,
    args: string[],
    options: StepOptions
  ): Process {
    return new Process(Internals, stdio, debug, (process) =>
      this.#exec(process, command, args, options)
    );
  }

  async #exec(
    process: Process,
    command: CommandLike,
    args: string[],
    options: StepOptions
  ): Promise<number> {
    if (command instanceof Uint8Array) return this.#job(process, { bytes: command }, args, options);
    if (/^https?:\/\//.test(command)) return this.#job(process, { url: command }, args, options);
    if (command.startsWith('/') || command.startsWith('.'))
      return this.#job(process, { path: command }, args, options);
    if (Object.hasOwn(toolchains, command))
      return this.#toolchain(process, command as Toolchain, args, options);
    if (Object.hasOwn(commands, command)) {
      const [url, name] = commands[command];
      return this.#job(process, { url }, args, { name, ...options });
    }
    process[Internals].error(`${command}: command not found`);
    return 127;
  }

  #toolchain(
    process: Process,
    name: Toolchain,
    args: string[],
    options: StepOptions
  ): Promise<number> {
    const env = options.env ?? {};
    const ctx: Context<Toolchain> = {
      args,
      options: options as Context<Toolchain>['options'],
      env,
      fs: this.fs,
      process,
      run: async (command, args, step = {}) => {
        const stdio = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr };
        const child = this.#spawn(stdio, process.debugger, command, args, { env, ...step });
        const release = process[Internals].onKill(() => child.kill());
        const { exitCode } = await child;
        release();
        return exitCode;
      },
      sysroot: async (name) => {
        const sysroot = await this.#sysroot(sysrootUrl(name));
        return isFailure(sysroot) ? undefined : sysroot;
      }
    };
    return (toolchains[name] as (ctx: Context<Toolchain>) => Promise<number>)(ctx);
  }

  /** Loads a sysroot in a worker (fetching and extracting it in shared memory). */
  #sysroot(url: string): Promise<Fs | Failure> {
    return cached(sysrootCache, url, async () => {
      const worker = await this.#pool.acquire();
      const message = await new Promise<WorkerMessage>((resolve) => {
        worker.worker.addEventListener('message', (e) => resolve(e.data), { once: true });
        worker.worker.postMessage({ type: 'sysroot', url });
      });
      this.#pool.release(worker);
      if (message.type === 'error') throw new Error(String(message.message));
      if (message.ptr === undefined) return [127, `network error (${message.status})`];
      return Fs.from_ptr(message.ptr as number);
    });
  }

  /** Runs a single WASI program on a worker. */
  async #job(
    process: Process,
    program: { bytes?: Uint8Array; url?: string; path?: string },
    args: string[],
    options: StepOptions
  ): Promise<number> {
    const name = options.name ?? program.path ?? program.url ?? 'main';
    const fail = ([code, message]: Failure) => (
      process[Internals].error(`${name}: ${message}`),
      code
    );
    const debug = options.debug === 'python' ? 'python' : options.debug ? 'wasm' : undefined;

    let sysroot: number | undefined;
    if (options.sysroot) {
      const loaded = await this.#sysroot(sysrootUrl(options.sysroot));
      if (isFailure(loaded)) return fail(loaded);
      sysroot = loaded.ptr();
    }

    let { bytes } = program;
    let module: WebAssembly.Module | undefined;
    if (program.url && debug === 'wasm') {
      // Instrumentation for debugging requires the raw binary.
      const fetched = await fetchBytes(program.url);
      if (isFailure(fetched)) return fail(fetched);
      bytes = fetched;
    } else if (program.url) {
      const compiled = await cached(modules, program.url, async () => {
        const fetched = await fetchBytes(program.url!);
        if (isFailure(fetched)) return fetched;
        return WebAssembly.compile(fetched).catch((): Failure => [126, 'cannot execute']);
      });
      if (isFailure(compiled)) return fail(compiled);
      module = compiled;
    }

    const job = {
      name,
      module,
      bytes,
      path: program.path,
      args,
      env: Object.entries(options.env ?? {}),
      workspace: this.fs[Internals].ptr,
      sysroot,
      stdin: process.stdin[Internals].buffer,
      debug
    };

    const worker = await this.#pool.acquire();
    return new Promise<number>((resolve, reject) => {
      let release = () => {};
      const done = (finish: () => void) => {
        worker.worker.removeEventListener('message', onMessage);
        worker.worker.removeEventListener('error', onError);
        release();
        finish();
      };
      const onMessage = ({ data }: MessageEvent<WorkerMessage>) => {
        if (data.type === 'stdout')
          (data.mode === 2 ? process.stderr : process.stdout).emit('data', data.data as Uint8Array);
        else if (data.type === 'exit')
          done(() => (this.#pool.release(worker), resolve(data.code as number)));
        else if (data.type === 'error')
          done(() => (void this.#pool.kill(worker), reject(new Error(String(data.message)))));
        else if (debug) process.debugger?.[Internals].receive(data);
      };
      const onError = (e: ErrorEvent) =>
        done(() => (void this.#pool.kill(worker), reject(e.error ?? new Error(e.message))));
      // A killed job's worker is terminated, and replaced (lazily) by a fresh one.
      release = process[Internals].onKill(() =>
        done(() => (void this.#pool.kill(worker), resolve(137)))
      );

      worker.worker.addEventListener('message', onMessage);
      worker.worker.addEventListener('error', onError);
      worker.worker.postMessage({ type: 'run', job });
    });
  }
}

type PythonFilter = { filterInternals?: boolean };

export type { Artifact, Debugger } from './debugger';
export type {
  Directory,
  ExportOptions,
  File,
  FileContents,
  FileStat,
  FileTree,
  Timestamp,
  Timestamps
} from './fs';
export type { Filesystem } from './fs';
export type { ProcessResult } from './process';
export type { Process, Stdin, Stdout } from './process';
export type {
  BaseOptions,
  CppOptions,
  PythonOptions,
  RustOptions,
  Toolchain,
  ToolchainOptionsMap
} from './toolchains';
