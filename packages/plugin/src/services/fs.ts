import { strFromU8, strToU8 } from 'fflate';

/**
 * The file operations the plugin needs. On the device this is backed by
 * react-native-fs (see rnfs.ts); tests use MemoryFs. Keeping it behind an
 * interface keeps every service testable without a Supernote.
 */
export interface DeviceFs {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  /** File names (not paths) of regular files directly inside `dir`. */
  listFiles(dir: string): Promise<{ name: string; size: number }[]>;
  readText(path: string): Promise<string>;
  writeText(path: string, text: string): Promise<void>;
  readBytes(path: string): Promise<Uint8Array>;
  writeBytes(path: string, bytes: Uint8Array): Promise<void>;
  move(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  /** Download a URL to a file; returns the HTTP status. */
  download?(url: string, to: string): Promise<number>;
}

export function joinPath(...parts: string[]): string {
  return parts
    .filter(Boolean)
    .join('/')
    .replace(/\/{2,}/g, '/');
}

export function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i <= 0 ? '/' : path.slice(0, i);
}

/** In-memory filesystem for tests. */
export class MemoryFs implements DeviceFs {
  files = new Map<string, Uint8Array>();
  dirs = new Set<string>(['/']);
  /** Paths whose writes should fail, to simulate permission errors. */
  denyWrite = new Set<string>();

  async exists(path: string) {
    return this.files.has(path) || this.dirs.has(path);
  }
  async mkdir(path: string) {
    let p = '';
    for (const part of path.split('/').filter(Boolean)) {
      p += `/${part}`;
      this.dirs.add(p);
    }
  }
  async listFiles(dir: string) {
    const prefix = dir.endsWith('/') ? dir : `${dir}/`;
    return [...this.files.entries()]
      .filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
      .map(([p, b]) => ({ name: p.slice(prefix.length), size: b.length }));
  }
  async readText(path: string) {
    const b = this.files.get(path);
    if (!b) throw new Error(`ENOENT: ${path}`);
    return strFromU8(b);
  }
  async writeText(path: string, text: string) {
    await this.writeBytes(path, strToU8(text));
  }
  async readBytes(path: string) {
    const b = this.files.get(path);
    if (!b) throw new Error(`ENOENT: ${path}`);
    return b;
  }
  async writeBytes(path: string, bytes: Uint8Array) {
    for (const d of this.denyWrite) if (path.startsWith(d)) throw new Error(`Permission denied (1501): ${path}`);
    if (!this.dirs.has(dirOf(path))) throw new Error(`ENOENT: no such directory ${dirOf(path)}`);
    this.files.set(path, bytes);
  }
  async move(from: string, to: string) {
    const b = this.files.get(from);
    if (!b) throw new Error(`ENOENT: ${from}`);
    if (!this.dirs.has(dirOf(to))) throw new Error(`ENOENT: no such directory ${dirOf(to)}`);
    this.files.delete(from);
    this.files.set(to, b);
  }
  async unlink(path: string) {
    this.files.delete(path);
  }
}
