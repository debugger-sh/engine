import { Engine, type Process } from 'debugger-sh';

const decoder = new TextDecoder();

/** Awaits a process, collecting its output. */
export async function output(proc: Process) {
  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (chunk) => (stdout += decoder.decode(chunk)));
  proc.stderr.on('data', (chunk) => (stderr += decoder.decode(chunk)));
  const result = await proc;
  return { ...result, stdout, stderr };
}

/** A multi-purpose test program, selected by its first argument. */
export const TOOL = `
#include <cstdio>
#include <cstdlib>
#include <cstring>

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
  return 0;
}
`;

/** Creates an engine with {@link TOOL} compiled to `/bin/main`. */
export async function withTool(): Promise<Engine> {
  const engine = await Engine.create();
  await engine.fs.mount({ 'tool.cpp': TOOL }, { at: '/src' });
  const { exitCode, stderr } = await output(engine.run('cpp', { cwd: '/src', buildDir: '/bin' }));
  if (exitCode !== 0) throw new Error(stderr);
  return engine;
}
