import { type ChildProcess, spawn } from 'node:child_process';

import type { LocalRun } from '../policy.ts';
import type { TimingPoint } from './report.ts';

export async function timeLocalRun(run: LocalRun): Promise<TimingPoint> {
  const t0 = performance.now();
  let firstStdout: number | null = null;

  const child: ChildProcess =
    run.type === 'command'
      ? spawn(run.cmd, run.args, { stdio: ['ignore', 'pipe', 'pipe'] })
      : run.child;

  child.stdout?.on('data', () => {
    if (firstStdout === null) firstStdout = performance.now() - t0;
  });

  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      const totalMs = performance.now() - t0;
      if (code !== 0) {
        reject(new Error(`local run exited with code ${code}`));
        return;
      }
      resolve({ firstStdoutMs: firstStdout ?? totalMs, totalMs });
    });
  });
}
