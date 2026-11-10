import { expect, test } from 'vitest';

import { createEngine, output } from '../../helpers';

test('forwards args and returns the exit code', async () => {
  const engine = await createEngine({
    'main.rs': 'fn main() { print!("{}", std::env::args().nth(1).unwrap()); std::process::exit(5) }'
  });
  expect(await output(engine.run('rust', ['arg']))).toMatchObject({ exitCode: 5, stdout: 'arg' });
});

test('places objects and the executable in buildDir', async () => {
  const engine = await createEngine({ src: { files: { 'main.rs': 'fn main() {}' } } });
  await engine.run('rust', { buildDir: '/out' });
  expect(await engine.fs.readDir('/out')).toContain('main');
  expect(await engine.fs.readDir('/out/src')).toContain('main.rs.o');
});

test('compile errors exit non-zero', async () => {
  const engine = await createEngine({ 'main.rs': 'fn main() { nope }' });
  const result = await output(engine.run('rust'));
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain('error');
});

test('compiles, links and runs', async () => {
  const engine = await createEngine({ 'main.rs': 'fn main() { println!("hello"); }' });
  expect(await output(engine.run('rust'))).toMatchObject({ exitCode: 0, stdout: 'hello\n' });
});

test('rebuilds pick up changes', async () => {
  const engine = await createEngine({ 'main.rs': 'fn main() { std::process::exit(1) }' });
  expect((await engine.run('rust')).exitCode).toBe(1);
  await engine.fs.writeFile('main.rs', 'fn main() { std::process::exit(2) }');
  expect((await engine.run('rust')).exitCode).toBe(2);
});

test('rustFlags are passed to rustc', async () => {
  const engine = await createEngine({
    'main.rs': '#[cfg(not(x))] fn main() { std::process::exit(1) } #[cfg(x)] fn main() {}'
  });
  expect((await engine.run('rust', { rustFlags: ['--cfg', 'x'] })).exitCode).toBe(0);
});

test('rustc can be run on its own', async () => {
  const engine = await createEngine({ 'main.rs': 'fn main() {}' });
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
