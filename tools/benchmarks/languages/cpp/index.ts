import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { cp, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import type { BenchmarkPolicy, LocalRun } from '../../policy.ts';

const LLVM_VERSION = '22.1.0';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BENCH_ROOT = path.resolve(HERE, '../..');
const CACHE = path.join(BENCH_ROOT, '.cache');
const LLVM_CACHE = path.join(CACHE, `llvm-${LLVM_VERSION}`);
const BUILD_CACHE = path.join(CACHE, 'cpp-build');

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function llvmArchiveName(): string {
  const { platform, arch } = process;
  if (platform === 'darwin') {
    return arch === 'arm64'
      ? `LLVM-${LLVM_VERSION}-macOS-ARM64.tar.xz`
      : `LLVM-${LLVM_VERSION}-macOS-X64.tar.xz`;
  }
  if (platform === 'linux') {
    return arch === 'arm64'
      ? `LLVM-${LLVM_VERSION}-Linux-ARM64.tar.xz`
      : `LLVM-${LLVM_VERSION}-Linux-X64.tar.xz`;
  }
  throw new Error(`unsupported platform for LLVM download: ${platform} ${arch}`);
}

function llvmDownloadUrl(): string {
  return `https://github.com/llvm/llvm-project/releases/download/llvmorg-${LLVM_VERSION}/${llvmArchiveName()}`;
}

async function run(cmd: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}`));
    });
  });
}

async function findExtractedRoot(): Promise<string> {
  const entries = await readdir(LLVM_CACHE);
  for (const entry of entries) {
    if (entry === 'bin' || entry === 'root') continue;
    const candidate = path.join(LLVM_CACHE, entry, 'bin', 'clang++');
    if (existsSync(candidate)) return path.join(LLVM_CACHE, entry);
  }
  throw new Error(`could not find clang++ under ${LLVM_CACHE}`);
}

async function ensureLlvm(): Promise<{ clang: string; clangpp: string }> {
  const root = path.join(LLVM_CACHE, 'root');
  const clangpp = path.join(root, 'bin', 'clang++');
  if (existsSync(clangpp)) {
    return { clang: path.join(root, 'bin', 'clang'), clangpp };
  }

  await mkdir(LLVM_CACHE, { recursive: true });
  const archive = path.join(LLVM_CACHE, llvmArchiveName());
  if (!existsSync(archive)) {
    console.log(`downloading LLVM ${LLVM_VERSION} (${llvmArchiveName()})...`);
    const res = await fetch(llvmDownloadUrl());
    if (!res.ok) throw new Error(`LLVM download failed: ${res.status} ${res.statusText}`);
    await pipeline(res.body!, createWriteStream(archive));
  }

  console.log(`extracting ${archive}...`);
  await run('tar', ['-xf', archive, '-C', LLVM_CACHE]);

  const extracted = await findExtractedRoot();
  await cp(extracted, root, { recursive: true });

  return { clang: path.join(root, 'bin', 'clang'), clangpp };
}

function macosSdk(): string | undefined {
  if (process.platform !== 'darwin') return undefined;
  const result = spawnSync('xcrun', ['--show-sdk-path'], { encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout) return undefined;
  return result.stdout.trim();
}

function binaryPath(sourcePath: string): string {
  const base = path.basename(sourcePath, path.extname(sourcePath));
  return path.join(BUILD_CACHE, `${base}.bin`);
}

export class CppPolicy implements BenchmarkPolicy {
  readonly name = 'cpp';

  private clang = '';
  private clangpp = '';

  async setupLocal(): Promise<void> {
    ({ clang: this.clang, clangpp: this.clangpp } = await ensureLlvm());
    await mkdir(BUILD_CACHE, { recursive: true });
  }

  async runLocal(sourcePath: string): Promise<LocalRun> {
    const abs = path.resolve(sourcePath);
    const out = binaryPath(abs);
    const ext = path.extname(abs).toLowerCase();
    const driver = ext === '.c' ? this.clang : this.clangpp;
    const stdFlag = ext === '.c' ? [] : ['-std=c++23'];
    const sdk = macosSdk();

    const compile = [
      shellQuote(driver),
      ...stdFlag,
      '-O0',
      '-g',
      '-gdwarf-5',
      '-fstandalone-debug',
      ...(sdk ? ['-isysroot', shellQuote(sdk)] : []),
      shellQuote(abs),
      '-o',
      shellQuote(out)
    ].join(' ');

    return {
      type: 'command',
      cmd: '/bin/sh',
      args: ['-c', `${compile} && exec ${shellQuote(out)}`]
    };
  }
}

export default new CppPolicy();
