// Runs in the benchmark page. Wraps both engines behind one interface:
// `start(kind, lang, file, source)` cold-starts an engine (library import included) and runs
// `source`; `rerun(source)` writes `source` to the same engine and runs it again.
const decoder = new TextDecoder();
let session;

const adapters = {
  // The old engine (main): one engine per language, a serialized `fs`, one worker per run
  async old(lang, file) {
    const { Engine } = await import('/old/debugger-sh.js');
    const engine = await Engine.create(lang === 'cpp' ? 'c' : lang);
    engine.debugger.enabled = false;
    let stdout = '';
    engine.stdout.on('data', (chunk) => (stdout += decoder.decode(chunk)));
    engine.stderr.on('data', (chunk) => (stdout += decoder.decode(chunk)));
    return async (source) => {
      stdout = '';
      engine.fs = { [file]: source };
      const result = await engine.run();
      if (result.type !== 'completed') throw new Error(JSON.stringify(result));
      return { exitCode: result.exitCode, stdout };
    };
  },
  // The rewritten engine: a shared filesystem, toolchains as processes
  async new(lang, file) {
    const { Engine } = await import('/new/debugger-sh.js');
    const engine = await Engine.create();
    return async (source) => {
      await engine.fs.writeFile(file, source);
      const proc = engine.run(lang);
      let stdout = '';
      proc.stdout.on('data', (chunk) => (stdout += decoder.decode(chunk)));
      proc.stderr.on('data', (chunk) => (stdout += decoder.decode(chunk)));
      const { exitCode } = await proc;
      return { exitCode, stdout };
    };
  }
};

async function timed(fn) {
  const start = performance.now();
  const result = await fn();
  return { ...result, ms: performance.now() - start };
}

window.bench = {
  start: (kind, lang, file, source) =>
    timed(async () => {
      session = await adapters[kind](lang, file);
      return session(source);
    }),
  rerun: (source) => timed(() => session(source))
};
window.ready = true;
