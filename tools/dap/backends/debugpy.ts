import { $ } from 'bun';
import chalk from 'chalk';
import { existsSync } from 'node:fs';
import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import type { Backend, BackendOptions, Json } from '../run';

export async function createDebugpyBackend(opts: BackendOptions): Promise<Backend> {
  const python = await detectPython();
  const { scriptAbs, scriptBasename } = await prepareScript(opts.testDir);

  const proc = Bun.spawn({
    cmd: [python, '-m', 'debugpy.adapter'],
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe'
  });

  const eventListeners: ((e: Json) => void)[] = [];
  const pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();

  const dispatch = (msg: Json) => {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
    const m = msg as { type?: string; request_seq?: number; event?: string; body?: Json };
    if (m.type === 'response' && typeof m.request_seq === 'number') {
      const p = pending.get(m.request_seq);
      if (p) {
        pending.delete(m.request_seq);
        p.resolve(msg);
      }
      return;
    }
    if (m.type === 'event') {
      handleOutputEvent(m);
      for (const cb of eventListeners) cb(msg);
    }
  };

  void readLoop(proc.stdout, dispatch).catch((err) => {
    const error = err instanceof Error ? err : new Error(String(err));
    for (const [, p] of pending) p.reject(error);
    pending.clear();
  });

  void drainStderr(proc.stderr);

  function send(req: Json): Promise<Json> {
    if (!req || typeof req !== 'object' || Array.isArray(req)) {
      return Promise.reject(new Error('debugpy backend send: not an object'));
    }
    const msg = rewriteSourcePath(
      req as { seq?: number; type?: string; command?: string; arguments?: Json },
      scriptBasename,
      scriptAbs
    );
    if (msg.type === 'request' && msg.command === 'launch') {
      msg.arguments = {
        program: scriptAbs,
        cwd: path.dirname(scriptAbs),
        console: 'internalConsole',
        justMyCode: false
      };
      // debugpy does not send a launch response; initialized follows asynchronously.
      writeFrame(proc.stdin, msg);
      return Promise.resolve({
        type: 'response',
        seq: 0,
        request_seq: msg.seq,
        success: true,
        command: 'launch'
      } as Json);
    }
    const seq = msg.seq;
    if (typeof seq !== 'number') {
      return Promise.reject(new Error('debugpy backend send: missing seq'));
    }
    return new Promise<Json>((resolve, reject) => {
      pending.set(seq, { resolve, reject });
      try {
        writeFrame(proc.stdin, msg);
      } catch (err) {
        pending.delete(seq);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  return {
    send,
    onEvent(cb) {
      eventListeners.push(cb);
    },
    async shutdown() {
      try {
        await Promise.race([
          send({
            type: 'request',
            seq: 0xffff_ffff,
            command: 'disconnect',
            arguments: { terminateDebuggee: true }
          } as Json),
          new Promise((resolve) => setTimeout(resolve, 250))
        ]);
      } catch {
        /* best effort */
      }
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    }
  };
}

async function detectPython(): Promise<string> {
  const candidates = [
    process.env.PYTHON,
    '/usr/local/bin/python3',
    '/usr/bin/python3',
    'python3',
    'python'
  ].filter((v): v is string => typeof v === 'string' && v.length > 0);

  for (const python of [...new Set(candidates)]) {
    if (python.includes('/')) {
      if (!existsSync(python)) continue;
    } else {
      const which = await $`sh -lc ${`command -v ${python}`}`.quiet().nothrow();
      if (which.exitCode !== 0) continue;
    }
    const mod = await $`${python} -m debugpy.adapter --help`.quiet().nothrow();
    if (mod.exitCode === 0) return python;
  }
  throw new Error(
    'debugpy not found. install with `python3 -m pip install debugpy` and ensure python3 is on PATH.'
  );
}

async function prepareScript(
  testDir: string
): Promise<{ scriptAbs: string; scriptBasename: string }> {
  const scriptDir = await mkdtemp(path.join(tmpdir(), 'engine-dap-python-'));
  await cp(testDir, scriptDir, { recursive: true });

  for (const name of ['main.py', 'app.py']) {
    const candidate = path.join(scriptDir, name);
    if (existsSync(candidate)) return { scriptAbs: candidate, scriptBasename: name };
  }

  throw new Error(`no Python entrypoint found in ${testDir} (looked for main.py, app.py)`);
}

function rewriteSourcePath<T extends { arguments?: Json }>(
  req: T,
  basename: string,
  absolutePath: string
): T {
  const walk = (v: Json): Json => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, Json> = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val as Json);
      if (
        typeof out.path === 'string' &&
        (out.path === basename || out.path.endsWith(`/${basename}`))
      ) {
        out.path = absolutePath;
      }
      return out;
    }
    return v;
  };
  if (!req.arguments) return req;
  return { ...req, arguments: walk(req.arguments) };
}

function writeFrame(stdin: { write(data: string): unknown; flush(): unknown }, msg: Json) {
  const body = JSON.stringify(msg);
  const header = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n`;
  stdin.write(header);
  stdin.write(body);
  stdin.flush();
}

async function readLoop(stdout: ReadableStream<Uint8Array>, dispatch: (msg: Json) => void) {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = new Uint8Array(0);

  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    if (value && value.length > 0) {
      const copy = new Uint8Array(value.byteLength);
      copy.set(value);
      buffer = concatU8(buffer, copy);
    }

    while (true) {
      const headerEnd = findCrlfCrlf(buffer);
      if (headerEnd < 0) break;
      const headerStr = decoder.decode(buffer.slice(0, headerEnd));
      const m = headerStr.match(/Content-Length:\s*(\d+)/i);
      if (!m) throw new Error(`bad DAP header: ${JSON.stringify(headerStr)}`);
      const length = parseInt(m[1], 10);
      const start = headerEnd + 4;
      if (buffer.length < start + length) break;
      const body = decoder.decode(buffer.slice(start, start + length));
      buffer = buffer.slice(start + length);
      dispatch(JSON.parse(body) as Json);
    }
  }
}

async function drainStderr(stderr: ReadableStream<Uint8Array>) {
  const reader = stderr.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    if (value && value.length > 0) {
      process.stderr.write(chalk.dim(decoder.decode(value)));
    }
  }
}

function handleOutputEvent(msg: { event?: string; body?: Json }) {
  if (msg.event !== 'output') return;
  const body = msg.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return;
  const out = (body as Record<string, Json>).output;
  if (typeof out !== 'string') return;
  process.stdout.write(chalk.gray(out));
}

function concatU8(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function findCrlfCrlf(buf: Uint8Array): number {
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a && buf[i + 2] === 0x0d && buf[i + 3] === 0x0a) {
      return i;
    }
  }
  return -1;
}
