import { Fs } from '../../pkg/engine';
import { internal, Internals, join } from './util';

/** A file timestamp. Either an ISO 8601 string, a Date, or a milliseconds epoch. */
export type Timestamp = string | Date | number;

/**
 * The timestamps of a file. Unspecified timestamps default to the current time.
 *
 * Note: `created` cannot be set yet, so it is ignored when mounting.
 */
export type Timestamps = {
  accessed?: Timestamp;
  modified?: Timestamp;
  created?: Timestamp;
};

/** The contents of a file, either as bytes or a UTF-8 encoded string. */
export type FileContents = Uint8Array | string;

/**
 * A representation of a file, either as its contents or as its contents and metadata.
 *
 * `encoding` determines the encoding of string-valued `contents`, and defaults to `utf8`.
 */
export type File =
  | FileContents
  | (Timestamps & { contents: FileContents; encoding?: 'base64' | 'utf8' });

/** A representation of a directory. */
export type Directory = { files: FileTree };

/** A tree of files in the filesystem. */
export type FileTree = { [name: string]: File | Directory };

export type ExportOptions = {
  /**
   * The format to export to. Defaults to "tree".
   *
   * If `tree` is selected, the exported object is JSON and includes maximal information
   * (binary files encoded as base-64 strings, file timestamps included).
   */
  format?: 'zip' | 'tar' | 'tarball' | 'tree';
  /** The directory to be exported. Defaults to "/" */
  at?: string;
  /** Glob patterns to include in the export, evaluated relative to `at`. Defaults to `["**\/*"]`. */
  include?: string[];
  /** Glob patterns to exclude in the export, evaluated relative to `at`. Defaults to `[]`. */
  exclude?: string[];
};

export interface FileStat {
  kind: 'file' | 'directory';
  size: number;
  modified: number;
  accessed: number;
  created: number;
}

const encoder = new TextEncoder();

/**
 * The engine's filesystem: a shared, in-memory filesystem which is visible to the main
 * thread and to every running process at the same time.
 *
 * Relative paths are relative to the root folder (`data.txt` is the same as `/data.txt`).
 */
export class Filesystem {
  /** @internal */
  readonly [Internals]: {
    /** The underlying filesystem, whose operations take care of locking. */
    raw(): Fs;
    dispose(): void;
    readonly ptr: number;
  };

  /** @internal */
  constructor(key: typeof Internals, fs: Fs) {
    internal(key);
    let current: Fs | undefined = fs;
    const ptr = fs.ptr();
    this[Internals] = {
      raw: () => {
        if (!current) throw new Error('The engine has been disposed');
        return current;
      },
      dispose: () => {
        current?.free();
        current = undefined;
      },
      ptr
    };
  }

  get #raw(): Fs {
    return this[Internals].raw();
  }

  /**
   * Unions a representation of a filesystem into this one. Existing files are never
   * removed, but conflicting files are overwritten.
   *
   * `fs` can be a:
   *
   *  1. FileTree:    a simple representation of a filesystem to be unioned.
   *  2. Uint8Array:  the bytes of a tarball (.tar.gz) or zip to be unioned.
   *  3. string:      a URL to a tarball or zip to be fetched and unioned.
   *
   * `at` determines the folder into which the contents are unioned (defaults to `/`).
   */
  async mount(fs: FileTree | Uint8Array | string, options?: { at?: string }): Promise<void> {
    const at = join(options?.at ?? '/');
    if (typeof fs === 'string') {
      const response = await fetch(fs);
      if (!response.ok) throw new Error(`Failed to fetch ${fs} (${response.status})`);
      fs = new Uint8Array(await response.arrayBuffer());
    }
    if (fs instanceof Uint8Array) return this.#raw.mount(at, fs);

    const mount = async (dir: string, tree: FileTree) => {
      await this.#raw.mkdir(dir, true);
      for (const [name, node] of Object.entries(tree)) {
        const path = join(dir, name);
        if (typeof node === 'object' && 'files' in node) {
          await mount(path, node.files);
          continue;
        }
        const file =
          typeof node === 'string' || node instanceof Uint8Array ? { contents: node } : node;
        await this.#raw.writeFile(path, bytes(file), time(file.modified), time(file.accessed));
      }
    };
    await mount(at, fs);
  }

  /** Exports the filesystem (or a part of it), in the same shapes accepted by {@link mount}. */
  export(options?: ExportOptions & { format?: 'tree' }): Promise<FileTree>;
  export(options: ExportOptions & { format: 'zip' | 'tar' | 'tarball' }): Promise<Uint8Array>;
  async export(options: ExportOptions = {}): Promise<FileTree | Uint8Array> {
    const { format = 'tree', include = ['**/*'], exclude = [] } = options;
    const at = join(options.at ?? '/');
    if (format !== 'tree') return this.#raw.archive(at, include, exclude, format === 'zip');

    const root: Directory = { files: {} };
    for (const entry of await this.#raw.glob(at, include, exclude)) {
      const parts = entry.replace(/\/$/, '').split('/');
      const name = parts.pop()!;
      let dir = root;
      for (const part of parts) dir = (dir.files[part] ??= { files: {} }) as Directory;
      if (entry.endsWith('/')) {
        dir.files[name] ??= { files: {} };
      } else {
        const path = join(at, entry);
        const [, , modified, accessed, created] = await this.#raw.stat(path);
        dir.files[name] = {
          ...encode(await this.#raw.readFile(path)),
          modified: iso(modified),
          accessed: iso(accessed),
          created: iso(created)
        };
      }
    }
    return root.files;
  }

  readFile(path: string, encoding: 'utf8'): Promise<string>;
  readFile(path: string): Promise<Uint8Array>;
  async readFile(path: string, encoding?: 'utf8'): Promise<Uint8Array | string> {
    const contents = await this.#raw.readFile(path);
    return encoding === 'utf8' ? new TextDecoder().decode(contents) : contents;
  }

  async writeFile(path: string, contents: string | Uint8Array): Promise<void> {
    return this.#raw.writeFile(path, bytes({ contents }));
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    return this.#raw.mkdir(path, options?.recursive ?? false);
  }

  async remove(path: string, options?: { recursive?: boolean }): Promise<void> {
    return this.#raw.remove(path, options?.recursive ?? false);
  }

  async rename(from: string, to: string): Promise<void> {
    return this.#raw.rename(from, to);
  }

  async stat(path: string): Promise<FileStat> {
    const [isDir, size, modified, accessed, created] = await this.#raw.stat(path);
    return { kind: isDir ? 'directory' : 'file', size, modified, accessed, created };
  }

  /** Lists the names of the entries in a directory. */
  async readDir(path: string): Promise<string[]> {
    return this.#raw.readDir(path);
  }
}

function bytes(file: { contents: FileContents; encoding?: 'base64' | 'utf8' }): Uint8Array {
  if (typeof file.contents !== 'string') return file.contents;
  if (file.encoding !== 'base64') return encoder.encode(file.contents);
  return Uint8Array.from(atob(file.contents), (c) => c.charCodeAt(0));
}

function encode(contents: Uint8Array): { contents: string; encoding: 'base64' | 'utf8' } {
  try {
    return {
      contents: new TextDecoder('utf-8', { fatal: true }).decode(contents),
      encoding: 'utf8'
    };
  } catch {
    let binary = '';
    for (let i = 0; i < contents.length; i += 0x8000)
      binary += String.fromCharCode(...contents.subarray(i, i + 0x8000));
    return { contents: btoa(binary), encoding: 'base64' };
  }
}

function time(timestamp?: Timestamp): number | undefined {
  if (timestamp === undefined) return undefined;
  return typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime();
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}
