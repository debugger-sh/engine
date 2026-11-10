import { expect, test } from 'vitest';

import { createEngine } from '../helpers';

test('export at a directory with include and exclude globs', async () => {
  const { fs } = await createEngine({
    build: { files: { 'main.o': 'o', 'main.d': 'd', sub: { files: { 'x.o': 'x' } } } }
  });
  const tree = await fs.export({ at: '/build', include: ['**/*.o'], exclude: ['sub/**'] });
  expect(Object.keys(tree)).toEqual(['main.o']);
});

test('exported trees can be mounted', async () => {
  const source = await createEngine({
    'a.txt': 'a',
    dir: { files: { 'b.bin': new Uint8Array([1, 255]) } }
  });
  const { fs } = await createEngine(await source.fs.export());
  expect(await fs.readFile('a.txt', 'utf8')).toBe('a');
  expect(await fs.readFile('dir/b.bin')).toEqual(new Uint8Array([1, 255]));
});

test('export produces a tree with encodings and timestamps', async () => {
  const modified = '2026-11-09T12:00:00.000Z';
  const { fs } = await createEngine({
    'a.txt': { contents: 'a', modified },
    dir: { files: { 'b.bin': new Uint8Array([255]) } }
  });
  const tree = await fs.export();
  expect(tree['a.txt']).toMatchObject({ contents: 'a', encoding: 'utf8', modified });
  expect(tree['dir']).toMatchObject({
    files: { 'b.bin': { contents: btoa('\xff'), encoding: 'base64' } }
  });
  expect(tree['dir']).toHaveProperty('created');
});

test('mkdir, recursively and not', async () => {
  const { fs } = await createEngine();
  await fs.mkdir('/a');
  await fs.mkdir('/b/c/d', { recursive: true });
  await expect(fs.mkdir('/x/y')).rejects.toThrow();
  expect(await fs.readDir('/b/c')).toEqual(['d']);
});

test('mount is additive and overrides conflicting files', async () => {
  const { fs } = await createEngine({ 'a.txt': 'a', 'b.txt': 'b' });
  await fs.mount({ 'b.txt': 'B', 'c.txt': 'c' });
  expect(await fs.readDir('/')).toEqual(['a.txt', 'b.txt', 'c.txt']);
  expect(await fs.readFile('b.txt', 'utf8')).toBe('B');
});

test('mount at a directory', async () => {
  const { fs } = await createEngine();
  await fs.mount({ 'a.txt': 'a' }, { at: '/deep/dir' });
  expect(await fs.readFile('/deep/dir/a.txt', 'utf8')).toBe('a');
});

test('mount accepts bytes, base64 and utf8 contents', async () => {
  const { fs } = await createEngine({
    'bytes.bin': new Uint8Array([1, 2, 3]),
    'b64.txt': { contents: btoa('hello'), encoding: 'base64' },
    'utf8.txt': { contents: 'héllo', encoding: 'utf8' }
  });
  expect(await fs.readFile('bytes.bin')).toEqual(new Uint8Array([1, 2, 3]));
  expect(await fs.readFile('b64.txt', 'utf8')).toBe('hello');
  expect(await fs.readFile('utf8.txt', 'utf8')).toBe('héllo');
});

test('mount sets modified and accessed timestamps', async () => {
  const modified = '2026-11-09T12:00:00.000Z';
  const { fs } = await createEngine({
    'a.txt': { contents: 'a', modified, accessed: new Date(modified) }
  });
  expect(await fs.stat('a.txt')).toMatchObject({
    modified: Date.parse(modified),
    accessed: Date.parse(modified)
  });
});

test('mount creates files and directories from a tree', async () => {
  const { fs } = await createEngine({
    'main.cpp': 'int main() {}',
    data: { files: { 'res.txt': 'Jacob' } }
  });
  expect(await fs.readDir('/')).toEqual(['data', 'main.cpp']);
  expect(await fs.readFile('/data/res.txt', 'utf8')).toBe('Jacob');
});

test('mount fetches archives from URLs', async () => {
  const source = await createEngine({ 'a.txt': 'from url' });
  const tarball = await source.fs.export({ format: 'tarball' });
  const { fs } = await createEngine();
  await fs.mount(URL.createObjectURL(new Blob([tarball as Uint8Array<ArrayBuffer>])));
  expect(await fs.readFile('a.txt', 'utf8')).toBe('from url');
});

test('readFile of a missing file rejects', async () => {
  const { fs } = await createEngine();
  await expect(fs.readFile('/missing')).rejects.toThrow();
});

test('writeFile and readFile', async () => {
  const { fs } = await createEngine();
  await fs.writeFile('/a.txt', 'text');
  await fs.writeFile('/b.bin', new Uint8Array([7]));
  expect(await fs.readFile('/a.txt', 'utf8')).toBe('text');
  expect(await fs.readFile('/b.bin')).toEqual(new Uint8Array([7]));
});

test('relative paths are relative to the root', async () => {
  const { fs } = await createEngine();
  await fs.writeFile('data.txt', 'x');
  expect(await fs.readFile('/data.txt', 'utf8')).toBe('x');
  expect(await fs.readFile('./dir/../data.txt', 'utf8')).toBe('x');
});

test('remove files and directories', async () => {
  const { fs } = await createEngine({ 'a.txt': 'a', dir: { files: { 'b.txt': 'b' } } });
  await fs.remove('a.txt');
  await expect(fs.remove('dir')).rejects.toThrow();
  await fs.remove('dir', { recursive: true });
  expect(await fs.readDir('/')).toEqual([]);
});

test('rename', async () => {
  const { fs } = await createEngine({ 'a.txt': 'a' });
  await fs.rename('a.txt', 'b.txt');
  expect(await fs.readDir('/')).toEqual(['b.txt']);
});

test('stat files and directories', async () => {
  const { fs } = await createEngine({ 'a.txt': 'abc', dir: { files: {} } });
  expect(await fs.stat('a.txt')).toMatchObject({ kind: 'file', size: 3 });
  expect(await fs.stat('dir')).toMatchObject({ kind: 'directory' });
});

test('tarballs round-trip through export and mount', async () => {
  const source = await createEngine({
    'a.txt': 'a',
    dir: { files: { 'b.bin': new Uint8Array([0, 255]) } }
  });
  const { fs } = await createEngine();
  await fs.mount(await source.fs.export({ format: 'tar' }), { at: '/copy' });
  expect(await fs.readFile('/copy/a.txt', 'utf8')).toBe('a');
  expect(await fs.readFile('/copy/dir/b.bin')).toEqual(new Uint8Array([0, 255]));
});

test('zips round-trip through export and mount', async () => {
  const source = await createEngine({ 'a.txt': 'a', dir: { files: { 'b.txt': 'b' } } });
  const zip = await source.fs.export({ format: 'zip' });
  expect([zip[0], zip[1]]).toEqual([0x50, 0x4b]); // "PK"
  const { fs } = await createEngine();
  await fs.mount(zip);
  expect(await fs.readFile('/dir/b.txt', 'utf8')).toBe('b');
});
