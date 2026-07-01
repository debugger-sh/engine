import { writeFile } from 'node:fs/promises';
import path from 'node:path';

export type TimingPoint = {
  firstStdoutMs: number;
  totalMs: number;
};

export type LocalProgramReport = {
  dataPoints: (TimingPoint & { iteration: number })[];
  averages: TimingPoint;
};

export type ProgramReport = LocalProgramReport & { path: string };

export type BenchmarkReport = {
  meta: {
    timestamp: string;
    policy: string;
    iterations: number;
    programs: string[];
  };
  programs: ProgramReport[];
};

export async function writeReport(report: BenchmarkReport, outputPath: string): Promise<void> {
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`report written to ${path.resolve(outputPath)}`);
}
