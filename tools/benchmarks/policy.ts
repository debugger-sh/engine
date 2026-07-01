import type { ChildProcess } from 'node:child_process';

/** A subprocess for the benchmark harness to spawn and time. */
export type LocalCommand = { type: 'command'; cmd: string; args: string[] };

/** An already-spawned subprocess for the benchmark harness to attach to and time. */
export type LocalProcess = { type: 'process'; child: ChildProcess };

export type LocalRun = LocalCommand | LocalProcess;

export interface BenchmarkPolicy {
  /** CLI name, e.g. `cpp`. */
  readonly name: string;
  /** Download toolchains and other one-time local setup. */
  setupLocal(): Promise<void>;
  /** Prepare a local compile-and-run for the benchmark harness to execute and time. */
  runLocal(sourcePath: string): Promise<LocalRun>;
}
