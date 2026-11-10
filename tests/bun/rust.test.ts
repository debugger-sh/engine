import { afterAll, beforeEach, expect, test } from 'bun:test';
import { Engine } from 'debugger-sh';

import { output } from './helpers';

let engine: Engine;
beforeEach(async () => {
  engine?.dispose();
  engine = await Engine.create();
});
afterAll(() => engine.dispose());

test('compiles, links and runs', async () => {
  await engine.fs.mount({ 'main.rs': 'fn main() { println!("hello"); }' });
  expect(await output(engine.run('rust'))).toMatchObject({ exitCode: 0, stdout: 'hello\n' });
});

test('forwards args and returns the exit code', async () => {
  await engine.fs.mount({
    'main.rs':
      'fn main() { let a: Vec<String> = std::env::args().collect(); print!("{}", a[1]); std::process::exit(5) }'
  });
  expect(await output(engine.run('rust', ['arg']))).toMatchObject({ exitCode: 5, stdout: 'arg' });
});

test('compile errors exit non-zero', async () => {
  await engine.fs.mount({ 'main.rs': 'fn main() { nope }' });
  const result = await output(engine.run('rust'));
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain('error');
});

test('places objects and the executable in buildDir', async () => {
  await engine.fs.mount({ src: { files: { 'main.rs': 'fn main() {}' } } });
  await engine.run('rust', { buildDir: '/out' });
  expect(await engine.fs.readDir('/out')).toContain('main');
  expect(await engine.fs.readDir('/out/src')).toContain('main.rs.o');
});

test('rustFlags are passed to rustc', async () => {
  await engine.fs.mount({
    'main.rs':
      '#[cfg(not(feature = "x"))] fn main() { std::process::exit(1) } #[cfg(feature = "x")] fn main() {}'
  });
  expect((await engine.run('rust', { rustFlags: ['--cfg', 'feature="x"'] })).exitCode).toBe(0);
});

test('rebuilds are correct', async () => {
  await engine.fs.mount({ 'main.rs': 'fn main() { std::process::exit(1) }' });
  expect((await engine.run('rust')).exitCode).toBe(1);
  await engine.fs.writeFile('main.rs', 'fn main() { std::process::exit(2) }');
  expect((await engine.run('rust')).exitCode).toBe(2);
});

test('rustc can be run on its own', async () => {
  await engine.fs.mount({ 'main.rs': 'fn main() {}' });
  const args = [
    '/main.rs',
    '--sysroot',
    '/',
    '--target',
    'wasm32-wasip1',
    '--emit=obj',
    '-o',
    '/main.o'
  ];
  expect((await engine.run('rustc', args, { sysroot: 'rust' })).exitCode).toBe(0);
  expect(await engine.fs.readDir('/')).toContain('main.o');
});
