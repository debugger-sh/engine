import { $ } from 'bun';
import { existsSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';

/** The current platform, like `darwin-arm64`, `linux-x64` or `win32-x64`. */
export const PLATFORM = `${process.platform}-${process.arch}`;

/**
 * Extracts each archive into `dir` (unless it already exists), without its top `strip` directories,
 * and only the `members` matching the given patterns (if any).
 */
export async function download(dir: string, urls: string[], strip = 1, members: string[] = []) {
  // GNU tar (unlike bsdtar on macOS and Windows) needs to be told that members are patterns.
  const wildcards = process.platform === 'linux' ? ['--wildcards'] : [];
  if (existsSync(dir)) return;
  await rm(`${dir}.part`, { recursive: true, force: true });
  await mkdir(`${dir}.part`, { recursive: true });
  for (const url of urls)
    await $`curl -fL ${url} | tar ${url.endsWith('.xz') ? '-xJ' : '-xz'} -C ${`${dir}.part`} --strip-components=${strip} ${wildcards} ${members}`;
  await rename(`${dir}.part`, dir);
}
