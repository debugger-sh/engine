import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import cpp from './languages/cpp/index.ts';
import python from './languages/python/index.ts';
import rust from './languages/rust/index.ts';
import { setDebug } from './lib/log.ts';
import { type BenchmarkReport, writeReport } from './lib/report.ts';
import { runLocalPipeline } from './pipelines/local.ts';
import type { BenchmarkPolicy } from './policy.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const OUTPUT_DIR = path.join(HERE, 'output');

const LANGUAGES: Record<string, BenchmarkPolicy> = {
  cpp,
  python,
  rust
};

type CliOpts = {
  policyName: string;
  programs: string[];
  iterations: number;
  output: string;
  debug: boolean;
};

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

function parseCli(argv: string[]): CliOpts {
  if (argv.length === 0) {
    die(
      'usage: npm run tools:bench -- <policy> <program> [...] [--iters N] [--output path] [--debug]'
    );
  }

  const policyName = argv[0]!;
  const programs: string[] = [];
  let iterations = 5;
  let output = path.join(OUTPUT_DIR, `${policyName}-${Date.now()}.json`);
  let debug = process.env.BENCH_DEBUG === '1';

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--debug') {
      debug = true;
      continue;
    }
    if (arg === '--iters') {
      iterations = Number(argv[++i]);
      if (!Number.isFinite(iterations) || iterations < 1) die('--iters must be a positive number');
      continue;
    }
    if (arg === '--output') {
      const out = argv[++i]!;
      output = path.isAbsolute(out) ? out : path.resolve(ROOT, out);
      continue;
    }
    programs.push(path.isAbsolute(arg) ? arg : path.resolve(ROOT, arg));
  }

  if (programs.length === 0) die('at least one program path is required');

  return { policyName, programs, iterations, output, debug };
}

async function main() {
  const opts = parseCli(process.argv.slice(2));
  setDebug(opts.debug);
  const policy = LANGUAGES[opts.policyName];
  if (!policy)
    die(`unknown language: ${opts.policyName} (available: ${Object.keys(LANGUAGES).join(', ')})`);

  for (const program of opts.programs) {
    if (!existsSync(program)) die(`no such file: ${program}`);
  }

  await mkdir(OUTPUT_DIR, { recursive: true });
  await mkdir(path.dirname(opts.output), { recursive: true });

  console.log(
    `policy=${policy.name} iterations=${opts.iterations} programs=${opts.programs.length}`
  );
  await policy.setupLocal();

  const report: BenchmarkReport = {
    meta: {
      timestamp: new Date().toISOString(),
      policy: policy.name,
      iterations: opts.iterations,
      programs: opts.programs
    },
    programs: []
  };

  for (const program of opts.programs) {
    console.log(`\n== ${program} ==`);
    const local = await runLocalPipeline(policy, program, opts.iterations);
    report.programs.push({ path: program, ...local });
  }

  await writeReport(report, opts.output);
}

await main();
