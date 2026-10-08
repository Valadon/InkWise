import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { beforeEach, describe, expect, it } from 'vitest';
import { epubFilename, type ReaderDocument } from '@inkwise/core';
import { FakeReadwise, TINY_PNG } from '@inkwise/core/testing';
import { InkwiseApp, STORAGE_ROOT, TOKEN_IMPORT_PATH, cleanToken, type Host, type Permission } from '../src/services/app';
import { base64ToBytes, bytesToBase64 } from '../src/services/base64';
import { MemoryFs } from '../src/services/fs';

const FIXTURES = join(__dirname, '..', '..', '..', 'fixtures', 'documents');
const docs: ReaderDocument[] = readdirSync(FIXTURES)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(FIXTURES, f), 'utf8')));
const longform = docs.find((d) => d.id.includes('longform'))!;
const LIBRARY = `${STORAGE_ROOT}/Document/Inkwise`;
const PRIVATE = '/data/data/com.ratta.supernote.pluginhost/files/plugins/inkw1se7rd8w9x2q';

class FakeHost implements Host {
  granted = new Set<Permission>();
  /** What the user answers in the permission dialog. */
  answer = true;
  requests: { permission: Permission; description: string }[] = [];
  selection: string | null = null;
  filePath: string | null = null;
  async pluginDir() {
    return PRIVATE;
  }
  async hasPermission(p: Permission) {
    return this.granted.has(p);
  }
  async requestPermission(p: Permission, description: string) {
    this.requests.push({ permission: p, description });
    if (this.answer) this.granted.add(p);
    return this.answer;
  }
  async selectedText() {
    return this.selection === null ? { ok: false as const, error: 'No text selected.' } : { ok: true as const, text: this.selection };
  }
  async currentFilePath() {
    return this.filePath;
  }
  reloads = 0;
  async reloadFile() {
    this.reloads++;
  }
}

let fake: FakeReadwise;
let host: FakeHost;
let fs: MemoryFs;
let app: InkwiseApp;

beforeEach(async () => {
  fake = new FakeReadwise({ token: 'device-token', documents: docs, images: { 'https://example.com/img/fog-1.png': TINY_PNG } });
  host = new FakeHost();
  fs = new MemoryFs();
  await fs.mkdir(PRIVATE);
  await fs.mkdir(`${STORAGE_ROOT}/Document`);
  await fs.mkdir(`${STORAGE_ROOT}/MyStyle/Inkwise`);
  app = new InkwiseApp(host, fs, fake.fetch);
});

async function connect() {
  const r = await app.setToken('device-token');
  expect(r.ok).toBe(true);
}

describe('token setup', () => {
  it('validates and stores the token privately', async () => {
    const r = await app.setToken('  Token device-token\n');
    expect(r).toEqual({ ok: true, message: 'Token works. You are connected to Readwise.' });
    expect(await fs.readText(`${PRIVATE}/readwise-token`)).toBe('device-token');
    expect([...fs.files.keys()].filter((k) => k.startsWith(STORAGE_ROOT))).toEqual([]);
  });

  it('rejects a bad token without storing it', async () => {
    const r = await app.setToken('wrong');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('rejected');
    expect(await app.hasToken()).toBe(false);
  });

  it('reports no connection clearly', async () => {
    fake.offline = true;
    const r = await app.setToken('device-token');
    expect(r).toEqual({ ok: false, message: 'No connection to Readwise. Check Wi-Fi and try again.' });
  });

  it('imports from MyStyle/Inkwise/token.txt and deletes the file', async () => {
    await fs.writeText(TOKEN_IMPORT_PATH, '﻿device-token\r\n');
    const r = await app.importToken();
    expect(r.ok).toBe(true);
    expect(r.message).toContain('deleted');
    expect(await fs.exists(TOKEN_IMPORT_PATH)).toBe(false);
    expect(host.granted.has('plugin.permission.FILE:READ')).toBe(true);
  });

  it('explains when there is no token file', async () => {
    const r = await app.importToken();
    expect(r).toMatchObject({ ok: false });
    expect(r.message).toContain('MyStyle/Inkwise/token.txt');
  });

  it('cleans pasted tokens', () => {
    expect(cleanToken('Token abc123 ')).toBe('abc123');
    expect(cleanToken('\n abc\nextra')).toBe('abc');
  });
});

describe('Sync Reader', () => {
  it('asks to connect first when there is no token', async () => {
    expect(await app.sync(() => {})).toBe('Connect Readwise first: open Inkwise settings and add your token.');
  });

  it('writes EPUBs into Document/Inkwise and reports one line', async () => {
    await connect();
    const lines: string[] = [];
    const summary = await app.sync((l) => lines.push(l));
    expect(summary).toBe('Synced 4 new, 0 updated.');
    const names = (await fs.listFiles(LIBRARY)).map((f) => f.name).sort();
    expect(names).toEqual(docs.map((d) => epubFilename(d)).sort());
    expect(lines).toContain('Found 4 articles.');
    // Manifest lives in private storage, not next to the EPUBs.
    expect(await fs.exists(`${PRIVATE}/manifest.json`)).toBe(true);
    expect(names.some((n) => n.endsWith('.part'))).toBe(false);
    // Asked for network and write access, with an explanation.
    expect(host.requests.map((r) => r.permission)).toEqual(['plugin.permission.INTERNET', 'plugin.permission.FILE:WRITE', 'plugin.permission.FILE:READ']);
    expect(host.requests[1]!.description).toContain('Document/Inkwise');
  });

  it('is idempotent', async () => {
    await connect();
    await app.sync(() => {});
    expect(await app.sync(() => {})).toBe('Synced 0 new, 0 updated.');
  });

  it('stops with a clear message when write permission is refused', async () => {
    await connect();
    host.granted.delete('plugin.permission.FILE:WRITE');
    host.answer = false;
    expect(await app.sync(() => {})).toContain('FILE:WRITE');
  });

  it('honours settings: location, tag, max articles, folder name, images', async () => {
    await connect();
    await app.saveSettings({ maxArticles: 2, folderName: 'Reader/../Stuff', images: false });
    const s = await app.settings();
    expect(s.folderName).toBe('Reader..Stuff');
    const summary = await app.sync(() => {});
    expect(summary).toBe('Synced 2 new, 0 updated.');
    expect((await fs.listFiles(`${STORAGE_ROOT}/Document/Reader..Stuff`)).length).toBe(2);
    expect(fake.requests.some((r) => r.url.includes('example.com/img'))).toBe(false);
    await app.saveSettings({ location: 'shortlist', tag: 'reading', maxArticles: 50 });
    await app.sync(() => {});
    const listCall = fake.requests.filter((r) => r.url.includes('/api/v3/list/')).at(-1)!;
    expect(listCall.url).toContain('location=shortlist');
    expect(listCall.url).toContain('tag=reading');
  });

  it('reports offline cleanly', async () => {
    await connect();
    fake.offline = true;
    expect(await app.sync(() => {})).toBe('No connection to Readwise. Check Wi-Fi and try again.');
  });
});

describe('Send highlight', () => {
  beforeEach(async () => {
    await connect();
    await app.sync(() => {});
    host.filePath = `${LIBRARY}/${epubFilename(longform)}`;
  });

  it('needs a selection', async () => {
    host.selection = null;
    expect((await app.sendSelection()).status).toBe('empty');
  });

  it('sends the selection to the right Reader document', async () => {
    host.selection = 'Speed is a habit, not a virtue.';
    const r = await app.sendSelection();
    expect(r).toMatchObject({ status: 'sent', message: 'Highlight sent.', docId: longform.id });
    expect(fake.highlights[0]).toMatchObject({ parent_id: longform.id, content: 'Speed is a habit, not a virtue.' });
  });

  it('adds a note after sending', async () => {
    host.selection = 'Speed is a habit, not a virtue.';
    const r = await app.sendSelection();
    const n = await app.addNote({ docId: r.docId!, text: r.selection!, note: 'so true', highlightId: r.highlightId });
    expect(n).toEqual({ ok: true, message: 'Note added.' });
    expect(fake.highlights[0]!.notes).toBe('so true');
  });

  it('queues offline, keeps a note on the queued copy, and sends on next sync', async () => {
    host.selection = 'None of this is new.';
    fake.offline = true;
    const r = await app.sendSelection();
    expect(r.message).toBe('Saved offline, will send on next sync.');
    const n = await app.addNote({ docId: r.docId!, text: r.selection!, note: 'queued note' });
    expect(n.ok).toBe(true);
    fake.offline = false;
    expect(await app.sync(() => {})).toBe('Synced 0 new, 0 updated. Sent 1 saved highlight.');
    expect(fake.highlights[0]).toMatchObject({ content: 'None of this is new.', notes: 'queued note' });
  });

  it('shades a sent highlight in the open EPUB and reloads it', async () => {
    const path = `${LIBRARY}/${epubFilename(longform)}`;
    host.filePath = path;
    host.selection = 'None of this is new.';
    const r = await app.sendSelection();
    expect(r.status).toBe('sent');
    expect(r.shading).toBe('Shaded on the page.');
    expect(host.reloads).toBe(1);
    const article = strFromU8(unzipSync(await fs.readBytes(path))['OEBPS/article.xhtml']!);
    expect(article).toContain('<span class="rw-hl">None of this is new.</span>');
    // The next sync sees the file already shows it and leaves it alone.
    expect(await app.sync(() => {})).toBe('Synced 0 new, 0 updated.');
  });

  it('leaves the file alone when shading is off', async () => {
    await app.saveSettings({ showHighlights: false });
    host.filePath = `${LIBRARY}/${epubFilename(longform)}`;
    host.selection = 'None of this is new.';
    const r = await app.sendSelection();
    expect(r.status).toBe('sent');
    expect(r.shading).toBeUndefined();
    expect(host.reloads).toBe(0);
  });

  it("refuses documents that aren't from Readwise", async () => {
    host.filePath = `${STORAGE_ROOT}/Document/Manual.pdf`;
    host.selection = 'anything';
    expect((await app.sendSelection()).message).toBe("This document isn't from Readwise.");
  });

  it('reads dc:identifier from a renamed EPUB', async () => {
    const original = `${LIBRARY}/${epubFilename(longform)}`;
    const renamed = `${STORAGE_ROOT}/Document/renamed.epub`;
    await fs.move(original, renamed);
    host.filePath = renamed;
    host.selection = 'None of this is new.';
    const r = await app.sendSelection();
    expect(r.status).toBe('sent');
    expect(fake.highlights[0]!.parent_id).toBe(longform.id);
  });

  it('lets the user fix an unmatched highlight from the queue', async () => {
    host.selection = 'Not in the article.';
    expect((await app.sendSelection()).status).toBe('needs_attention');
    const q = await app.queue();
    expect(q.pending).toHaveLength(1);
    expect(q.titles[longform.id]).toBe(longform.title);
    const fixed = await app.review({ docId: q.pending[0]!.docId, createdAt: q.pending[0]!.createdAt }, 'retry', 'None of this is new.');
    expect(fixed.status).toBe('sent');
    expect((await app.queue()).pending).toHaveLength(0);
  });

  it('flushes queued highlights on demand', async () => {
    host.selection = 'None of this is new.';
    fake.offline = true;
    await app.sendSelection();
    expect(await app.flush()).toBe('Still offline. Everything stays queued.');
    fake.offline = false;
    expect(await app.flush()).toBe('Sent 1 highlight.');
  });
});

describe('Done', () => {
  beforeEach(async () => {
    await connect();
    await app.sync(() => {});
    host.filePath = `${LIBRARY}/${epubFilename(longform)}`;
  });

  it('archives in Reader and moves the EPUB to Archive by default', async () => {
    const r = await app.done();
    expect(r).toEqual({ ok: true, message: 'Archived in Reader. Moved to Inkwise/Archive.' });
    expect(fake.documents.find((d) => d.id === longform.id)!.location).toBe('archive');
    expect(await fs.exists(`${LIBRARY}/Archive/${epubFilename(longform)}`)).toBe(true);
    expect(await fs.exists(`${LIBRARY}/${epubFilename(longform)}`)).toBe(false);
  });

  it('can keep or delete the file instead', async () => {
    await app.saveSettings({ afterArchive: 'keep' });
    expect((await app.done()).message).toBe('Archived in Reader.');
    expect(await fs.exists(`${LIBRARY}/${epubFilename(longform)}`)).toBe(true);

    const other = docs.find((d) => d.id.includes('messy'))!;
    host.filePath = `${LIBRARY}/${epubFilename(other)}`;
    await app.saveSettings({ afterArchive: 'delete' });
    expect((await app.done()).message).toBe('Archived in Reader. Removed from the device.');
    expect(await fs.exists(host.filePath)).toBe(false);
    expect(host.granted.has('plugin.permission.FILE:DELETE')).toBe(true);
  });

  it('queues the archive offline', async () => {
    fake.offline = true;
    const r = await app.done();
    expect(r).toEqual({ ok: true, message: 'Saved offline, will archive on next sync.' });
    expect(await fs.exists(`${LIBRARY}/${epubFilename(longform)}`)).toBe(true);
    expect((await app.queue()).archives).toBe(1);
  });

  it("does nothing for documents that aren't from Readwise", async () => {
    host.filePath = `${STORAGE_ROOT}/Document/book.epub`;
    expect(await app.done()).toEqual({ ok: false, message: "This document isn't from Readwise." });
  });
});

describe('settings', () => {
  it('falls back to defaults on corrupt JSON and clamps numbers', async () => {
    await fs.writeText(`${PRIVATE}/settings.json`, '{not json');
    expect((await app.settings()).maxArticles).toBe(30);
    expect((await app.saveSettings({ maxArticles: 9999 })).maxArticles).toBe(200);
    expect((await app.saveSettings({ maxArticles: Number('abc') })).maxArticles).toBe(30);
  });
});

describe('base64', () => {
  it('round-trips arbitrary bytes and matches Buffer', () => {
    for (const len of [0, 1, 2, 3, 4, 5, 1000, 70001]) {
      const bytes = new Uint8Array(len).map((_, i) => (i * 37 + 11) & 0xff);
      const b64 = bytesToBase64(bytes);
      expect(b64).toBe(Buffer.from(bytes).toString('base64'));
      expect(base64ToBytes(b64)).toEqual(bytes);
    }
  });

  it('writes a valid EPUB through base64 like the device does', async () => {
    await connect();
    await app.sync(() => {});
    const name = epubFilename(longform);
    const bytes = await fs.readBytes(`${LIBRARY}/${name}`);
    const roundTripped = base64ToBytes(bytesToBase64(bytes));
    const files = unzipSync(roundTripped);
    expect(strFromU8(files['OEBPS/content.opf']!)).toContain(`urn:readwise:${longform.id}`);
  });
});
