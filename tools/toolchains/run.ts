// Builds and releases the toolchains in this folder, e.g. `npm run tools:toolchain llvm build`.
// See README.md.
import { $ } from 'bun';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

interface Provenance {
  upstream: { repository: string; revision: string };
  fork: { repository: string; release?: string };
  artifacts: Record<string, string>;
}

const ROOT = path.resolve(import.meta.dir, '../..');
const [name, command] = process.argv.slice(2);
const DIR = path.join(import.meta.dir, name ?? '');
const PROVENANCE = path.join(DIR, 'provenance.json');
const OUTPUT = path.join(DIR, 'output');

const commands: Record<string, () => Promise<number>> = { build, release };
if (!name || !Object.hasOwn(commands, command) || !(await Bun.file(PROVENANCE).exists())) {
  console.error('usage: npm run tools:toolchain <name> <build | release>, e.g. llvm build');
  process.exit(1);
}
// Ctrl-C reaches running commands directly, so stay alive to clean up after them.
process.on('SIGINT', () => {});

const provenance: Provenance = await Bun.file(PROVENANCE).json();
const writeProvenance = (provenance: Provenance) =>
  Bun.write(PROVENANCE, JSON.stringify(provenance, null, 2) + '\n');

process.exit(await commands[command]());

function fail(message: string): never {
  console.error(`${name}: ${message}`);
  process.exit(1);
}

/** Runs a command in the repository root, resolving to its exit code. */
async function run(...command: string[]): Promise<number> {
  return (await $`${command}`.cwd(ROOT).nothrow()).exitCode;
}

/** The output of each artifact, which is named after it (e.g. `sysroot.tar.gz`). */
async function outputs(): Promise<Record<string, string>> {
  const files = await readdir(OUTPUT);
  return Object.fromEntries(
    Object.keys(provenance.artifacts).map((artifact) => [
      artifact,
      files.find((file) => file.split('.')[0] === artifact) ?? fail(`no output for ${artifact}`)
    ])
  );
}

/** The artifacts, at the URLs of their outputs under `base`. */
async function artifactsAt(base: string): Promise<Record<string, string>> {
  const files = Object.entries(await outputs());
  return Object.fromEntries(files.map(([artifact, file]) => [artifact, new URL(file, base).href]));
}

/**
 * Builds the toolchain into `output` (in Docker, with sources and build trees cached in a
 * volume), then tests the library with it: the artifacts temporarily point at a local server.
 */
async function build(): Promise<number> {
  // Every toolchain's image builds on the shared one in this folder (see Dockerfile).
  const image = `debugger-sh-toolchain-${name}`;
  const docker = (...args: string[]) => run('docker', ...args, import.meta.dir);
  await rm(OUTPUT, { recursive: true, force: true });
  await mkdir(OUTPUT, { recursive: true });
  const built =
    (await docker('build', '-t', 'debugger-sh-toolchain')) ||
    (await docker('build', '-t', image, '-f', path.join(DIR, 'Dockerfile'))) ||
    (await run('docker', 'run', '--rm', '-v', `${image}:/work`, '-v', `${OUTPUT}:/out`, image));
  if (built) return built;

  // The tests load artifacts from cross-origin isolated pages, which requires CORS and CORP.
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Cross-Origin-Resource-Policy': 'cross-origin'
  };
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const file = Bun.file(path.join(OUTPUT, path.basename(new URL(request.url).pathname)));
      if (!(await file.exists())) return new Response(null, { status: 404, headers });
      return new Response(file, { headers });
    }
  });

  const original = await Bun.file(PROVENANCE).text();
  let code;
  try {
    await writeProvenance({ ...provenance, artifacts: await artifactsAt(server.url.href) });
    code = (await run('npm', 'run', 'build')) || (await run('npm', 'run', 'test'));
  } finally {
    await Bun.write(PROVENANCE, original);
    server.stop(true);
  }
  // Rebuild the library with the original artifacts, even if the tests failed.
  const restored = await run('npm', 'run', 'build:ts');
  return code || restored;
}

/**
 * Builds the toolchain, then releases it on the fork as the library's version: the changes are
 * committed onto the upstream revision as branch `debugger-sh/<version>`, and the outputs are
 * attached to release `<version>` and published to the fork's GitHub Pages under `<version>/`,
 * which the artifacts then point at (unlike release downloads, Pages supports CORS). Releasing
 * again updates all of these in place.
 */
async function release(): Promise<number> {
  const { upstream } = provenance;
  const fork = new URL(provenance.fork.repository).pathname.slice(1);
  const { version } = await Bun.file(path.join(ROOT, 'package.json')).json();
  const branch = `debugger-sh/${version}`;

  // Check access to the fork first, since building takes a while.
  if ((await $`gh auth status`.quiet().nothrow()).exitCode) {
    fail('not logged in to GitHub, run `gh auth login`');
  }
  const access = await $`gh api repos/${fork} --jq ${'.permissions.push, .permissions.admin'}`
    .quiet()
    .nothrow();
  const [push, admin] = access.text().trim().split('\n');
  if (push !== 'true') fail(`no push access to ${fork}`);
  const pages = (await $`gh api repos/${fork}/pages`.quiet().nothrow()).exitCode === 0;
  if (!pages && admin !== 'true') fail(`enabling GitHub Pages on ${fork} requires admin access`);
  const protocol = await $`gh config get git_protocol -h github.com`.quiet().nothrow();
  const remote =
    protocol.text().trim() === 'ssh'
      ? `git@github.com:${fork}.git`
      : `https://github.com/${fork}.git`;
  const git = [
    'git',
    '-c',
    'credential.helper=',
    '-c',
    'credential.helper=!gh auth git-credential'
  ];
  if ((await $`${git} ls-remote ${remote} HEAD`.quiet().nothrow()).exitCode) {
    fail(`cannot access ${remote} with git`);
  }

  const built = await build();
  if (built) return built;
  const files = Object.values(await outputs()).map((file) => path.join(OUTPUT, file));

  const work = await mkdtemp(path.join(tmpdir(), `${name}-`));
  try {
    // The changes are committed with their author dates, so the same patch makes the same commits.
    const source = path.join(work, 'source');
    await $`git init -q ${source}`;
    await $`git fetch -q --depth 1 ${upstream.repository} ${upstream.revision}`.cwd(source);
    await $`git checkout -q FETCH_HEAD`.cwd(source);
    // A toolchain that needs no changes (and so has no patch) is released as the upstream revision.
    const patch = path.join(DIR, 'changes.patch');
    if (await Bun.file(patch).exists()) {
      await $`git am -q --committer-date-is-author-date ${patch}`.cwd(source);
    }
    await $`${git} push -q --force ${remote} HEAD:refs/heads/${branch} HEAD:refs/tags/${version}`.cwd(
      source
    );

    // GitHub Pages serves the `gh-pages` branch, which holds every release under `<version>/`.
    // It's a single commit without history, so that replaced artifacts don't take up space.
    const site = path.join(work, 'pages');
    await $`git init -q ${site}`;
    let previous = '';
    if (
      (await $`${git} fetch -q --depth 1 ${remote} gh-pages`.cwd(site).quiet().nothrow())
        .exitCode === 0
    ) {
      previous = await $`git cat-file -p FETCH_HEAD`.cwd(site).text();
      await $`git checkout -q FETCH_HEAD`.cwd(site);
    }
    await rm(path.join(site, version), { recursive: true, force: true });
    await mkdir(path.join(site, version));
    await $`cp ${files} ${path.join(site, version)} && touch .nojekyll && git add -A`.cwd(site);
    const tree = (await $`git write-tree`.cwd(site).text()).trim();
    if (!previous.startsWith(`tree ${tree}\n`) || previous.includes('\nparent ')) {
      const commit = await $`git commit-tree ${tree} -m ${`Release ${version}`}`.cwd(site).text();
      await $`${git} push -q --force ${remote} ${commit.trim()}:refs/heads/gh-pages`.cwd(site);
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  // Pushing `gh-pages` usually enables GitHub Pages, so only enable it if it wasn't.
  if ((await $`gh api repos/${fork}/pages`.quiet().nothrow()).exitCode) {
    const source = ['-f', 'source[branch]=gh-pages', '-f', 'source[path]=/'];
    await $`gh api -X POST repos/${fork}/pages ${source}`.quiet();
  }

  const short = upstream.revision.slice(0, 12);
  const notes = [
    `- Upstream: [${short}](${upstream.repository}/commit/${upstream.revision})`,
    `- Changes: [${short}...${branch}](${provenance.fork.repository}/compare/${upstream.revision}...${branch})`
  ].join('\n');
  if ((await $`gh release view ${version} -R ${fork}`.quiet().nothrow()).exitCode) {
    await $`gh release create ${version} -R ${fork} --verify-tag --title ${version} --notes ${notes} ${files}`;
  } else {
    await $`gh release edit ${version} -R ${fork} --title ${version} --notes ${notes}`;
    await $`gh release upload ${version} -R ${fork} --clobber ${files}`;
  }

  // Pages deploys asynchronously, so wait until it serves the artifacts.
  const site = (await $`gh api repos/${fork}/pages --jq .html_url`.text()).trim();
  const artifacts = await artifactsAt(new URL(`${version}/`, site).href);
  for (const url of Object.values(artifacts)) {
    for (let attempt = 1; !(await fetch(url, { method: 'HEAD' })).ok; attempt++) {
      if (attempt === 60) fail(`GitHub Pages didn't deploy ${url}`);
      await Bun.sleep(10_000);
    }
  }

  const url = (await $`gh release view ${version} -R ${fork} --json url --jq .url`.text()).trim();
  await writeProvenance({ ...provenance, fork: { ...provenance.fork, release: url }, artifacts });
  // Rebuild the library with the released artifacts.
  return run('npm', 'run', 'build:ts');
}
