import type { OutputAdapter, RemoteFile } from '@inkwise/core';

/**
 * Dropbox API mode, for headless runs. Needs a token with files.content.write
 * (DROPBOX_TOKEN). For the desktop-app mode, use the folder adapter pointed at
 * your local Dropbox folder instead.
 *
 * `root` is the Dropbox path the Supernote syncs as its Document folder, e.g.
 * `/Supernote/Document`. Confirm it on the device before relying on it.
 */
export class DropboxOutput implements OutputAdapter {
  readonly name = 'dropbox' as const;
  private readonly folder: string;

  constructor(
    private readonly token: string,
    root: string,
    folderName = 'Inkwise',
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.folder = `${root.replace(/\/+$/, '')}/${folderName}`;
  }

  async list(): Promise<RemoteFile[]> {
    const files: RemoteFile[] = [];
    let res = await this.rpc('files/list_folder', { path: this.folder, recursive: false }, [409]);
    if (res.status === 409) return []; // folder doesn't exist yet
    let body: any = await res.json();
    for (;;) {
      for (const e of body.entries ?? []) {
        if (e['.tag'] === 'file') files.push({ name: e.name, size: e.size });
      }
      if (!body.has_more) break;
      res = await this.rpc('files/list_folder/continue', { cursor: body.cursor });
      body = await res.json();
    }
    return files;
  }

  async put(filename: string, bytes: Uint8Array): Promise<void> {
    const res = await this.fetchImpl('https://content.dropboxapi.com/2/files/upload', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': asciiJson({ path: `${this.folder}/${filename}`, mode: 'overwrite', mute: true }),
      },
      body: bytes,
    });
    if (!res.ok) throw new Error(`Dropbox upload failed (HTTP ${res.status}): ${await res.text()}`);
  }

  async remove(filename: string): Promise<void> {
    await this.rpc('files/delete_v2', { path: `${this.folder}/${filename}` }, [409]);
  }

  async moveToSubfolder(filename: string, subfolder: string): Promise<void> {
    await this.rpc('files/move_v2', {
      from_path: `${this.folder}/${filename}`,
      to_path: `${this.folder}/${subfolder}/${filename}`,
      autorename: true,
    });
  }

  private async rpc(endpoint: string, body: unknown, allow: number[] = []) {
    const res = await this.fetchImpl(`https://api.dropboxapi.com/2/${endpoint}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok && !allow.includes(res.status)) {
      throw new Error(`Dropbox ${endpoint} failed (HTTP ${res.status}): ${await res.text()}`);
    }
    return res;
  }
}

/** Dropbox-API-Arg must be ASCII; non-ASCII characters are sent as \u escapes. */
function asciiJson(v: unknown): string {
  return JSON.stringify(v).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
