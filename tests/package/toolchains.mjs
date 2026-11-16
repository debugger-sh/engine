import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

for (const toolchain of ['llvm', 'python', 'rust']) {
  const manifest = JSON.parse(
    await readFile(new URL(`../../tools/toolchains/${toolchain}/provenance.json`, import.meta.url))
  );
  for (const [name, url] of Object.entries(manifest.artifacts)) {
    const response = await fetch(url);
    assert(response.ok, `${url}: ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    assert.equal(sha256, manifest.sha256[name], url);
    if (name !== 'sysroot') assert.deepEqual([...bytes.slice(0, 4)], [0, 97, 115, 109]);
    console.log(JSON.stringify({ toolchain, name, url, sha256, size: bytes.length }));
  }
}
