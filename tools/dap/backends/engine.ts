import chalk from 'chalk';
import process from 'node:process';

import type { Backend, BackendOptions } from '../run';

export async function createEngineBackend(opts: BackendOptions): Promise<Backend> {
  const { Engine } = await import('debugger-sh');
  const engine = await Engine.create();
  await engine.fs.mount(opts.fsNode);
  const toolchain = opts.lang === 'c' ? 'cpp' : opts.lang;
  const proc = engine.run(toolchain, { debug: true });

  const decoder = new TextDecoder();
  const onIo = (chunk: Uint8Array) => {
    process.stdout.write(chalk.gray(decoder.decode(chunk)));
  };
  proc.stdout.on('data', onIo);
  proc.stderr.on('data', onIo);

  return {
    async send(request) {
      // The engine runs the program itself, so there is nothing to launch.
      if (request.command === 'launch')
        return {
          type: 'response',
          seq: 0,
          request_seq: request.seq,
          success: true,
          command: 'launch'
        };
      return proc.debugger.dap.send(request);
    },
    onEvent(listener) {
      proc.debugger.dap.on('event', listener);
    },
    async shutdown() {
      await Promise.race([proc, new Promise((resolve) => setTimeout(resolve, 1500))]).catch(() => {
        /* swallow; reported as test failure if needed */
      });
      engine.dispose();
    }
  };
}
