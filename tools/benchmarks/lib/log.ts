let enabled = process.env.BENCH_DEBUG === '1';

export function setDebug(on: boolean): void {
  enabled = on;
}

export function isDebug(): boolean {
  return enabled;
}

function stamp(): string {
  return `[${(performance.now() / 1000).toFixed(2)}s]`;
}

export function debug(scope: string, message: string, detail?: unknown): void {
  if (!enabled) return;
  const extra =
    detail === undefined ? '' : ` ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
  console.log(`${stamp()} [${scope}] ${message}${extra}`);
}

export async function withTimeout<T>(label: string, ms: number, fn: () => Promise<T>): Promise<T> {
  debug('timeout', `start ${label} (${ms}ms)`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${label}`)), ms);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    debug('timeout', `done ${label}`);
  }
}
