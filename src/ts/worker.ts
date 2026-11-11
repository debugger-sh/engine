/**
 * A pool worker. It instantiates the engine on the shared memory sent by the main
 * thread, then executes jobs (`run`: a WASI program).
 */
import init, { worker_init, worker_run } from '../../pkg/engine.js';

self.onmessage = async ({ data }: MessageEvent) => {
  try {
    if (data.type === 'init') {
      await init({ module_or_path: data.module, memory: data.memory });
      worker_init(data.gate);
      postMessage({ type: 'ready' });
    } else if (data.type === 'run') {
      postMessage({ type: 'exit', code: await worker_run(data.job) });
    }
  } catch (err) {
    postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
