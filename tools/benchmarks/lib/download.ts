import cliProgress from 'cli-progress';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

export async function downloadFile(url: string, dest: string, label?: string): Promise<void> {
  await mkdir(path.dirname(dest), { recursive: true });

  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed (${url}): ${res.status} ${res.statusText}`);
  if (!res.body) throw new Error(`download failed (${url}): empty response body`);

  const total = Number(res.headers.get('content-length') ?? 0);
  const name = label ?? path.basename(dest);
  const bar = new cliProgress.SingleBar(
    {
      format: `{bar} {percentage}% | {value}/{total} | ${name}`,
      hideCursor: true,
      clearOnComplete: true,
      stopOnComplete: true
    },
    cliProgress.Presets.shades_classic
  );

  let downloaded = 0;
  if (total > 0) {
    bar.start(total, 0, { total: formatBytes(total) });
  } else {
    bar.start(1, 0, { total: '?' });
  }

  const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  body.on('data', (chunk: Buffer | string) => {
    downloaded += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
    if (total > 0) {
      bar.update(Math.min(downloaded, total), { value: formatBytes(downloaded) });
    } else {
      bar.update(0, { value: formatBytes(downloaded), total: formatBytes(downloaded) });
    }
  });

  await pipeline(body, createWriteStream(dest));
  bar.stop();
}
