import type { OutputAdapter, RemoteFile } from '@inkwise/core';

/**
 * Google Drive API mode. Needs an OAuth access token with the drive.file scope
 * (GDRIVE_ACCESS_TOKEN) and the id of the Drive folder the Supernote syncs as
 * `Document` (`gdrive.folderId` in config). Inkwise creates an `Inkwise` folder
 * inside it. For the desktop-app mode, use the folder adapter instead.
 */
export class GoogleDriveOutput implements OutputAdapter {
  readonly name = 'gdrive' as const;
  private folderId: string | null = null;

  constructor(
    private readonly token: string,
    private readonly parentFolderId: string,
    private readonly folderName = 'Inkwise',
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async list(): Promise<RemoteFile[]> {
    const folder = await this.ensureFolder(this.parentFolderId, this.folderName, false);
    if (!folder) return [];
    return (await this.children(folder, false)).map((f) => ({ name: f.name, size: f.size ? Number(f.size) : undefined }));
  }

  async put(filename: string, bytes: Uint8Array): Promise<void> {
    const folder = (await this.ensureFolder(this.parentFolderId, this.folderName, true))!;
    const existing = (await this.children(folder, false)).find((f) => f.name === filename);
    const boundary = `inkwise${Date.now().toString(36)}`;
    const meta = existing ? {} : { name: filename, parents: [folder], mimeType: 'application/epub+zip' };
    const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/epub+zip\r\n\r\n`;
    const tail = `\r\n--${boundary}--`;
    const body = concat(new TextEncoder().encode(head), bytes, new TextEncoder().encode(tail));
    const url = existing
      ? `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=multipart`
      : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
    const res = await this.fetchImpl(url, {
      method: existing ? 'PATCH' : 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
    if (!res.ok) throw new Error(`Google Drive upload failed (HTTP ${res.status}): ${await res.text()}`);
  }

  async remove(filename: string): Promise<void> {
    const folder = await this.ensureFolder(this.parentFolderId, this.folderName, false);
    if (!folder) return;
    const f = (await this.children(folder, false)).find((x) => x.name === filename);
    if (!f) return;
    await this.api(`files/${f.id}`, { method: 'DELETE' });
  }

  async moveToSubfolder(filename: string, subfolder: string): Promise<void> {
    const folder = await this.ensureFolder(this.parentFolderId, this.folderName, false);
    if (!folder) return;
    const f = (await this.children(folder, false)).find((x) => x.name === filename);
    if (!f) return;
    const target = (await this.ensureFolder(folder, subfolder, true))!;
    await this.api(`files/${f.id}?addParents=${target}&removeParents=${folder}`, { method: 'PATCH', body: '{}' });
  }

  private async ensureFolder(parent: string, name: string, create: boolean): Promise<string | null> {
    if (parent === this.parentFolderId && name === this.folderName && this.folderId) return this.folderId;
    const found = (await this.children(parent, true)).find((f) => f.name === name);
    let id = found?.id ?? null;
    if (!id && create) {
      const res = await this.api('files', {
        method: 'POST',
        body: JSON.stringify({ name, parents: [parent], mimeType: 'application/vnd.google-apps.folder' }),
      });
      id = ((await res.json()) as any).id;
    }
    if (parent === this.parentFolderId && name === this.folderName) this.folderId = id;
    return id;
  }

  private async children(parent: string, folders: boolean): Promise<{ id: string; name: string; size?: string }[]> {
    const mime = folders ? "mimeType = 'application/vnd.google-apps.folder'" : "mimeType != 'application/vnd.google-apps.folder'";
    const q = encodeURIComponent(`'${parent}' in parents and trashed = false and ${mime}`);
    const out: { id: string; name: string; size?: string }[] = [];
    let pageToken = '';
    do {
      const res = await this.api(`files?q=${q}&fields=nextPageToken,files(id,name,size)&pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`);
      const body: any = await res.json();
      out.push(...(body.files ?? []));
      pageToken = body.nextPageToken ?? '';
    } while (pageToken);
    return out;
  }

  private async api(path: string, init: { method?: string; body?: string } = {}) {
    const res = await this.fetchImpl(`https://www.googleapis.com/drive/v3/${path}`, {
      method: init.method ?? 'GET',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: init.body,
    });
    if (!res.ok) throw new Error(`Google Drive ${init.method ?? 'GET'} ${path.split('?')[0]} failed (HTTP ${res.status}): ${await res.text()}`);
    return res;
  }
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
