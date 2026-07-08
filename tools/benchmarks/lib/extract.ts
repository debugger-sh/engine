import { spawn } from 'node:child_process';

export async function extractTar(
  archive: string,
  dest: string,
  compression: 'xz' | 'gzip' | 'none' = 'none'
): Promise<void> {
  const args =
    compression === 'xz'
      ? ['-xJf', archive, '-C', dest]
      : compression === 'gzip'
        ? ['-xzf', archive, '-C', dest]
        : ['-xf', archive, '-C', dest];

  await new Promise<void>((resolve, reject) => {
    const child = spawn('tar', args, { stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar exited ${code}`));
    });
  });
}
