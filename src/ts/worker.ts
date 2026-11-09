/**
 * A pool worker. It instantiates the engine on the shared memory sent by the main
 * thread, then executes jobs (`run`: a WASI program; `sysroot`: load a sysroot).
 */
import init, { worker_init, worker_run, worker_sysroot } from '../../pkg/engine.js';

type Exports = { __tls_base: WebAssembly.Global; __stack_alloc?: WebAssembly.Global };

self.onmessage = async ({ data }: MessageEvent) => {
  try {
    if (data.type === 'init') {
      const exports = (await init({
        module_or_path: data.module,
        memory: data.memory
      })) as unknown as Exports;
      worker_init(data.gate);
      postMessage({
        type: 'ready',
        tls: exports.__tls_base.value,
        stack: exports.__stack_alloc?.value
      });
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
