/**
 * An exported symbol that allows us to define properties
 * on objects that are only available by library code and not consumers
 * of the library.
 */
export const Internals: unique symbol = Symbol();

/** Yields to the event loop. */
export const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Joins path segments, resolving relative paths against `/`. */
export function join(...parts: string[]): string {
  const out: string[] = [];
  for (const part of parts.join('/').split('/')) {
    if (part === '..') out.pop();
    else if (part && part !== '.') out.push(part);
  }
  return '/' + out.join('/');
}

export function dirname(path: string): string {
  return join(path, '..');
}
