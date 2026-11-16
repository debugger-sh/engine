// Preserve every previous content-addressed artifact when updating the Pages mirror.
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const [operation, directory] = process.argv.slice(2);
const remote = process.env.ENGINE_PAGES_REMOTE ?? 'origin';
const reference = 'refs/remotes/engine-pages/current';
const git = (args, options = {}) =>
  execFileSync('git', args, { maxBuffer: 512 * 1024 * 1024, ...options });
if (operation === 'restore') {
  const exists = git(['ls-remote', '--heads', remote, 'gh-pages']).toString().trim();
  if (exists) {
    git(['fetch', '--depth=1', remote, `+refs/heads/gh-pages:${reference}`]);
    execFileSync('tar', ['-x', '-C', directory], { input: git(['archive', reference]) });
  }
} else if (operation === 'save') {
  const temporary = await mkdtemp(path.join(tmpdir(), 'engine-pages-index-'));
  const env = {
    ...process.env,
    GIT_INDEX_FILE: path.join(temporary, 'index'),
    GIT_AUTHOR_NAME: 'Engine artifact mirror',
    GIT_AUTHOR_EMAIL: 'actions@users.noreply.github.com',
    GIT_COMMITTER_NAME: 'Engine artifact mirror',
    GIT_COMMITTER_EMAIL: 'actions@users.noreply.github.com'
  };
  try {
    let parent;
    try {
      parent = git(['rev-parse', '--verify', reference]).toString().trim();
    } catch {}
    git(['read-tree', ...(parent ? [parent] : ['--empty'])], { env });
    await writeFile(path.join(directory, '.nojekyll'), '');
    const files = await readdir(directory, { recursive: true, withFileTypes: true });
    for (const entry of files) {
      if (!entry.isFile()) continue;
      const filename = path.join(entry.parentPath, entry.name);
      const hash = git(['hash-object', '-w', filename]).toString().trim();
      git(
        [
          'update-index',
          '--add',
          '--cacheinfo',
          `100644,${hash},${path.relative(directory, filename)}`
        ],
        { env }
      );
    }
    const tree = git(['write-tree'], { env }).toString().trim();
    if (
      !parent ||
      tree !==
        git(['rev-parse', `${parent}^{tree}`])
          .toString()
          .trim()
    ) {
      const commit = git(
        [
          'commit-tree',
          tree,
          ...(parent ? ['-p', parent] : []),
          '-m',
          'Preserve checksum-addressed toolchain artifacts'
        ],
        { env }
      )
        .toString()
        .trim();
      git(['push', remote, `${commit}:refs/heads/gh-pages`], { stdio: 'inherit' });
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
} else throw new Error('expected restore or save');
