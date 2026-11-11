// eslint-disable-next-line @typescript-eslint/no-unused-vars -- only referenced by {@link} in doc comments
import type { Engine } from '.';
import type { Fs } from '../../pkg/engine';
import type { Filesystem } from './fs';
import type { Device, Pipe, Process } from './process';
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- only referenced by {@link} in doc comments
import type { PipeOptions, Readable } from './process';
import { dirname, Internals, join } from './util';

const LLVM = 'https://fabioibanez.github.io/website/llvm.core.wasm';
const RUSTC = 'https://debugger-sh.github.io/engine/rustc.wasm';
const PYTHON = 'https://runno.dev/langs/python-3.11.3.wasm';

/** The default sysroot of each toolchain. */
export const sysroots: Record<string, string> = {
  cpp: 'https://fabioibanez.github.io/website/llvm-resources.tar.gz',
  rust: 'https://debugger-sh.github.io/engine/rust-sysroot.tar.gz',
  python: 'https://runno.dev/langs/python-3.11.3.tar.gz'
};

/** Built-in commands: the binary to run, and its `argv[0]`. */
export const commands: Record<string, [url: string, name: string]> = {
  clang: [LLVM, 'clang'],
  'clang++': [LLVM, 'clang++'],
  lld: [LLVM, 'wasm-ld'],
  rustc: [RUSTC, 'rustc']
};

export interface RunOptions {
  /**
   * Environment variables to supply to the command.
   *
   * For language toolchains, this environment is shared by all steps.
   */
  env?: Record<string, string>;

  /**
   * A sysroot is a filesystem that is accessible by this command,
   * but is not visible to other processes created by the engine or {@link Engine.fs}.
   * This is typically used for loading standard library files, e.g. the C++ standard libraries.
   *
   * Language toolchains (e.g. `cpp`, `rust` and `python`) will automatically use
   * the correct sysroot needed to run that toolchain. Note that individual toolchain
   * steps (e.g. `clang` or `lld`) will **not**, as this allows customizing the toolchain
   * for maximum flexibility.
   *
   * You can configure the toolchain that is used by passing the following:
   *
   *  * A language toolchain name, e.g. `"cpp"`, to use the default sysroot for that toolchain.
   *  * The URL to a toolchain archive to download and use. Tarballs (.tar.gz) and zip archives
   *    are currently supported.
   */
  sysroot?: Toolchain | (string & {});

  /**
   * Whether to enable debugging on this process.
   *
   * The debugging interface will be accessible through {@link Process.debugger}.
   * Currently, WASI executables with debug info (e.g. those compiled via the `rust`
   * and `cpp` toolchains) as well Python programs currently support debugging.
   */
  debug?: boolean;

  /**
   * Devices can be used to allow communication with a process beyond what is
   * already supported by standard in/out/err.
   *
   * Since processes do not execute on the main browser thread, we cannot pass Wasm
   * imports directly to the running program. Devices are intended to be a more flexible,
   * language-agnostic interface for use-cases that require external communication: graphics,
   * mouse/keyboard, test harnesses, audio, and more!
   *
   * A device is given a path that is accessible to the guest program through the filesystem.
   * Currently, stream-based ({@link Pipe}) and shared-memory ({@link SharedArrayBuffer})
   * devices are supported.
   *
   * Devices occupy paths in the filesystem, and can be created in nested directories
   * even when the parent directories do not exist. If a file shares the same name
   * as a device, the device takes precedence for filesystem operations.
   *
   * ### Stream-based Devices
   *
   * A {@link Pipe} is a file the program reads or writes to as a stream.
   * Pipes store data in an internal buffer, and will apply backpressure for
   * readers (when the buffer is empty) and writers (when the buffer is full).
   *
   * Note: {@link Pipe} objects passed here will automatically close when this
   * process exits for any reason, unless {@link PipeOptions.close} is set to `false`.
   *
   * ```ts
   * const pipe = new Pipe();
   * const proc = engine.run("python", ["-c", "open('/dev/out', 'w').write('hello')"], {
   *   devices: { "/dev/out": pipe }
   * });
   *
   * for await (const line of pipe.lines()) {
   *   console.log(line);
   * }
   * ```
   *
   * This could be used to implement message passing and interactive programs.
   *
   * ### Shared-memory Devices
   *
   * A {@link SharedArrayBuffer} is a fixed-size file backed by shared memory.
   *
   * ```ts
   * const memory = new SharedArrayBuffer(4);
   * await engine.run("python", ["-c", "open('/dev/mem', 'wb').write(b'ping')"], {
   *   devices: { "/dev/mem": memory }
   * });
   * console.log(new TextDecoder().decode(new Uint8Array(memory))); // "ping"
   * ```
   *
   * This could be used to implement a simple graphics framebuffer.
   */
  devices?: Record<string, Device>;

  /**
   * Used to customize a process's `stdin`.
   * If not provided, `stdin` defaults to a closed, empty stream,
   * so the process reads end-of-file.
   *
   * To pass data to `stdin`, provide a string or bytes here.
   * Programs will read this data followed by end-of-file.
   *
   * For interactive input, pass `true` here, or create a pipe and write to it as the process runs:
   *
   * ```ts
   * const stdin = new Pipe();
   * const proc = engine.run("python", { stdin });
   * await stdin.write("input\n");
   * stdin.close();
   * ```
   *
   * Note that any pipes provided will automatically close when the process exits unless
   * {@link PipeOptions.close} is set to `false`.
   */
  stdin?: Pipe | true | string | Uint8Array;

  /**
   * Used to customize a process's `stdout`.
   * If not provided, a new pipe is created for this process.
   *
   * The default pipe will be created in flowing mode, meaning
   * that any output is automatically read and passed to listeners
   * rather than waiting for {@link Readable.read} to be called.
   *
   * Note that any pipes provided (including the default one)
   * will automatically close when the process exits unless
   * {@link PipeOptions.close} is set to `false`.
   */
  stdout?: Pipe;

  /**
   * Used to customize a process's `stderr`.
   * If not provided, a new pipe is created for this process.
   *
   * The default pipe will be created in flowing mode, meaning
   * that any output is automatically read and passed to listeners
   * rather than waiting for {@link Readable.read} to be called.
   *
   * Note that any pipes provided (including the default one)
   * will automatically close when the process exits unless
   * {@link PipeOptions.close} is set to `false`.
   */
  stderr?: Pipe;
}

export interface PythonOptions {
  /**
   * When no args are provided, whether or not to run an interactive REPL.
   *
   * If `false`, will run the first `.py` program found in the workspace.
   * If `true`, {@link RunOptions.stdin} will default `true` to enable
   * interactive input.
   *
   * @default false
   */
  repl?: boolean;
}

export interface CppOptions {
  /**
   * Globs of C/C++ sources to compile.
   *
   * @default ["**\/*.{c,cc,cp,cpp,cxx,c++}"]
   */
  sources?: string[];

  /**
   * The directory where object files and the executable are placed.
   *
   * @default "/build"
   */
  buildDir?: string;

  /**
   * Additional flags that are passed to the compiler (`clang`).
   */
  cxxFlags?: string[];

  /**
   * Additional flags that are passed to the linker (`lld`).
   */
  lldFlags?: string[];
}

export interface RustOptions {
  /**
   * Globs of rust sources to compile.
   *
   * @default ["**\/*.{c,cc,cp,cpp,cxx,c++}"]
   */
  sources?: string[];

  /**
   * The directory where object files and the executable are placed.
   *
   * @default "/build"
   */
  buildDir?: string;

  /**
   * Additional flags that are passed to the compiler (`rustc`).
   */
  rustFlags?: string[];
}

export interface ToolchainOptionsMap {
  python: PythonOptions;
  cpp: CppOptions;
  rust: RustOptions;
}

/**
 * The name of a language toolchain.
 */
export type Toolchain = keyof ToolchainOptionsMap;

/** Options for a step of a toolchain, which always shares the stdio of its process. */
export type StepOptions = Omit<RunOptions, 'debug' | 'stdin' | 'stdout' | 'stderr'> & {
  /** Overrides `argv[0]`. */
  name?: string;
  /** Debug this step (`python` selects the Python debugger). */
  debug?: boolean | 'python';
};

/** What a toolchain has access to. */
export interface Context<T extends Toolchain> {
  args: string[];
  options: RunOptions & ToolchainOptionsMap[T];
  env: Record<string, string>;
  fs: Filesystem;
  process: Process;
  /** Runs a step as a child process sharing this process' stdio, debugger and `env`. */
  run(command: string, args: string[], options?: StepOptions): Promise<number>;
  /** Loads a sysroot (a toolchain name or URL), so that the toolchain can inspect it. */
  sysroot(url: string): Promise<Fs | undefined>;
}

export const toolchains: { [T in Toolchain]: (ctx: Context<T>) => Promise<number> } = {
  cpp,
  rust,
  python
};

async function python(ctx: Context<'python'>): Promise<number> {
  const { options } = ctx;
  let args = ctx.args;
  if (!args.length && !options.repl) {
    const [script] = await ctx.fs[Internals].raw().glob('/', ['**/*.py'], []);
    if (!script) {
      await ctx.process[Internals].error('python: no Python file found');
      return 2;
    }
    args = [join(script)];
  }
  return ctx.run(PYTHON, args.length ? args : ['-i'], {
    name: 'python',
    sysroot: options.sysroot ?? 'python',
    env: { PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1', ...ctx.env },
    debug: options.debug && args.length > 0 && 'python',
    devices: options.devices
  });
}

/** Compiles stale sources in parallel (`compile` returns an exit code), returning the first failure. */
async function compileAll(
  sources: string[],
  compile: (source: string) => Promise<number>
): Promise<number> {
  const queue = [...sources];
  const failures: number[] = [];
  const lane = async () => {
    for (let source; (source = queue.shift()) !== undefined && !failures.length; ) {
      const code = await compile(source);
      if (code) failures.push(code);
    }
  };
  const lanes = Math.min(sources.length, navigator.hardwareConcurrency || 4);
  await Promise.all(Array.from({ length: lanes }, lane));
  return failures[0] ?? 0;
}

async function sources(ctx: Context<'cpp' | 'rust'>, defaults: string[]): Promise<string[]> {
  const found = await ctx.fs[Internals].raw().glob('/', ctx.options.sources ?? defaults, []);
  return found.filter((path) => !path.endsWith('/')).map((path) => join(path));
}

async function cpp(ctx: Context<'cpp'>): Promise<number> {
  const { buildDir = '/build', cxxFlags = [], lldFlags = [], sysroot = 'cpp' } = ctx.options;
  const files = await sources(ctx, ['**/*.{c,cc,cp,cpp,cxx,c++}']);
  if (!files.length) {
    await ctx.process[Internals].error('cpp: no sources found');
    return 1;
  }
  const object = (source: string) => join(buildDir, source) + '.o';

  const code = await compileAll(files, async (source) => {
    const obj = object(source);
    const dep = obj.replace(/\.o$/, '.d');
    // prettier-ignore
    const args = [
      '-cc1', '-triple', 'wasm32-wasip1', '-Werror', '-emit-obj', '-disable-free',
      '-isysroot', '/', '-internal-isystem', '/include/c++/v1', '-internal-isystem', '/include',
      '-internal-isystem', '/include/wasm32-wasip1', '-ferror-limit', '4', '-fcolor-diagnostics',
      '-x', 'c++', '-std=c++23', '-O0', '-debug-info-kind=standalone', '-dwarf-version=5',
      '-dependency-file', dep, '-MT', obj, ...cxxFlags, '-o', obj, source
    ];
    const command = JSON.stringify(args);
    if (!(await isStale(ctx.fs, obj, dep, command))) return 0;

    await ctx.fs.mkdir(dirname(obj), { recursive: true });
    const code = await ctx.run('clang', args, { sysroot });
    if (code === 0) await recordHashes(ctx.fs, dep, command);
    return code;
  });
  if (code) return code;

  const main = join(buildDir, 'main');
  // prettier-ignore
  const linked = await ctx.run('lld', [
    '--export-dynamic', '-z', 'stack-size=1048576', '-L/lib/wasm32-wasip1', '/lib/wasm32-wasip1/crt1.o',
    ...files.map(object), '-lc++', '-lc++abi', '/lib/wasm32-unknown-wasip1/libclang_rt.builtins.a', '-lc',
    ...lldFlags, '-o', main
  ], { sysroot });
  if (linked) return linked;

  return ctx.run(main, ctx.args, { debug: ctx.options.debug, devices: ctx.options.devices });
}

/**
 * Compilation caching: a source is stale if its object or `.d` file is missing, if the
 * compile command changed, or if any dependency listed in the `.d` file is missing or has
 * a different hash than when it was last compiled (see {@link recordHashes}).
 */
async function isStale(
  fs: Filesystem,
  obj: string,
  dep: string,
  command: string
): Promise<boolean> {
  const raw = fs[Internals].raw();
  const text = await fs.readFile(dep, 'utf8').catch(() => undefined);
  if (text === undefined || !(await raw.hash(obj))) return true;
  const [rule, ...lines] = text.replace(/\\\n/g, ' ').split('\n');
  if (!lines.includes(`# ${command}`)) return true;
  const hashes = new Map(lines.map((line) => line.split(': ') as [string, string]));
  for (const path of dependencies(rule))
    if (hashes.get(path) !== (await raw.hash(path))) return true;
  return false;
}

/** Extends the compiler's `.d` file with the hash of every dependency (and the command). */
async function recordHashes(fs: Filesystem, dep: string, command: string) {
  const text = (await fs.readFile(dep, 'utf8')).trimEnd();
  const paths = dependencies(text.replace(/\\\n/g, ' '));
  const hashes = await Promise.all(paths.map((path) => fs[Internals].raw().hash(path)));
  const lines = paths.map((path, i) => `${path}: ${hashes[i]}`);
  await fs.writeFile(dep, [text, ...lines, `# ${command}`, ''].join('\n'));
}

/** The dependencies of a Makefile rule (`target: dep dep …`). */
function dependencies(rule: string): string[] {
  return rule
    .slice(rule.indexOf(': ') + 2)
    .split(/\s+/)
    .filter(Boolean);
}

/** The standard library rlibs to link, in dependency order. */
// prettier-ignore
const RUST_LIBS = [
  'panic_abort', 'std', 'wasi', 'cfg_if', 'rustc_demangle', 'std_detect', 'hashbrown',
  'rustc_std_workspace_alloc', 'miniz_oxide', 'adler2', 'unwind', 'libc',
  'rustc_std_workspace_core', 'alloc', 'core', 'compiler_builtins'
];

async function rust(ctx: Context<'rust'>): Promise<number> {
  const { buildDir = '/build', rustFlags = [], sysroot = 'rust' } = ctx.options;
  const files = await sources(ctx, ['**/*.rs']);
  if (!files.length) {
    await ctx.process[Internals].error('rust: no sources found');
    return 1;
  }
  const object = (source: string) => join(buildDir, source) + '.o';
  const debug = ctx.options.debug ? ['-g', '-Copt-level=0'] : [];

  // rustc also emits the allocator shim as `{crate}.{hash}.rcgu.o`, next to the object
  const shims = async (source: string) => {
    const crate = source.split('/').pop()!.replace(/\.rs$/, '').replaceAll('-', '_');
    const dir = dirname(object(source));
    const names = await ctx.fs[Internals].raw().glob(dir, [`${crate}.*.rcgu.o`], []);
    return names.map((name) => join(dir, name));
  };

  const code = await compileAll(files, async (source) => {
    await ctx.fs.mkdir(dirname(object(source)), { recursive: true });
    for (const shim of await shims(source)) await ctx.fs.remove(shim);
    // prettier-ignore
    return ctx.run('rustc', [
      source, '--sysroot', '/', '--target', 'wasm32-wasip1', '-Cpanic=abort', '-Ccodegen-units=1',
      '-Zthreads=1', '--emit=obj', ...debug, ...rustFlags, '-o', object(source)
    ], { sysroot });
  });
  if (code) return code;
  const objects = (
    await Promise.all(files.map(async (f) => [object(f), ...(await shims(f))]))
  ).flat();

  const lib = '/lib/rustlib/wasm32-wasip1/lib';
  const fs = await ctx.sysroot(sysroot);
  const rlibs = fs ? await fs.glob(lib, ['*.rlib'], []) : [];
  const libs = RUST_LIBS.map((name) => rlibs.find((rlib) => rlib.startsWith(`lib${name}-`)))
    .filter((rlib) => rlib !== undefined)
    .map((rlib) => join(lib, rlib));

  const main = join(buildDir, 'main');
  // prettier-ignore
  const linked = await ctx.run('lld', [
    '--export=__main_void', '-z', 'stack-size=1048576', '--stack-first', '--no-demangle',
    `${lib}/self-contained/crt1-command.o`, ...objects, ...libs,
    `-L${lib}/self-contained`, '-lc', '-o', main, '--gc-sections', '-O0'
  ], { sysroot });
  if (linked) return linked;

  return ctx.run(main, ctx.args, { debug: ctx.options.debug, devices: ctx.options.devices });
}
