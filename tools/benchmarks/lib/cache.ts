import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const BENCH_ROOT = path.resolve(HERE, '..');
export const CACHE = path.join(BENCH_ROOT, '.cache');
