import chalk from 'chalk';
import process from 'node:process';

import type { Backend, BackendOptions, Json } from '../run';

export async function createEngineBackend(opts: BackendOptions): Promise<Backend> {
  const { Engine } = await import('debugger-sh');
  const engine = await Engine.create();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await engine.fs.mount(opts.fsNode as unknown as any);
  const toolchain = opts.lang === 'c' ? 'cpp' : opts.lang;
  const proc = engine.run(toolchain, { debug: true });

  const decoder = new TextDecoder();
  const onIo = (chunk: Uint8Array) => {
    process.stdout.write(chalk.gray(decoder.decode(chunk)));
  };
  proc.stdout.on('data', onIo);
  proc.stderr.on('data', onIo);

  const eventCbs: ((e: Json) => void)[] = [];

  proc.debugger.on('event', (msg: unknown) => {
    for (const cb of eventCbs) cb(msg as Json);
  });

  return {
    async send(req) {
      if (
        req &&
        typeof req === 'object' &&
        !Array.isArray(req) &&
        req.type === 'request' &&
        req.command === 'launch'
      ) {
        const request = req as { seq?: number; command?: string };
        return {
          type: 'response',
          seq: 0,
          request_seq: typeof request.seq === 'number' ? request.seq : 0,
          success: true,
          command: request.command ?? 'launch'
        };
      }
      return proc.debugger.send(req) as Json;
    },
    onEvent(cb) {
      eventCbs.push(cb);
    },
    async shutdown() {
      await Promise.race([proc, new Promise((resolve) => setTimeout(resolve, 1500))]).catch(() => {
        /* swallow; reported as test failure if needed */
      });
      engine.dispose();
    }
  };
}
