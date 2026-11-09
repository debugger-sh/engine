import { try_lock, unlock } from '../../pkg/engine';

/**
 * An exported symbol that allows us to define properties
 * on objects that are only available by library code and not consumers
 * of the library.
 */
export const Internals: unique symbol = Symbol();

/** Yields to the event loop. */
export const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Runs `fn` while holding the shared filesystem lock.
 *
 * The main thread must never block on the lock (workers may hold it), so instead
 * of waiting we spin asynchronously, yielding to the event loop between attempts.
 */
export async function locked<T>(fn: () => T): Promise<T> {
  while (!try_lock()) await tick();
  try {
    return fn();
  } finally {
    unlock();
  }
}

/** Joins path segments, resolving relative paths against `/`. */
export function join(...parts: string[]): string {
  const out: string[] = [];
  for (const part of parts.join('/').split('/')) {
    if (part === '..') out.pop();
    else if (part && part !== '.') out.push(part);
  }
  return '/' + out.join('/');
}

/** Resolves `path` against the directory `cwd`. */
export function resolve(cwd: string, path: string): string {
  return path.startsWith('/') ? join(path) : join(cwd, path);
}

export function dirname(path: string): string {
  return join(path, '..');
}
