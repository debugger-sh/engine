import type { Fs } from '../../pkg/engine';
import type { Filesystem } from './fs';
import type { Process } from './process';
import { dirname, Internals, join, locked } from './util';

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

export interface BaseOptions {
  /** Environment variables to supply to the command. For toolchains, this is shared by all steps. */
  env?: Record<string, string>;
  /**
   * The sysroot to use while running this command: a toolchain (like "cpp" or "python") to use
   * its default sysroot, or a URL to a tarball (.tar.gz) or zip archive.
   *
   * Sysroots are invisibly unioned beneath the filesystem, and are only visible to this command.
   * By default, when running a toolchain, the toolchain sysroot is used.
   */
  sysroot?: Toolchain | (string & {});
  /** Whether to allow debugging this process. Defaults to `false`. */
  debug?: boolean;
}

export interface PythonOptions {
  /** Omit internal (debugger bridge) frames from DAP stack traces. */
  filterInternals?: boolean;
  /** Whether to run an interactive REPL when no `args` are given. Defaults to `false`. */
  repl?: boolean;
}

export interface CppOptions {
  /** Globs, relative to `/`, of C/C++ sources to compile. Defaults to `["**\/*.{c,cc,cp,cpp,cxx,c++}"]` */
  sources?: string[];
  /** The directory where object files and the executable (`main`) are placed. Defaults to `/build` */
  buildDir?: string;
  /** Additional flags to apply when invoking the compiler. */
  cxxFlags?: string[];
  /** Additional flags to apply when invoking the linker. */
  lldFlags?: string[];
}

export interface RustOptions {
  /** Globs, relative to `/`, of Rust sources to compile. Defaults to `["**\/*.rs"]` */
  sources?: string[];
  /** The directory where object files and the executable (`main`) are placed. Defaults to `/build` */
  buildDir?: string;
  /** Additional flags to apply when invoking `rustc`. */
  rustFlags?: string[];
}

export interface ToolchainOptionsMap {
  python: PythonOptions;
  cpp: CppOptions;
  rust: RustOptions;
}

/** A language toolchain: a mini build system run as one process. */
export type Toolchain = keyof ToolchainOptionsMap;

/** Options for a step of a toolchain. */
export type StepOptions = Omit<BaseOptions, 'debug'> & {
  /** Overrides `argv[0]`. */
  name?: string;
  /** Debug this step (`python` selects the Python debugger). */
  debug?: boolean | 'python';
};

/** What a toolchain has access to. */
export interface Context<T extends Toolchain> {
  args: string[];
  options: BaseOptions & ToolchainOptionsMap[T];
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
    const [script] = await ctx.fs[Internals].locked((fs) => fs.glob('/', ['**/*.py'], []));
    if (!script) {
      ctx.process.error('python: no Python file found');
      return 2;
    }
    args = [join(script)];
  }
  return ctx.run(PYTHON, args.length ? args : ['-i'], {
    name: 'python',
    sysroot: options.sysroot ?? 'python',
    env: { PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1', ...ctx.env },
    debug: options.debug && args.length > 0 && 'python'
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
  const found = await ctx.fs[Internals].locked((fs) =>
    fs.glob('/', ctx.options.sources ?? defaults, [])
  );
  return found.filter((path) => !path.endsWith('/')).map((path) => join(path));
}

async function cpp(ctx: Context<'cpp'>): Promise<number> {
  const { buildDir = '/build', cxxFlags = [], lldFlags = [], sysroot = 'cpp' } = ctx.options;
  const files = await sources(ctx, ['**/*.{c,cc,cp,cpp,cxx,c++}']);
  if (!files.length) {
    ctx.process.error('cpp: no sources found');
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

  return ctx.run(main, ctx.args, { debug: ctx.options.debug });
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
  return fs[Internals].locked((raw) => {
    if (!raw.hash(obj)) return true;
    let text;
    try {
      text = new TextDecoder().decode(raw.readFile(dep));
    } catch {
      return true;
    }
    const [rule, ...lines] = text.replace(/\\\n/g, ' ').split('\n');
    if (!lines.includes(`# ${command}`)) return true;
    const hashes = new Map(lines.map((line) => line.split(': ') as [string, string]));
    const deps = rule
      .slice(rule.indexOf(': ') + 2)
      .split(/\s+/)
      .filter(Boolean);
    return deps.some((path) => !hashes.has(path) || hashes.get(path) !== raw.hash(path));
  });
}

/** Extends the compiler's `.d` file with the hash of every dependency (and the command). */
async function recordHashes(fs: Filesystem, dep: string, command: string) {
  await fs[Internals].locked((raw) => {
    const text = new TextDecoder().decode(raw.readFile(dep)).trimEnd();
    const rule = text.replace(/\\\n/g, ' ');
    const deps = rule
      .slice(rule.indexOf(': ') + 2)
      .split(/\s+/)
      .filter(Boolean);
    const lines = deps.map((path) => `${path}: ${raw.hash(path)}`);
    raw.writeFile(dep, new TextEncoder().encode([text, ...lines, `# ${command}`, ''].join('\n')));
  });
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
    ctx.process.error('rust: no sources found');
    return 1;
  }
  const object = (source: string) => join(buildDir, source) + '.o';
  const debug = ctx.options.debug ? ['-g', '-Copt-level=0'] : [];

  // rustc also emits the allocator shim as `{crate}.{hash}.rcgu.o`, next to the object
  const shims = (source: string) =>
    ctx.fs[Internals].locked((fs) => {
      const crate = source.split('/').pop()!.replace(/\.rs$/, '').replaceAll('-', '_');
      const dir = dirname(object(source));
      return fs.glob(dir, [`${crate}.*.rcgu.o`], []).map((name) => join(dir, name));
    });

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
  const rlibs = fs ? await locked(() => fs.glob(lib, ['*.rlib'], [])) : [];
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

  return ctx.run(main, ctx.args, { debug: ctx.options.debug });
}
