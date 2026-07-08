import { existsSync } from 'node:fs';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { CACHE } from '../../lib/cache.ts';
import { downloadFile } from '../../lib/download.ts';
import { RUSTC_VERSION } from '../../lib/engine-toolchain.ts';
import { extractTar } from '../../lib/extract.ts';
import { hostTriple } from '../../lib/platform.ts';
import { shellQuote } from '../../lib/shell.ts';
import type { BenchmarkPolicy, LocalRun } from '../../policy.ts';

const RUST_CACHE = path.join(CACHE, 'rust');
const BUILD_CACHE = path.join(CACHE, 'rust-build');

function rustArchiveName(): string {
  return `rust-${RUSTC_VERSION}-${hostTriple()}.tar.xz`;
}

function rustDownloadUrl(): string {
  return `https://static.rust-lang.org/dist/${rustArchiveName()}`;
}

function toolchainRoot(): string {
  return path.join(RUST_CACHE, `rust-${RUSTC_VERSION}-${hostTriple()}`);
}

function rustcPath(): string {
  return path.join(toolchainRoot(), 'rustc', 'bin', 'rustc');
}

function binaryPath(sourcePath: string): string {
  const base = path.basename(sourcePath, path.extname(sourcePath));
  return path.join(BUILD_CACHE, `${base}.bin`);
}

async function mergeHostStd(root: string): Promise<void> {
  const triple = hostTriple();
  const merged = path.join(root, 'rustc', 'lib', 'rustlib', triple, 'lib', '.bench-merged-std');
  if (existsSync(merged)) return;

  const stdLib = path.join(root, `rust-std-${triple}`, 'lib', 'rustlib');
  const sysrootLib = path.join(root, 'rustc', 'lib', 'rustlib');
  if (!existsSync(stdLib)) {
    throw new Error(`missing rust-std component under ${root}`);
  }

  await cp(stdLib, sysrootLib, { recursive: true, force: true });
  await mkdir(path.dirname(merged), { recursive: true });
  await writeFile(merged, '');
}

async function ensureRustc(): Promise<string> {
  const root = toolchainRoot();
  const rustc = rustcPath();
  if (existsSync(rustc)) {
    await mergeHostStd(root);
    return rustc;
  }

  await mkdir(RUST_CACHE, { recursive: true });

  const archive = path.join(RUST_CACHE, rustArchiveName());
  if (!existsSync(archive)) {
    console.log(`downloading Rust ${RUSTC_VERSION} (${hostTriple()})...`);
    await downloadFile(rustDownloadUrl(), archive, rustArchiveName());
  }

  console.log(`extracting ${archive}...`);
  await extractTar(archive, RUST_CACHE, 'xz');
  await mergeHostStd(toolchainRoot());

  if (!existsSync(rustc)) {
    throw new Error(`could not find rustc under ${toolchainRoot()}`);
  }
  return rustc;
}

export class RustPolicy implements BenchmarkPolicy {
  readonly name = 'rust';

  private rustc = '';

  async setupLocal(): Promise<void> {
    this.rustc = await ensureRustc();
    await mkdir(BUILD_CACHE, { recursive: true });
  }

  async runLocal(sourcePath: string): Promise<LocalRun> {
    const abs = path.resolve(sourcePath);
    const out = binaryPath(abs);

    const compile = [
      shellQuote(this.rustc),
      shellQuote(abs),
      '-o',
      shellQuote(out),
      '-Copt-level=0',
      '-g',
      '-Cpanic=abort',
      '-Ccodegen-units=1'
    ].join(' ');

    return {
      type: 'command',
      cmd: '/bin/sh',
      args: ['-c', `${compile} && exec ${shellQuote(out)}`]
    };
  }
}

export default new RustPolicy();
