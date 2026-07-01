import type { LocalProgramReport } from '../lib/report.ts';
import { timeLocalRun } from '../lib/timing.ts';
import type { BenchmarkPolicy } from '../policy.ts';

export async function runLocalPipeline(
  policy: BenchmarkPolicy,
  sourcePath: string,
  iterations: number
): Promise<LocalProgramReport> {
  const dataPoints: LocalProgramReport['dataPoints'] = [];

  for (let iteration = 1; iteration <= iterations; iteration++) {
    const run = await policy.runLocal(sourcePath);
    const timing = await timeLocalRun(run);
    dataPoints.push({ iteration, ...timing });
  }

  const firstStdoutMs = dataPoints.reduce((sum, p) => sum + p.firstStdoutMs, 0) / dataPoints.length;
  const totalMs = dataPoints.reduce((sum, p) => sum + p.totalMs, 0) / dataPoints.length;

  return { dataPoints, averages: { firstStdoutMs, totalMs } };
}
