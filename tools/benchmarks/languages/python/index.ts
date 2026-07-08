import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { CACHE } from '../../lib/cache.ts';
import { downloadFile } from '../../lib/download.ts';
import { PYTHON_BUILD_STANDALONE_TAG, PYTHON_VERSION } from '../../lib/engine-toolchain.ts';
import { extractTar } from '../../lib/extract.ts';
import { hostTriple } from '../../lib/platform.ts';
import { shellQuote } from '../../lib/shell.ts';
import type { BenchmarkPolicy, LocalRun } from '../../policy.ts';

function pythonArchiveName(): string {
  return `cpython-${PYTHON_VERSION}+${PYTHON_BUILD_STANDALONE_TAG}-${hostTriple()}-install_only.tar.gz`;
}

function pythonDownloadUrl(): string {
  return `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_BUILD_STANDALONE_TAG}/${pythonArchiveName()}`;
}

function toolchainRoot(): string {
  return path.join(CACHE, `python-${PYTHON_VERSION}-${hostTriple()}`);
}

function pythonPath(): string {
  return path.join(toolchainRoot(), 'python', 'bin', 'python3');
}

async function ensurePython(): Promise<string> {
  const python = pythonPath();
  if (existsSync(python)) return python;

  const cacheDir = toolchainRoot();
  await mkdir(cacheDir, { recursive: true });

  const archive = path.join(cacheDir, pythonArchiveName());
  if (!existsSync(archive)) {
    console.log(`downloading Python ${PYTHON_VERSION} (${hostTriple()})...`);
    await downloadFile(pythonDownloadUrl(), archive, pythonArchiveName());
  }

  console.log(`extracting ${archive}...`);
  await extractTar(archive, cacheDir, 'gzip');

  if (!existsSync(python)) {
    throw new Error(`could not find python3 under ${cacheDir}`);
  }
  return python;
}

export class PythonPolicy implements BenchmarkPolicy {
  readonly name = 'python';

  private python = '';

  async setupLocal(): Promise<void> {
    this.python = await ensurePython();
  }

  async runLocal(sourcePath: string): Promise<LocalRun> {
    const abs = path.resolve(sourcePath);
    const env = [
      `PYTHONUNBUFFERED=1`,
      `PYTHONDONTWRITEBYTECODE=1`,
      `exec ${shellQuote(this.python)} ${shellQuote(abs)}`
    ].join(' ');

    return {
      type: 'command',
      cmd: '/bin/sh',
      args: ['-c', env]
    };
  }
}

export default new PythonPolicy();
