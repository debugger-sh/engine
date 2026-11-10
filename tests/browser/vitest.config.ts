import { playwright } from '@vitest/browser-playwright';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Shared memory requires cross-origin isolation.
const headers = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp'
};
const proxy = process.env.HTTPS_PROXY
  ? { server: process.env.HTTPS_PROXY, bypass: 'localhost' }
  : undefined;

export default defineConfig({
  root: import.meta.dirname,
  // Test the built library (`npm run build`), exactly as published.
  resolve: {
    alias: { 'debugger-sh': path.resolve(import.meta.dirname, '../../dist/debugger-sh.js') }
  },
  optimizeDeps: { exclude: ['debugger-sh'] },
  server: { headers, fs: { allow: ['../..'] } },
  test: {
    include: ['**/*.test.ts'],
    testTimeout: 120_000,
    fileParallelism: false,
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({ launchOptions: { proxy } }),
      instances: [{ browser: 'chromium' }]
    }
  }
});
