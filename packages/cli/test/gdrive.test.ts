import { describe, expect, it } from 'vitest';
import { GoogleDriveOutput } from '../src/adapters/gdrive.js';

const TOKEN = 'fake-drive-token';
const PARENT = 'documentFolderId123';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const bytes = (s: string) => new TextEncoder().encode(s);

interface DriveFile {
  id: string;
  name: string;
  parents: string[];
  mimeType: string;
  trashed: boolean;
  data?: Uint8Array;
}

/** Minimal in-memory Google Drive v3 (metadata + multipart upload). */
class FakeDrive {
  files = new Map<string, DriveFile>();
  calls: { method: string; url: string; headers: Record<string, string> }[] = [];
  pageSize = 2;
  private n = 0;
  private pages = new Map<string, DriveFile[]>();

  add(f: Partial<DriveFile> & { name: string; parents: string[] }): DriveFile {
    const file: DriveFile = { id: `id${++this.n}`, mimeType: 'application/epub+zip', trashed: false, ...f };
    this.files.set(file.id, file);
    return file;
  }

  childrenOf(parent: string, folders?: boolean) {
    return [...this.files.values()].filter(
      (f) => f.parents.includes(parent) && !f.trashed && (folders === undefined || (f.mimeType === FOLDER_MIME) === folders),
    );
  }

  fetch: typeof fetch = async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    this.calls.push({ method, url: String(input), headers });
    if (headers['authorization'] !== `Bearer ${TOKEN}`) return json({ error: { code: 401, message: 'Invalid Credentials' } }, 401);

    const meta = url.pathname.match(/^\/drive\/v3\/files(?:\/([^/]+))?$/);
    const upload = url.pathname.match(/^\/upload\/drive\/v3\/files(?:\/([^/]+))?$/);

    if (meta && !meta[1] && method === 'GET') {
      const pageToken = url.searchParams.get('pageToken');
      let all: DriveFile[];
      if (pageToken) {
        const p = this.pages.get(pageToken);
        if (!p) return json({ error: { code: 400, message: 'Invalid pageToken' } }, 400);
        all = p;
      } else {
        const q = url.searchParams.get('q') ?? '';
        const m = q.match(/^'([^']+)' in parents and trashed = false and mimeType (=|!=) '([^']+)'$/);
        if (!m) return json({ error: { code: 400, message: `Unsupported q: ${q}` } }, 400);
        all = this.childrenOf(m[1]!, m[2] === '=' ? m[3] === FOLDER_MIME : m[3] !== FOLDER_MIME);
        if (url.searchParams.get('fields') !== 'nextPageToken,files(id,name,size)') return json({ error: { code: 400 } }, 400);
      }
      const page = all.slice(0, this.pageSize);
      const rest = all.slice(this.pageSize);
      let nextPageToken: string | undefined;
      if (rest.length) {
        // Opaque tokens can contain characters that must be URL-encoded.
        nextPageToken = `~!!~tok+${this.pages.size}/a=b&c`;
        this.pages.set(nextPageToken, rest);
      }
      const files = page.map((f) => ({ id: f.id, name: f.name, ...(f.data ? { size: String(f.data.byteLength) } : {}) }));
      return json(nextPageToken ? { files, nextPageToken } : { files });
    }

    if (meta && !meta[1] && method === 'POST') {
      const b = JSON.parse(init.body);
      const f = this.add({ name: b.name, parents: b.parents, mimeType: b.mimeType });
      return json({ id: f.id, name: f.name });
    }

    if (meta && meta[1]) {
      const f = this.files.get(meta[1]);
      if (!f) return json({ error: { code: 404, message: 'File not found' } }, 404);
      if (method === 'DELETE') {
        this.files.delete(f.id);
        return new Response(null, { status: 204 });
      }
      if (method === 'PATCH') {
        const add = url.searchParams.get('addParents');
        const remove = url.searchParams.get('removeParents');
        if (remove) f.parents = f.parents.filter((p) => p !== remove);
        if (add) f.parents.push(add);
        return json({ id: f.id });
      }
    }

    if (upload && url.searchParams.get('uploadType') === 'multipart') {
      const { metadata, media, mediaType } = parseMultipart(headers['content-type']!, init.body);
      if (!upload[1] && method === 'POST') {
        const f = this.add({ name: metadata.name, parents: metadata.parents, mimeType: metadata.mimeType, data: media });
        return json({ id: f.id });
      }
      if (upload[1] && method === 'PATCH') {
        const f = this.files.get(upload[1]);
        if (!f) return json({ error: { code: 404 } }, 404);
        if (metadata.parents) return json({ error: { code: 403, message: 'parents not writable in update' } }, 403);
        Object.assign(f, metadata, { data: media });
        expect(mediaType).toBe('application/epub+zip');
        return json({ id: f.id });
      }
    }
    return json({ error: { code: 404, message: `No route ${method} ${url.pathname}` } }, 404);
  };
}

function parseMultipart(contentType: string, body: Uint8Array) {
  const boundary = contentType.match(/^multipart\/related; boundary=(.+)$/)![1]!;
  const text = Buffer.from(body).toString('latin1');
  const parts = text.split(`--${boundary}`);
  // ['', meta, media, '--']
  expect(parts.at(-1)).toBe('--');
  const parse = (p: string) => {
    const [head, ...rest] = p.replace(/^\r\n/, '').split('\r\n\r\n');
    return { head: head!, body: rest.join('\r\n\r\n').replace(/\r\n$/, '') };
  };
  const m = parse(parts[1]!);
  const d = parse(parts[2]!);
  expect(m.head).toBe('Content-Type: application/json; charset=UTF-8');
  return {
    metadata: JSON.parse(Buffer.from(m.body, 'latin1').toString('utf8')),
    media: new Uint8Array(Buffer.from(d.body, 'latin1')),
    mediaType: d.head.replace('Content-Type: ', ''),
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const make = (drive: FakeDrive, token = TOKEN) => new GoogleDriveOutput(token, PARENT, 'Inkwise', drive.fetch);

describe('GoogleDriveOutput', () => {
  it('list() returns [] and creates nothing when the Inkwise folder is missing', async () => {
    const drive = new FakeDrive();
    expect(await make(drive).list()).toEqual([]);
    expect(drive.calls.every((c) => c.method === 'GET')).toBe(true);
    expect(drive.files.size).toBe(0);
  });

  it('put() creates the folder, then uploads with a multipart POST', async () => {
    const drive = new FakeDrive();
    const out = make(drive);
    const data = new Uint8Array([0x50, 0x4b, 3, 4, 0, 0xff, 0x0d, 0x0a, 0x2d, 0x2d]);
    await out.put('Café notes.epub', data);
    const [folder] = drive.childrenOf(PARENT, true);
    expect(folder).toMatchObject({ name: 'Inkwise', mimeType: FOLDER_MIME });
    const [file] = drive.childrenOf(folder!.id, false);
    expect(file).toMatchObject({ name: 'Café notes.epub', mimeType: 'application/epub+zip' });
    expect(file!.data).toEqual(data);
    const up = drive.calls.find((c) => c.url.includes('/upload/'))!;
    expect(up.method).toBe('POST');
    expect(up.url).toBe('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart');
    // Folder is cached: a second put doesn't look it up or create it again.
    const before = drive.calls.length;
    await out.put('second.epub', bytes('2'));
    expect(drive.childrenOf(PARENT, true)).toHaveLength(1);
    expect(drive.calls.length - before).toBe(2); // list children + upload
  });

  it('put() updates an existing file in place with PATCH', async () => {
    const drive = new FakeDrive();
    const folder = drive.add({ name: 'Inkwise', parents: [PARENT], mimeType: FOLDER_MIME });
    const existing = drive.add({ name: 'a.epub', parents: [folder.id], data: bytes('old') });
    await make(drive).put('a.epub', bytes('new content'));
    expect(drive.childrenOf(folder.id, false)).toHaveLength(1);
    expect(drive.files.get(existing.id)!.data).toEqual(bytes('new content'));
    const up = drive.calls.find((c) => c.url.includes('/upload/'))!;
    expect(up.method).toBe('PATCH');
    expect(up.url).toBe(`https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=multipart`);
  });

  it('list() pages through nextPageToken and reports sizes as numbers', async () => {
    const drive = new FakeDrive();
    const folder = drive.add({ name: 'Inkwise', parents: [PARENT], mimeType: FOLDER_MIME });
    for (let i = 0; i < 5; i++) drive.add({ name: `f${i}.epub`, parents: [folder.id], data: bytes('x'.repeat(i)) });
    drive.add({ name: 'Archive', parents: [folder.id], mimeType: FOLDER_MIME });
    drive.add({ name: 'trashed.epub', parents: [folder.id], trashed: true, data: bytes('t') });
    const files = await make(drive).list();
    expect(files).toEqual([0, 1, 2, 3, 4].map((i) => ({ name: `f${i}.epub`, size: i })));
    expect(drive.calls.filter((c) => c.url.includes('pageToken='))).toHaveLength(2);
  });

  it('finds the Inkwise folder even when it is on a later page', async () => {
    const drive = new FakeDrive();
    for (let i = 0; i < 5; i++) drive.add({ name: `Other ${i}`, parents: [PARENT], mimeType: FOLDER_MIME });
    const folder = drive.add({ name: 'Inkwise', parents: [PARENT], mimeType: FOLDER_MIME });
    drive.add({ name: 'deep.epub', parents: [folder.id], data: bytes('d') });
    expect(await make(drive).list()).toEqual([{ name: 'deep.epub', size: 1 }]);
  });

  it('remove() deletes the named file and ignores unknown names', async () => {
    const drive = new FakeDrive();
    const folder = drive.add({ name: 'Inkwise', parents: [PARENT], mimeType: FOLDER_MIME });
    const a = drive.add({ name: 'a.epub', parents: [folder.id], data: bytes('a') });
    drive.add({ name: 'b.epub', parents: [folder.id], data: bytes('b') });
    const out = make(drive);
    await out.remove('a.epub');
    await out.remove('missing.epub');
    expect(drive.files.has(a.id)).toBe(false);
    expect(drive.childrenOf(folder.id).map((f) => f.name)).toEqual(['b.epub']);
    expect(drive.calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });

  it('remove() does nothing when the folder is missing', async () => {
    const drive = new FakeDrive();
    await make(drive).remove('a.epub');
    expect(drive.calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
  });

  it('moveToSubfolder() creates Archive and swaps parents', async () => {
    const drive = new FakeDrive();
    const folder = drive.add({ name: 'Inkwise', parents: [PARENT], mimeType: FOLDER_MIME });
    const a = drive.add({ name: 'a.epub', parents: [folder.id], data: bytes('a') });
    const out = make(drive);
    await out.moveToSubfolder('a.epub', 'Archive');
    const archive = drive.childrenOf(folder.id, true).find((f) => f.name === 'Archive')!;
    expect(archive).toBeDefined();
    expect(drive.files.get(a.id)!.parents).toEqual([archive.id]);
    expect(await out.list()).toEqual([]);
    // A second move reuses the existing Archive folder.
    drive.add({ name: 'b.epub', parents: [folder.id], data: bytes('b') });
    await out.moveToSubfolder('b.epub', 'Archive');
    expect(drive.childrenOf(folder.id, true)).toHaveLength(1);
    expect(drive.childrenOf(archive.id).map((f) => f.name).sort()).toEqual(['a.epub', 'b.epub']);
  });

  it('moveToSubfolder() ignores a missing file', async () => {
    const drive = new FakeDrive();
    drive.add({ name: 'Inkwise', parents: [PARENT], mimeType: FOLDER_MIME });
    await make(drive).moveToSubfolder('nope.epub', 'Archive');
    expect(drive.calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
  });

  it('surfaces API errors with status and path', async () => {
    const drive = new FakeDrive();
    await expect(make(drive, 'bad-token').list()).rejects.toThrow(/Google Drive GET files failed \(HTTP 401\)/);
  });
});
