/**
 * A pool worker. It instantiates the engine on the shared memory sent by the main
 * thread, then executes jobs (`run`: a WASI program; `sysroot`: load a sysroot).
 */
import init, { worker_init, worker_run, worker_sysroot } from '../../pkg/engine.js';

self.onmessage = async ({ data }: MessageEvent) => {
  try {
    if (data.type === 'init') {
      await init({ module_or_path: data.module, memory: data.memory });
      worker_init(data.gate);
      postMessage({ type: 'ready' });
    } else if (data.type === 'run') {
      postMessage({ type: 'exit', code: await worker_run(data.job) });
    } else if (data.type === 'sysroot') {
      // Fetched in-process, so that the archive is only ever copied into shared memory.
      const response = await fetch(data.url, { cache: 'force-cache' }).catch(() => undefined);
      if (!response?.ok) postMessage({ type: 'sysroot', status: response?.status ?? 0 });
      else
        postMessage({
          type: 'sysroot',
          ptr: worker_sysroot(new Uint8Array(await response.arrayBuffer()))
        });
    }
  } catch (err) {
    postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
