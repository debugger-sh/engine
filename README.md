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
  cwd,
  env,
  sysroot,
  debug,
  ...toolchainOptions
});
proc.stdin.write('input');
proc.stdin.close();
proc.stdout.on('data', fn);
proc.stderr.on('data', fn);
proc.kill(); // resolves with { exitCode: 137, killed: true }
await proc; // { exitCode, killed }

// Debugging (DAP): the process waits for the handshake
const debuggable = engine.run('python', { debug: true, filterInternals: true });
debuggable.debugger.send(request); // returns the response synchronously
debuggable.debugger.on('event', fn);
```

The full interface is described in [docs/rewrite/interface.md](./docs/rewrite/interface.md), and the
debugger integration in the [integration guide](./docs/integration.md#debugger-dap).

> WASI preview 1 programs (built with `wasi-libc`, like the bundled toolchains) always start in
> `/`, whatever their `cwd`, so toolchains pass them absolute paths.

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
