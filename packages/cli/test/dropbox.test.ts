import { describe, expect, it } from 'vitest';
import { DropboxOutput } from '../src/adapters/dropbox.js';

const TOKEN = 'fake-dropbox-token';
const bytes = (s: string) => new TextEncoder().encode(s);

/** Minimal in-memory Dropbox API v2 (api.dropboxapi.com + content.dropboxapi.com). */
class FakeDropbox {
  files = new Map<string, Uint8Array>(); // lowercased path -> bytes
  names = new Map<string, string>(); // lowercased path -> display path
  folders = new Set<string>(['']);
  calls: { url: string; headers: Record<string, string>; body: any }[] = [];
  pageSize = 2;
  private cursors = new Map<string, { entries: any[]; offset: number }>();

  addFile(path: string, data: Uint8Array) {
    const key = path.toLowerCase();
    this.files.set(key, data);
    this.names.set(key, path);
    this.mkdirs(path.slice(0, path.lastIndexOf('/')));
  }

  mkdirs(path: string) {
    const parts = path.split('/').filter(Boolean);
    for (let i = 1; i <= parts.length; i++) this.folders.add('/' + parts.slice(0, i).join('/').toLowerCase());
  }

  read(path: string) {
    return this.files.get(path.toLowerCase());
  }

  fetch: typeof fetch = async (input: any, init: any = {}) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    this.calls.push({ url, headers, body: init.body });
    if (init.method !== 'POST') return text('POST only', 405);
    if (headers['authorization'] !== `Bearer ${TOKEN}`) return json({ error_summary: 'invalid_access_token/' }, 401);

    if (url === 'https://content.dropboxapi.com/2/files/upload') {
      const arg = headers['dropbox-api-arg'];
      // Real Dropbox rejects non-ASCII header values; HTTP headers are bytes, not UTF-8.
      if (!arg || !/^[\x20-\x7e]*$/.test(arg)) return text('Error in call to API function "files/upload": header Dropbox-API-Arg must be ASCII', 400);
      if (headers['content-type'] !== 'application/octet-stream') return text('bad content type', 400);
      const a = JSON.parse(arg);
      if (a.mode !== 'overwrite' && this.read(a.path)) return json({ error_summary: 'path/conflict/file/' }, 409);
      this.addFile(a.path, new Uint8Array(init.body));
      return json({ name: a.path.split('/').pop(), path_display: a.path, size: init.body.byteLength });
    }

    const prefix = 'https://api.dropboxapi.com/2/';
    if (!url.startsWith(prefix)) return text('not found', 404);
    if (headers['content-type'] !== 'application/json') return text('bad content type', 400);
    const b = JSON.parse(init.body);
    switch (url.slice(prefix.length)) {
      case 'files/list_folder': {
        const dir = b.path.toLowerCase();
        if (!this.folders.has(dir)) return json({ error_summary: 'path/not_found/..', error: { '.tag': 'path' } }, 409);
        const entries: any[] = [];
        for (const f of this.folders) {
          if (f && f.slice(0, f.lastIndexOf('/')) === dir) entries.push({ '.tag': 'folder', name: f.split('/').pop() });
        }
        for (const [k, v] of this.files) {
          if (k.slice(0, k.lastIndexOf('/')) === dir) entries.push({ '.tag': 'file', name: this.names.get(k)!.split('/').pop(), size: v.byteLength });
        }
        return this.page({ entries, offset: 0 });
      }
      case 'files/list_folder/continue': {
        const c = this.cursors.get(b.cursor);
        if (!c) return json({ error_summary: 'reset/' }, 409);
        return this.page(c);
      }
      case 'files/delete_v2': {
        const k = b.path.toLowerCase();
        if (!this.files.has(k)) return json({ error_summary: 'path_lookup/not_found/' }, 409);
        this.files.delete(k);
        this.names.delete(k);
        return json({ metadata: { '.tag': 'file' } });
      }
      case 'files/move_v2': {
        const from = b.from_path.toLowerCase();
        const data = this.files.get(from);
        if (!data) return json({ error_summary: 'from_lookup/not_found/' }, 409);
        let to: string = b.to_path;
        if (this.read(to)) {
          if (!b.autorename) return json({ error_summary: 'to/conflict/file/' }, 409);
          to = to.replace(/(\.[^.]+)$/, ' (1)$1');
        }
        this.files.delete(from);
        this.names.delete(from);
        this.addFile(to, data);
        return json({ metadata: { path_display: to } });
      }
    }
    return text('unknown endpoint', 400);
  };

  private page(c: { entries: any[]; offset: number }) {
    const entries = c.entries.slice(c.offset, c.offset + this.pageSize);
    const next = { entries: c.entries, offset: c.offset + this.pageSize };
    const has_more = next.offset < c.entries.length;
    const cursor = `cursor-${this.cursors.size + 1}`;
    if (has_more) this.cursors.set(cursor, next);
    return json({ entries, cursor, has_more });
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
function text(body: string, status: number) {
  return new Response(body, { status });
}

describe('DropboxOutput', () => {
  it('list() returns [] when the folder does not exist (409)', async () => {
    const dbx = new FakeDropbox();
    const out = new DropboxOutput(TOKEN, '/Supernote/Document', 'Inkwise', dbx.fetch);
    expect(await out.list()).toEqual([]);
    expect(dbx.calls).toHaveLength(1);
  });

  it('list() follows has_more/continue and keeps only files', async () => {
    const dbx = new FakeDropbox();
    for (let i = 0; i < 5; i++) dbx.addFile(`/Supernote/Document/Inkwise/doc-${i}.epub`, bytes('x'.repeat(i + 1)));
    dbx.mkdirs('/Supernote/Document/Inkwise/Archive');
    dbx.addFile('/Supernote/Document/Inkwise/Archive/old.epub', bytes('old'));
    const out = new DropboxOutput(TOKEN, '/Supernote/Document', 'Inkwise', dbx.fetch);
    const files = await out.list();
    expect(files.sort((a, b) => a.name.localeCompare(b.name))).toEqual(
      [0, 1, 2, 3, 4].map((i) => ({ name: `doc-${i}.epub`, size: i + 1 })),
    );
    const endpoints = dbx.calls.map((c) => c.url.replace('https://api.dropboxapi.com/2/', ''));
    expect(endpoints).toEqual(['files/list_folder', 'files/list_folder/continue', 'files/list_folder/continue']);
    expect(JSON.parse(dbx.calls[0]!.body)).toEqual({ path: '/Supernote/Document/Inkwise', recursive: false });
    expect(JSON.parse(dbx.calls[1]!.body)).toEqual({ cursor: 'cursor-1' });
  });

  it('strips trailing slashes from the root', async () => {
    const dbx = new FakeDropbox();
    const out = new DropboxOutput(TOKEN, '/Supernote/Document///', 'Inkwise', dbx.fetch);
    await out.put('a.epub', bytes('a'));
    expect(dbx.read('/Supernote/Document/Inkwise/a.epub')).toEqual(bytes('a'));
  });

  it('put() uploads raw bytes in overwrite mode', async () => {
    const dbx = new FakeDropbox();
    const out = new DropboxOutput(TOKEN, '/Supernote/Document', 'Inkwise', dbx.fetch);
    const data = new Uint8Array([0, 1, 2, 250, 255]);
    await out.put('Article.epub', data);
    await out.put('Article.epub', bytes('v2'));
    expect(dbx.read('/Supernote/Document/Inkwise/Article.epub')).toEqual(bytes('v2'));
    const arg = JSON.parse(dbx.calls[0]!.headers['dropbox-api-arg']!);
    expect(arg).toEqual({ path: '/Supernote/Document/Inkwise/Article.epub', mode: 'overwrite', mute: true });
  });

  it('put() escapes non-ASCII filenames in Dropbox-API-Arg', async () => {
    const dbx = new FakeDropbox();
    const out = new DropboxOutput(TOKEN, '/Supernote/Document', 'Inkwise', dbx.fetch);
    const name = 'Café—Ünïcödé 日本語 😀.epub';
    await out.put(name, bytes('u'));
    const header = dbx.calls[0]!.headers['dropbox-api-arg']!;
    expect(header).toMatch(/^[\x20-\x7e]+$/);
    expect(header).toContain('\\u00e9');
    expect(header).toContain('\\ud83d\\ude00');
    expect(JSON.parse(header).path).toBe(`/Supernote/Document/Inkwise/${name}`);
    expect(dbx.read(`/Supernote/Document/Inkwise/${name}`)).toEqual(bytes('u'));
    expect((await out.list()).map((f) => f.name)).toEqual([name]);
  });

  it('put() surfaces upload errors', async () => {
    const dbx = new FakeDropbox();
    const out = new DropboxOutput('wrong-token', '/Supernote/Document', 'Inkwise', dbx.fetch);
    await expect(out.put('a.epub', bytes('a'))).rejects.toThrow(/Dropbox upload failed \(HTTP 401\)/);
  });

  it('remove() deletes and tolerates a missing file (409)', async () => {
    const dbx = new FakeDropbox();
    dbx.addFile('/Supernote/Document/Inkwise/a.epub', bytes('a'));
    const out = new DropboxOutput(TOKEN, '/Supernote/Document', 'Inkwise', dbx.fetch);
    await out.remove('a.epub');
    expect(dbx.read('/Supernote/Document/Inkwise/a.epub')).toBeUndefined();
    await expect(out.remove('a.epub')).resolves.toBeUndefined();
  });

  it('moveToSubfolder() moves with autorename', async () => {
    const dbx = new FakeDropbox();
    dbx.addFile('/Supernote/Document/Inkwise/a.epub', bytes('a'));
    dbx.addFile('/Supernote/Document/Inkwise/Archive/a.epub', bytes('older'));
    const out = new DropboxOutput(TOKEN, '/Supernote/Document', 'Inkwise', dbx.fetch);
    await out.moveToSubfolder('a.epub', 'Archive');
    const body = JSON.parse(dbx.calls[0]!.body);
    expect(body).toEqual({
      from_path: '/Supernote/Document/Inkwise/a.epub',
      to_path: '/Supernote/Document/Inkwise/Archive/a.epub',
      autorename: true,
    });
    expect(dbx.read('/Supernote/Document/Inkwise/a.epub')).toBeUndefined();
    expect(dbx.read('/Supernote/Document/Inkwise/Archive/a (1).epub')).toEqual(bytes('a'));
    expect(await out.list()).toEqual([]);
  });

  it('moveToSubfolder() throws when the file is missing', async () => {
    const dbx = new FakeDropbox();
    const out = new DropboxOutput(TOKEN, '/Supernote/Document', 'Inkwise', dbx.fetch);
    await expect(out.moveToSubfolder('nope.epub', 'Archive')).rejects.toThrow(/files\/move_v2 failed \(HTTP 409\)/);
  });

  it('list() surfaces non-409 errors', async () => {
    const dbx = new FakeDropbox();
    const out = new DropboxOutput('wrong-token', '/Supernote/Document', 'Inkwise', dbx.fetch);
    await expect(out.list()).rejects.toThrow(/list_folder failed \(HTTP 401\)/);
  });
});
