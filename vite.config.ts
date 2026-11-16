import fs from 'fs';
import path from 'path';
import { defineConfig, PluginOption } from 'vite';
import dts from 'vite-plugin-dts';

const outDir = 'dist';

export default defineConfig({
  // Resolve the worker chunk relative to the library, wherever it is served from
  base: './',
  plugins: [wasm(), dts()],
  worker: {
    format: 'es',
    plugins: () => [wasm()]
  },
  build: {
    outDir,
    lib: {
      entry: 'src/ts/index.ts',
      name: 'engine',
      fileName: 'debugger-sh',
      // Workers are separate chunks, which UMD cannot express
      formats: ['es']
    }
  }
});

function wasm(): PluginOption {
  return {
    name: 'fix-wasm-import',
    resolveFileUrl({ fileName }) {
      if (fileName.endsWith('.wasm')) return JSON.stringify(`./${fileName}`);
    },
    async closeBundle() {
      const provenance = Object.fromEntries(
        [
          ['cpp', 'llvm'],
          ['python', 'python'],
          ['rust', 'rust']
        ].map(([language, toolchain]) => [
          language,
          JSON.parse(fs.readFileSync(`tools/toolchains/${toolchain}/provenance.json`, 'utf8'))
        ])
      );
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(
        path.join(outDir, 'toolchain-provenance.json'),
        JSON.stringify(provenance, null, 2) + '\n'
      );
      const pkgDir = 'pkg';
      if (fs.existsSync(pkgDir)) {
        const wasmFiles = fs.readdirSync(pkgDir).filter((file) => file.endsWith('.wasm'));
        fs.mkdirSync(outDir, { recursive: true });
        for (const wasmFile of wasmFiles) {
          fs.copyFileSync(path.join(pkgDir, wasmFile), path.join(outDir, wasmFile));
        }
      }

      // Workers receive the compiled engine from the main thread, so drop the
      // copies of the binary that `wasm-bindgen`'s default URL inlines
      for (const file of fs.readdirSync(outDir, { recursive: true, encoding: 'utf-8' })) {
        if (!file.endsWith('.js')) continue;
        const js = fs.readFileSync(path.join(outDir, file), { encoding: 'utf-8' });
        const stripped = js.replaceAll(/(["'`])data:application\/wasm[^"'`]*\1/g, '""');
        fs.writeFileSync(path.join(outDir, file), stripped, { encoding: 'utf-8' });
      }
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

      // Resolve the binary shipped in this package, including unpublished tarballs.
      // A fixed registry URL can silently load an older, incompatible engine.
      if (isRelease) {
        const reference = this.emitFile({
          type: 'asset',
          fileName: wasmFile,
          source: fs.readFileSync(id)
        });
        return `export default new URL(import.meta.ROLLUP_FILE_URL_${reference}, import.meta.url);`;
      }

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
