import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { OutputAdapter, RemoteFile } from '@inkwise/core';

/**
 * Writes into any local folder: a USB-mounted Supernote, the Dropbox or Google
 * Drive desktop folder, or a scratch directory for testing.
 */
export class FolderOutput implements OutputAdapter {
  readonly name: OutputAdapter['name'];

  constructor(readonly dir: string, name: OutputAdapter['name'] = 'folder') {
    this.name = name;
  }

  async list(): Promise<RemoteFile[]> {
    let entries;
    try {
      entries = await readdir(this.dir, { withFileTypes: true });
    } catch (err: any) {
      if (err?.code === 'ENOENT') return [];
      throw err;
    }
    const files: RemoteFile[] = [];
    for (const e of entries) {
      if (!e.isFile()) continue;
      const s = await stat(join(this.dir, e.name));
      files.push({ name: e.name, size: s.size });
    }
    return files;
  }

  async put(filename: string, bytes: Uint8Array): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    // Write to a temp name first so a half-written EPUB never shows up on the device.
    const tmp = join(this.dir, `.${filename}.part`);
    await writeFile(tmp, bytes);
    await rename(tmp, join(this.dir, filename));
  }

  async remove(filename: string): Promise<void> {
    await rm(join(this.dir, filename), { force: true });
  }

  async moveToSubfolder(filename: string, subfolder: string): Promise<void> {
    const target = join(this.dir, subfolder);
    await mkdir(target, { recursive: true });
    await rename(join(this.dir, filename), join(target, filename));
  }
}
