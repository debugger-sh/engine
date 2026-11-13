import { Engine, type FileTree, type Process, type ProcessResult } from 'debugger-sh';
import { expect, onTestFinished } from 'vitest';

type Output = ProcessResult & { stdout: string; stderr: string };

declare module 'vitest' {
  interface Matchers<R, T> {
    /** Awaits a process, matching (a subset of) its result and output. */
    outputs: T extends Process ? (expected: Partial<Output>) => Promise<R> : never;
  }
}

/** Creates an engine with the given files, disposed when the test finishes. */
export async function eng(files: FileTree = {}): Promise<Engine> {
  const engine = await Engine.create();
  onTestFinished(() => engine.dispose());
  await engine.fs.mount(files);
  return engine;
}

expect.extend({
  async outputs(proc, expected: Partial<Output>) {
    if (typeof proc?.stdout?.on !== 'function') {
      throw new TypeError(`outputs expects a Process, received ${this.utils.printReceived(proc)}`);
    }
    const decoder = new TextDecoder();
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk: Uint8Array) => (stdout += decoder.decode(chunk)));
    proc.stderr.on('data', (chunk: Uint8Array) => (stderr += decoder.decode(chunk)));
    const actual: Output = { ...(await proc), stdout, stderr };
    const { iterableEquality, subsetEquality } = this.utils;
    return {
      pass: this.equals(actual, expected, [iterableEquality, subsetEquality]),
      message: () => `expected process ${this.isNot ? 'not ' : ''}to output`,
      actual,
      expected
    };
  }
});

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const HELLO = '#include <cstdio>\nint main() { printf("hello\\n"); }';

/** A multi-purpose test program, selected by its first argument. */
const TOOL = `
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <sys/stat.h>

int main(int argc, char** argv) {
  const char* mode = argc > 1 ? argv[1] : "";
  if (!strcmp(mode, "exit")) return atoi(argv[2]);
  if (!strcmp(mode, "args")) for (int i = 2; i < argc; i++) printf("%s\\n", argv[i]);
  if (!strcmp(mode, "env")) printf("%s\\n", getenv(argv[2]));
  if (!strcmp(mode, "stderr")) fprintf(stderr, "oops\\n");
  if (!strcmp(mode, "cat")) for (int c; (c = getchar()) != EOF;) putchar(c);
  if (!strcmp(mode, "trap")) __builtin_trap();
  if (!strcmp(mode, "loop")) for (volatile int i = 0;; i = i + 1) {}
  if (!strcmp(mode, "write")) { FILE* f = fopen(argv[2], "w"); fputs(argv[3], f); fclose(f); }
  if (!strcmp(mode, "spam")) for (;;) { FILE* f = fopen(argv[2], "w"); fputs("spam", f); fclose(f); printf("."); }
  if (!strcmp(mode, "read")) { char b[256] = {0}; FILE* f = fopen(argv[2], "r"); fread(b, 1, 255, f); printf("%s", b); }
  if (!strcmp(mode, "size")) { struct stat s; printf("%d\\n", stat(argv[2], &s) ? -1 : (int)s.st_size); }
  return 0;
}
`;

/** Creates an engine with a multi-purpose test program (see {@link TOOL}) at `/bin/main`. */
export async function withTool(): Promise<Engine> {
  const tool = await eng({ src: { files: { 'tool.cpp': TOOL } } });
  await expect(tool.run('cpp', { sources: ['src/*.cpp'], buildDir: '/bin' })).outputs({
    exitCode: 0
  });
  return tool;
}
