import { Engine } from '/dist/debugger-sh.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function expect(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function output(proc) {
  const decoder = new TextDecoder();
  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (chunk) => (stdout += decoder.decode(chunk)));
  proc.stderr.on('data', (chunk) => (stderr += decoder.decode(chunk)));
  return { ...(await proc), stdout, stderr };
}

const HELLO =
  '#include <cstdio>\nint main(int c, char** v) { printf("hello %s\\n", c > 1 ? v[1] : ""); }';

test('the page is cross-origin isolated', () => expect(crossOriginIsolated, true));

test('filesystem: mount, read, write, stat, readDir', async () => {
  const engine = await Engine.create();
  await engine.fs.mount({ 'a.txt': 'a', dir: { files: { 'b.bin': new Uint8Array([1, 2]) } } });
  await engine.fs.writeFile('c.txt', 'c');
  expect(await engine.fs.readDir('/'), ['a.txt', 'c.txt', 'dir']);
  expect(await engine.fs.readFile('/a.txt', 'utf8'), 'a');
  expect([...(await engine.fs.readFile('dir/b.bin'))], [1, 2]);
  expect((await engine.fs.stat('dir')).kind, 'directory');
  engine.dispose();
});

test('filesystem: mkdir, rename, remove', async () => {
  const engine = await Engine.create();
  await engine.fs.mkdir('/x/y', { recursive: true });
  await engine.fs.writeFile('/x/y/f', 'f');
  await engine.fs.rename('/x/y/f', '/x/g');
  await engine.fs.remove('/x/y');
  expect(await engine.fs.readDir('/x'), ['g']);
  engine.dispose();
});

test('filesystem: export and mount archives', async () => {
  const engine = await Engine.create();
  await engine.fs.mount({ 'a.txt': 'a', dir: { files: { 'b.txt': 'b' } } });
  const other = await Engine.create();
  await other.fs.mount(await engine.fs.export({ format: 'zip' }), { at: '/zip' });
  await other.fs.mount(await engine.fs.export({ format: 'tar' }), { at: '/tar' });
  await other.fs.mount(await engine.fs.export({ include: ['dir/**'] }), { at: '/tree' });
  expect(await other.fs.readFile('/zip/dir/b.txt', 'utf8'), 'b');
  expect(await other.fs.readFile('/tar/a.txt', 'utf8'), 'a');
  expect(await other.fs.readDir('/tree'), ['dir']);
  engine.dispose();
  other.dispose();
});

test('cpp: compiles, links and runs', async () => {
  const engine = await Engine.create();
  await engine.fs.mount({ 'main.cpp': HELLO });
  const result = await output(engine.run('cpp', ['web']));
  expect([result.exitCode, result.stdout], [0, 'hello web\n']);
  engine.dispose();
});

test('cpp: cached rebuilds and parallel compilation', async () => {
  const engine = await Engine.create();
  const files = {
    'main.cpp': 'int f0(); int f1(); int f2(); int main() { return f0() + f1() + f2(); }'
  };
  for (let i = 0; i < 3; i++) files[`f${i}.cpp`] = `int f${i}() { return ${i + 1}; }`;
  await engine.fs.mount(files);
  expect((await engine.run('cpp')).exitCode, 6);
  const { modified } = await engine.fs.stat('/build/f0.cpp.o');
  await engine.fs.writeFile('f2.cpp', 'int f2() { return 10; }');
  expect((await engine.run('cpp')).exitCode, 13);
  expect((await engine.fs.stat('/build/f0.cpp.o')).modified, modified);
  engine.dispose();
});

test('rust: compiles, links and runs', async () => {
  const engine = await Engine.create();
  await engine.fs.mount({ 'main.rs': 'fn main() { println!("hello rust"); }' });
  expect((await output(engine.run('rust'))).stdout, 'hello rust\n');
  engine.dispose();
});

test('python: runs scripts with stdin', async () => {
  const engine = await Engine.create();
  await engine.fs.mount({ 'main.py': 'print(input().upper())' });
  const proc = engine.run('python');
  await proc.stdin.write('shout\n');
  expect((await output(proc)).stdout, 'SHOUT\n');
  engine.dispose();
});

test('processes: errors, kill and shared files', async () => {
  const engine = await Engine.create();
  expect((await output(engine.run('nope'))).stderr, 'nope: command not found\n');
  await engine.fs.mount({
    'main.cpp':
      '#include <cstdio>\nint main(int c, char** v) { if (c > 1) for (;;) {} fputs("x", fopen("/o.txt", "w")); }'
  });
  await engine.run('cpp');
  expect(await engine.fs.readFile('/o.txt', 'utf8'), 'x');
  const looping = engine.run('/build/main', ['loop']);
  const other = await engine.run('/build/main');
  looping.kill();
  expect(
    [other, await looping],
    [
      { exitCode: 0, killed: false },
      { exitCode: 137, killed: true }
    ]
  );
  engine.dispose();
});

test('processes: killing mid-I/O never deadlocks the filesystem', async () => {
  const engine = await Engine.create();
  await engine.fs.mount({
    'main.cpp':
      '#include <cstdio>\nint main(int c, char**) { while (c > 1) { fputs("s", fopen("/s.txt", "w")); printf("."); } }'
  });
  await engine.run('cpp');
  for (let i = 0; i < 20; i++) {
    const procs = Array.from({ length: 4 }, () => engine.run('/build/main', ['spam']));
    await new Promise((r) => setTimeout(r, 20 + i * 5));
    procs.forEach((proc) => proc.kill());
    await engine.fs.writeFile('/after.txt', `${i}`);
  }
  expect(await engine.fs.readFile('/after.txt', 'utf8'), '19');
  engine.dispose();
});

test('debugger: breakpoints', async () => {
  const engine = await Engine.create();
  await engine.fs.mount({
    'main.cpp': '#include <cstdio>\nint main() {\n  int x = 1;\n  printf("%d", x);\n}'
  });
  const proc = engine.run('cpp', { debug: true });
  const next = (name) =>
    new Promise((resolve) => {
      const check = (e) => e.event === name && (proc.debugger.off('event', check), resolve(e));
      proc.debugger.on('event', check);
    });
  const initialized = next('initialized');
  proc.debugger.send({ type: 'request', seq: 1, command: 'initialize', arguments: {} });
  await initialized;
  proc.debugger.send({
    type: 'request',
    seq: 2,
    command: 'setBreakpoints',
    arguments: { source: { path: '/main.cpp' }, breakpoints: [{ line: 4 }] }
  });
  const stopped = next('stopped');
  proc.debugger.send({ type: 'request', seq: 3, command: 'configurationDone' });
  expect((await stopped).body.reason, 'breakpoint');
  proc.debugger.send({ type: 'request', seq: 4, command: 'continue', arguments: { threadId: 1 } });
  expect((await output(proc)).exitCode, 0);
  engine.dispose();
});

const filter = new URLSearchParams(location.search).get('filter') ?? '';
const failed = [];
const selected = tests.filter((t) => t.name.includes(filter));
for (const { name, fn } of selected) {
  const start = performance.now();
  try {
    await fn();
    console.log(`(pass) ${name} [${Math.round(performance.now() - start)}ms]`);
  } catch (err) {
    failed.push(name);
    console.log(`(fail) ${name}: ${err?.stack ?? err}`);
  }
}
console.log(`${selected.length - failed.length} pass, ${failed.length} fail`);
window.failed = failed;
