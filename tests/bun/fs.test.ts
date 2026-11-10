import { afterAll, beforeEach, expect, test } from 'bun:test';
import { Engine } from 'debugger-sh';

let engine: Engine;
beforeEach(async () => {
  engine?.dispose();
  engine = await Engine.create();
});
afterAll(() => engine.dispose());

test('mount creates files and directories from a tree', async () => {
  await engine.fs.mount({ 'main.cpp': 'int main() {}', data: { files: { 'res.txt': 'Jacob' } } });
  expect(await engine.fs.readDir('/')).toEqual(['data', 'main.cpp']);
  expect(await engine.fs.readFile('/data/res.txt', 'utf8')).toBe('Jacob');
});

test('mount accepts bytes, base64 and utf8 contents', async () => {
  await engine.fs.mount({
    'bytes.bin': new Uint8Array([1, 2, 3]),
    'b64.txt': { contents: btoa('hello'), encoding: 'base64' },
    'utf8.txt': { contents: 'héllo', encoding: 'utf8' }
  });
  expect(await engine.fs.readFile('bytes.bin')).toEqual(new Uint8Array([1, 2, 3]));
  expect(await engine.fs.readFile('b64.txt', 'utf8')).toBe('hello');
  expect(await engine.fs.readFile('utf8.txt', 'utf8')).toBe('héllo');
});

test('mount sets modified and accessed timestamps', async () => {
  const modified = '2026-11-09T12:00:00.000Z';
  await engine.fs.mount({ 'a.txt': { contents: 'a', modified, accessed: new Date(modified) } });
  const stat = await engine.fs.stat('a.txt');
  expect(stat.modified).toBe(Date.parse(modified));
  expect(stat.accessed).toBe(Date.parse(modified));
});

test('mount is additive and overrides conflicting files', async () => {
  await engine.fs.mount({ 'a.txt': 'a', 'b.txt': 'b' });
  await engine.fs.mount({ 'b.txt': 'B', 'c.txt': 'c' });
  expect(await engine.fs.readDir('/')).toEqual(['a.txt', 'b.txt', 'c.txt']);
  expect(await engine.fs.readFile('b.txt', 'utf8')).toBe('B');
});

test('mount at a directory', async () => {
  await engine.fs.mount({ 'a.txt': 'a' }, { at: '/deep/dir' });
  expect(await engine.fs.readFile('/deep/dir/a.txt', 'utf8')).toBe('a');
});

test('tarballs round-trip through export and mount', async () => {
  await engine.fs.mount({ 'a.txt': 'a', dir: { files: { 'b.bin': new Uint8Array([0, 255]) } } });
  const tarball = await engine.fs.export({ format: 'tar' });
  const other = await Engine.create();
  await other.fs.mount(tarball, { at: '/copy' });
  expect(await other.fs.readFile('/copy/a.txt', 'utf8')).toBe('a');
  expect(await other.fs.readFile('/copy/dir/b.bin')).toEqual(new Uint8Array([0, 255]));
  other.dispose();
});

test('zips round-trip through export and mount', async () => {
  await engine.fs.mount({ 'a.txt': 'a', dir: { files: { 'b.txt': 'b' } } });
  const zip = await engine.fs.export({ format: 'zip' });
  expect([zip[0], zip[1]]).toEqual([0x50, 0x4b]); // "PK"
  const other = await Engine.create();
  await other.fs.mount(zip);
  expect(await other.fs.readFile('/dir/b.txt', 'utf8')).toBe('b');
  other.dispose();
});

test('mount fetches archives from URLs', async () => {
  await engine.fs.mount({ 'a.txt': 'from url' });
  const tarball = await engine.fs.export({ format: 'tarball' });
  const server = Bun.serve({ port: 0, fetch: () => new Response(tarball) });
  const other = await Engine.create();
  await other.fs.mount(`http://localhost:${server.port}/fs.tar.gz`);
  expect(await other.fs.readFile('a.txt', 'utf8')).toBe('from url');
  other.dispose();
  server.stop();
});

test('export produces a tree with encodings and timestamps', async () => {
  const modified = '2026-11-09T12:00:00.000Z';
  await engine.fs.mount({
    'a.txt': { contents: 'a', modified },
    dir: { files: { 'b.bin': new Uint8Array([255]) } }
  });
  const tree = await engine.fs.export();
  expect(tree['a.txt']).toMatchObject({ contents: 'a', encoding: 'utf8', modified });
  expect(tree['dir']).toMatchObject({
    files: { 'b.bin': { contents: btoa('\xff'), encoding: 'base64' } }
  });
  expect(tree['dir']).toHaveProperty('created');
});

test('export trees can be mounted', async () => {
  await engine.fs.mount({ 'a.txt': 'a', dir: { files: { 'b.bin': new Uint8Array([1, 255]) } } });
  const other = await Engine.create();
  await other.fs.mount(await engine.fs.export());
  expect(await other.fs.readFile('a.txt', 'utf8')).toBe('a');
  expect(await other.fs.readFile('dir/b.bin')).toEqual(new Uint8Array([1, 255]));
  other.dispose();
});

test('export at a directory with include and exclude globs', async () => {
  await engine.fs.mount({
    build: { files: { 'main.o': 'o', 'main.d': 'd', sub: { files: { 'x.o': 'x' } } } }
  });
  const tree = await engine.fs.export({ at: '/build', include: ['**/*.o'], exclude: ['sub/**'] });
  expect(Object.keys(tree)).toEqual(['main.o']);
});

test('writeFile and readFile', async () => {
  await engine.fs.writeFile('/a.txt', 'text');
  await engine.fs.writeFile('/b.bin', new Uint8Array([7]));
  expect(await engine.fs.readFile('/a.txt', 'utf8')).toBe('text');
  expect(await engine.fs.readFile('/b.bin')).toEqual(new Uint8Array([7]));
});

test('readFile of a missing file rejects', async () => {
  await expect(engine.fs.readFile('/missing')).rejects.toThrow();
});

test('mkdir, recursively and not', async () => {
  await engine.fs.mkdir('/a');
  await engine.fs.mkdir('/b/c/d', { recursive: true });
  await expect(engine.fs.mkdir('/x/y')).rejects.toThrow();
  expect(await engine.fs.readDir('/b/c')).toEqual(['d']);
});

test('remove files and directories', async () => {
  await engine.fs.mount({ 'a.txt': 'a', dir: { files: { 'b.txt': 'b' } } });
  await engine.fs.remove('a.txt');
  await expect(engine.fs.remove('dir')).rejects.toThrow();
  await engine.fs.remove('dir', { recursive: true });
  expect(await engine.fs.readDir('/')).toEqual([]);
});

test('rename', async () => {
  await engine.fs.writeFile('a.txt', 'a');
  await engine.fs.rename('a.txt', 'b.txt');
  expect(await engine.fs.readDir('/')).toEqual(['b.txt']);
});

test('stat files and directories', async () => {
  await engine.fs.mount({ 'a.txt': 'abc', dir: { files: {} } });
  expect(await engine.fs.stat('a.txt')).toMatchObject({ kind: 'file', size: 3 });
  expect(await engine.fs.stat('dir')).toMatchObject({ kind: 'directory' });
});

test('relative paths are relative to the root', async () => {
  await engine.fs.writeFile('data.txt', 'x');
  expect(await engine.fs.readFile('/data.txt', 'utf8')).toBe('x');
  expect(await engine.fs.readFile('./dir/../data.txt', 'utf8')).toBe('x');
});
