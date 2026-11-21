import fs from 'fs';
import path from 'path';
import { defineConfig, PluginOption } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
  plugins: [wasm(), dts()],
  worker: {
    format: 'es',
    plugins: () => [wasm()]
  },
  build: {
    lib: {
      entry: 'src/ts/index.ts',
      fileName: 'debugger-sh',
      formats: ['es']
    }
  }
});

function wasm(): PluginOption {
  const { name, version } = JSON.parse(fs.readFileSync('package.json', 'utf-8')) as {
    name: string;
    version: string;
  };
  const cdn = `https://cdn.jsdelivr.net/npm/${name}@${version}/dist`;

  return {
    name: 'fix-wasm-import',

    closeBundle() {
      const binary = 'pkg/engine_bg.wasm';
      if (!fs.existsSync(binary)) return;
      fs.mkdirSync('dist', { recursive: true });
      fs.copyFileSync(binary, path.join('dist', path.basename(binary)));
    },

    /**
     * The engine is always initialized with the module compiled on the main thread, so drop
     * the copies of the binary that `wasm-bindgen`'s default URL inlines. This runs per chunk
     * (rather than on the written files) so that it also applies to the worker before it is inlined.
     */
    renderChunk(code) {
      return code.replaceAll(/(["'`])data:application\/wasm[^"'`]*\1/g, '""');
    },

    /**
     * Set up `.wasm` import so that importing it returns a buffer.
     * This is taken from wasmer-js: https://github.com/wasmerio/wasmer-js/blob/main/rollup.config.mjs
     */
    async load(id) {
      if (!id.endsWith('.wasm')) return;
      const devPort = process.env.WASM_DEV_PORT;
      const isRelease = Boolean(process.env.WASM_RELEASE);
      const wasmFile = path.basename(id);

      // In dev mode, we serve compiled Rust .wasm files from a local dev server
      if (devPort) return `export default new URL("http://localhost:${devPort}/${wasmFile}");`;

      // In release mode, we serve .wasm files from the npm registry via CDN
      if (isRelease) return `export default new URL(${JSON.stringify(`${cdn}/${wasmFile}`)});`;

      // Otherwise, in normal local build, we b64 encode the .wasm files into a buffer
      // and bake into the bundled output, resulting in a very large bundle size
      const binary = fs.readFileSync(id);
      const base64 = binary.toString('base64');
      return `
          const src = ${JSON.stringify(base64)};
          const buf = Uint8Array.from(atob(src), c => c.charCodeAt(0));
          export default buf;
        `;
    }
  };
}
