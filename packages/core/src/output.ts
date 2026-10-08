/**
 * Where EPUBs go. The CLI has one adapter per sync service; the device plugin
 * writes straight into `Document/Inkwise/`.
 */

export type AdapterName = 'supernote-cloud' | 'dropbox' | 'gdrive' | 'folder' | 'device' | 'memory';

export interface RemoteFile {
  name: string;
  size?: number;
}

export interface OutputAdapter {
  name: AdapterName;
  /** Files currently in the Inkwise folder (top level only). */
  list(): Promise<RemoteFile[]>;
  put(filename: string, bytes: Uint8Array): Promise<void>;
  /** Optional cleanup. */
  remove?(filename: string): Promise<void>;
  /** Optional: move a file into a subfolder (used for `Archive/`). */
  moveToSubfolder?(filename: string, subfolder: string): Promise<void>;
}

/** Adapter that keeps files in memory; used by tests and `--dry-run`. */
export class MemoryOutput implements OutputAdapter {
  readonly name = 'memory' as const;
  files = new Map<string, Uint8Array>();
  async list() {
    return [...this.files.entries()]
      .filter(([name]) => !name.includes('/'))
      .map(([name, b]) => ({ name, size: b.length }));
  }
  async put(filename: string, bytes: Uint8Array) {
    this.files.set(filename, bytes);
  }
  async remove(filename: string) {
    this.files.delete(filename);
  }
  async moveToSubfolder(filename: string, subfolder: string) {
    const b = this.files.get(filename);
    if (!b) return;
    this.files.delete(filename);
    this.files.set(`${subfolder}/${filename}`, b);
  }
}
