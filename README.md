# debugger-sh

A browser-based execution engine powered by WebAssembly. Compile, run and debug C/C++, Rust and Python programs entirely in the browser.

## Installation

```bash
npm install debugger-sh
```

> **Requires** these response headers (the engine shares memory between threads):
>
> ```
> Cross-Origin-Embedder-Policy: require-corp
> Cross-Origin-Opener-Policy: same-origin
> ```

---

## Quick start

```ts
import { Engine } from 'debugger-sh';

const engine = await Engine.create();

// A shared, in-memory filesystem, visible to every process as it runs
await engine.fs.mount({
  'main.cpp': `
    #include <iostream>
    int main() { std::cout << "Hello, world!" << std::endl; }
  `
});

// Compile, link and run. Processes start immediately and are awaitable.
const proc = engine.run('cpp');
proc.stdout.on('data', (chunk) => console.log(new TextDecoder().decode(chunk)));
console.log(await proc); // { exitCode: 0, killed: false }

engine.dispose();
```

---

## API overview

```ts
const engine = await Engine.create();
engine.dispose(); // kills running processes and frees the engine

// Filesystem (relative paths are relative to "/")
await engine.fs.mount(tree | tarOrZipBytes | url, { at: '/' });
await engine.fs.export({ format: 'tree' | 'tar' | 'zip', at, include, exclude });
await engine.fs.readFile(path, 'utf8'); // or Uint8Array without an encoding
await engine.fs.writeFile(path, contents);
(await engine.fs.mkdir(path, { recursive }), remove(path, { recursive }), rename(from, to));
(await engine.fs.stat(path), readDir(path));

// Processes: toolchains (cpp, rust, python), built-ins (clang, clang++, lld, rustc),
// or WASI executables (a URL, a path like /build/main or ./main, or bytes)
const proc = engine.run('cpp', ['program', 'args'], {
  env,
  sysroot,
  debug,
  stdin, // pipes (by default, stdin is closed, and new stdout and stderr pipes flow; `stdin: true` opens it)
  stdout,
  stderr,
  devices: { '/dev/in': new Pipe(), '/dev/fb': new SharedArrayBuffer(size) },
  ...toolchainOptions
});
proc.stdin.write('input'); // with `stdin: true` or your own pipe
proc.stdin.close();
proc.stdout.on('data', fn);
proc.stderr.on('data', fn);
proc.kill(); // resolves with { exitCode: 137, killed: true }
await proc; // { exitCode, killed }

// Pipes: buffered byte streams, shared with processes as stdio or devices
const pipe = new Pipe({ capacity: 4096, close: true }); // closed once a process using it exits
await pipe.write('bytes');
await pipe.read(); // or `for await (const chunk of pipe)`, `pipe.lines()`
pipe.flow(); // consume every chunk as it arrives, firing `data` (and `end`)
pipe.close();

// Debugging: the program starts once the debugger first continues (or steps)
const dbg = engine.run('python', { debug: true }).debugger;
await dbg.setBreakpoints('main.py', [{ line: 3 }]); // [{ verified: true, line: 3 }]
const stop = await dbg.continue(); // or stepIn, stepOver, stepOut: null once the program exits
stop?.frames()[0].locals().vars(); // frames, scopes and variables are queried on each call
dbg.on('stop', fn);
dbg.dap.send(request); // or use the Debug Adapter Protocol (DAP) directly
dbg.dap.on('event', fn);
```

The full interface is described in [docs/rewrite/interface.md](./docs/rewrite/interface.md), and the
debugger integration in the [integration guide](./docs/integration.md#debugger-dap).

---

## Example project

For a full reference integration, see the [debugger.sh IDE](https://github.com/debugger-sh/debugger.sh) — a Next.js + MUI app wiring up CodeMirror 6, xterm.js, and `debugger-sh` into a working in-browser IDE.

---

## Contributing / building from source

> Requires [rustup](https://rustup.rs/) (the nightly toolchain pinned in `rust-toolchain.toml` is needed to
> build shared-memory WebAssembly), [wasm-pack](https://rustwasm.github.io/wasm-pack/), and Node v22+.

```bash
cargo install wasm-pack
npm install
npm run build          # wasm-pack build --target web && vite build
npm run dev            # local development
npm test               # tests/browser/tests, run in Chromium (Vitest)
npm run tools:dap      # DAP integration tests
```

To test against the reference IDE, clone [debugger-sh/debugger.sh](https://github.com/debugger-sh/debugger.sh) alongside this repo and link:

```bash
npm link                  # in this repo
cd ../debugger.sh
npm link debugger-sh
npm run dev
```
