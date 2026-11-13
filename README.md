<p align="center">
  <img alt="debugger-sh" src="docs/logo.png" width="280" />
</p>

A browser-based execution engine powered by WebAssembly. Compile, run, and debug C/C++, Rust and Python programs entirely in the browser.

## Installation

```bash
npm install debugger-sh
```

> To use this library, these response headers must be enabled in your server [[learn more]](https://web.dev/articles/why-coop-coep):
>
> ```
> Cross-Origin-Embedder-Policy: require-corp
> Cross-Origin-Opener-Policy: same-origin
> ```

---

## Quickstart

```ts
import { Engine } from 'debugger-sh';

/* Create the engine with some files */
const engine = await Engine.create({
  fs: {
    'main.cpp': `
      #include <iostream>
      int main() { std::cout << "Hello, world!" << std::endl; }`
  }
});

/* Compile and run C++ programs */
const proc = engine.run('cpp');
proc.stdout.on('text', (output) => console.log(output));
console.log(await proc); // { exitCode: 0, killed: false }

/* Dipose of the engine's resources when you're done */
engine.dispose();
```

## API Overview

```ts
// ╭─────────────────────────────────────────────────────────────╮
// │ Debugging                                                   │
// ╰─────────────────────────────────────────────────────────────╯

const engine = await Engine.create({
  fs: {
    'main.cpp': `int main() {
        int x = 42;
        return x;
      }`
  }
});

const proc = engine.run('cpp', { debug: true });
await proc.debugger.setBreakpoints('main.cpp', [{ line: 3 }]);

const stop = await proc.debugger.continue();
console.log(stop!.frames()[0].locals().vars());
await proc.debugger.continue();

/**
 * Output:
 *
 *  [{ name: 'x', value: '42', type: 'int' }]
 */


// ╭─────────────────────────────────────────────────────────────╮
// │ Toolchain Support                                           │
// ╰─────────────────────────────────────────────────────────────╯

/* C++ (clang v22.1) */
engine.run('cpp', ['passed', 'to', 'main'], {
  sources: ['**/*.cpp'],
  buildDir: '/build',
  cxxFlags: ['-O2', '-DDEBUG'],
  lldFlags: ['--export-all']
});

// Run clang/clang++ and lld directly:
//
//  engine.run('clang',   [/* flags */], { sysroot: 'cpp' });
//  engine.run('clang++', [/* flags */], { sysroot: 'cpp' });
//  engine.run('lld',     [/* flags */], { sysroot: 'cpp' });
//

/* Rust (rustc v1.96) */
engine.run('rust', ['passed', 'to', 'main'], {
  sources: ['**/*.rs'],
  buildDir: '/build',
  rustcFlags: ['-Copt-level=1'],
  lldFlags: ['--export-all']
});

// Run rustc directly:
//
//  engine.run('rustc', [/* flags */], { sysroot: 'cpp' });
//

/* Python (cpython 3.11) */
engine.run('python', ['main.py', '--arg1']);


// ╭─────────────────────────────────────────────────────────────╮
// │ Filesystem                                                  │
// ╰─────────────────────────────────────────────────────────────╯

/* Mount from JSON */
await fs.mount({
  'main.py': "print('Crazy, crazy, crazy');",
  tmp: {
    files: [
      bin: { files: [] },
      'random.txt': "Stored in memory!"
    ]
  }
});

/* Mount from .tar.gz or .zip archive to a subpath */
await fs.mount("https://example.com/archive.tar.gz", { at: "/tmp/archive"});

await engine.fs.mkdir('/tmp/data', { recursive: true });
await engine.fs.readFile('/main.cpp', 'utf8'); // string
await engine.fs.readFile('/main.cpp', 'utf8'); // Uint8Array
await engine.fs.writeFile('/hello.txt', "world");
await engine.fs.rename('/hello.txt', '/world.txt');
await engine.fs.remove("/tmp/archive", { recursive: true });
await engine.fs.stat("/hello.txt");
await engine.fs.readDir("/tmp");

/* Export to JSON */
await engine.fs.export();

/* Export objects in build directory to zip */
await engine.fs.export({ at: "/build", include: ["**/*.o"], format: 'zip' });


// ╭─────────────────────────────────────────────────────────────╮
// │ Standard I/O                                                │
// ╰─────────────────────────────────────────────────────────────╯

const proc = engine.run("python", { stdin: true });

proc.stdout.on("data", chunk => terminal.write(chunk));
proc.stderr.on("data", chunk => terminal.write(chunk));

await proc.stdin.write("Et tu, Brute?");
proc.stdin.close();


// ╭─────────────────────────────────────────────────────────────╮
// │ Pipes                                                       │
// ╰─────────────────────────────────────────────────────────────╯

import { Pipe } from 'debugger-sh';

const pipe = new Pipe();
const p1 = engine.run("python", ["producer.py"], { stdout: pipe });
const p2 = engine.run("python", ["consumer.py"], { stdin: pipe });


// ╭─────────────────────────────────────────────────────────────╮
// │ Devices                                                     │
// ╰─────────────────────────────────────────────────────────────╯

const input = new Pipe();
const output = new Pipe()

await engine.fs.writeFile('main.py', `
  data = open('/dev/in').read()
  open('/dev/out', 'w').write(data)
`);

output.on("text", console.log);
await input.write("I put a spell on you");
input.close();

await engine.run("python", ["main.py"], {
  devices: {
    "/dev/in": input,
    "/dev/out": output
  }
});
```

## Running Locally

> Requires [rustup](https://rustup.rs/) and [Node](https://nodejs.org/en) v22+.

```bash
cargo install wasm-pack
npm install
npm run build           # wasm-pack build --target web && vite build

npm run dev             # Hot rebuild library on changes
npm test                # Tests browser functionality
npm run tools:dap       # Test debugger functionality
```
