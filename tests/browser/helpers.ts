import { type Debugger, Engine, type FileTree, type Process } from 'debugger-sh';
import { onTestFinished } from 'vitest';

/** Creates an engine with the given files, disposed when the test finishes. */
export async function createEngine(files: FileTree = {}): Promise<Engine> {
  const engine = await Engine.create();
  onTestFinished(() => engine.dispose());
  await engine.fs.mount(files);
  return engine;
}

/** Awaits a process, collecting its output. */
export async function output(proc: Process) {
  const decoder = new TextDecoder();
  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (chunk) => (stdout += decoder.decode(chunk)));
  proc.stderr.on('data', (chunk) => (stderr += decoder.decode(chunk)));
  return { ...(await proc), stdout, stderr };
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const HELLO = '#include <cstdio>\nint main() { printf("hello\\n"); }';

/** A multi-purpose test program, selected by its first argument. */
const TOOL = `
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

/** Creates an engine with a multi-purpose test program (see {@link TOOL}) at `/bin/main`. */
export async function withTool(): Promise<Engine> {
  const tool = await createEngine({ src: { files: { 'tool.cpp': TOOL } } });
  const { exitCode, stderr } = await output(tool.run('cpp', { cwd: '/src', buildDir: '/bin' }));
  if (exitCode !== 0) throw new Error(stderr);
  return tool;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Message = { event?: string; body?: any };

/** A minimal DAP client. */
export function dap(dbg: Debugger) {
  const events: Message[] = [];
  const waiters: (() => void)[] = [];
  dbg.on('event', (e) => {
    events.push(e as Message);
    waiters.splice(0).forEach((wake) => wake());
  });
  let seq = 1;
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    request: (command: string, args: object = {}): { success: boolean; body: any } =>
      dbg.send({ type: 'request', seq: seq++, command, arguments: args }) as never,
    async event(name: string): Promise<Message> {
      for (;;) {
        const index = events.findIndex((e) => e.event === name);
        if (index >= 0) return events.splice(index, 1)[0];
        await new Promise<void>((wake) => waiters.push(wake));
      }
    },
    /** Completes the DAP handshake, setting breakpoints on `path` first. */
    async start(path?: string, lines: number[] = []) {
      this.request('initialize');
      await this.event('initialized');
      if (path)
        this.request('setBreakpoints', {
          source: { path },
          breakpoints: lines.map((line) => ({ line }))
        });
      this.request('configurationDone');
    }
  };
}
