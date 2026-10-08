import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyManifest } from '@inkwise/core';
import { FolderOutput } from '../src/adapters/folder.js';
import { fileManifestStore, manifestPath } from '../src/state.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'inkwise-folder-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const bytes = (s: string) => new TextEncoder().encode(s);

describe('FolderOutput', () => {
  it('list() returns [] for a folder that does not exist', async () => {
    expect(await new FolderOutput(join(dir, 'missing')).list()).toEqual([]);
  });

  it('put() creates the folder, writes the bytes and leaves no .part file', async () => {
    const out = new FolderOutput(join(dir, 'a', 'b'));
    await out.put('One.epub', bytes('hello'));
    expect(await readFile(join(dir, 'a', 'b', 'One.epub'), 'utf8')).toBe('hello');
    expect(await readdir(join(dir, 'a', 'b'))).toEqual(['One.epub']);
    expect(await out.list()).toEqual([{ name: 'One.epub', size: 5 }]);
  });

  it('put() overwrites an existing file', async () => {
    const out = new FolderOutput(dir);
    await out.put('One.epub', bytes('v1'));
    await out.put('One.epub', bytes('version 2'));
    expect(await out.list()).toEqual([{ name: 'One.epub', size: 9 }]);
  });

  it('list() skips subfolders', async () => {
    const out = new FolderOutput(dir);
    await out.put('One.epub', bytes('1'));
    await mkdir(join(dir, 'Archive'));
    await writeFile(join(dir, 'Archive', 'old.epub'), 'x');
    expect(await out.list()).toEqual([{ name: 'One.epub', size: 1 }]);
  });

  it('remove() deletes and ignores missing files', async () => {
    const out = new FolderOutput(dir);
    await out.put('One.epub', bytes('1'));
    await out.remove('One.epub');
    await out.remove('One.epub');
    expect(await out.list()).toEqual([]);
  });

  it('moveToSubfolder() creates the subfolder and moves the file', async () => {
    const out = new FolderOutput(dir);
    await out.put('One.epub', bytes('1'));
    await out.moveToSubfolder('One.epub', 'Archive');
    expect(await out.list()).toEqual([]);
    expect(await readFile(join(dir, 'Archive', 'One.epub'), 'utf8')).toBe('1');
  });

  it('takes a custom adapter name', () => {
    expect(new FolderOutput(dir).name).toBe('folder');
    expect(new FolderOutput(dir, 'dropbox').name).toBe('dropbox');
  });
});

describe('fileManifestStore', () => {
  it('manifestPath is per target', () => {
    expect(manifestPath('/state', 'dropbox')).toBe(join('/state', 'manifest.dropbox.json'));
  });

  it('loads an empty manifest when the file is missing', async () => {
    const store = fileManifestStore(join(dir, 'nope', 'manifest.json'));
    expect(await store.load()).toEqual(emptyManifest());
  });

  it('round-trips a manifest, creating parent folders, with no temp file left', async () => {
    const p = join(dir, 'state', 'nested', 'manifest.folder.json');
    const store = fileManifestStore(p);
    const m = emptyManifest();
    m.lastSyncAt = '2026-10-08T12:00:00.000Z';
    m.documents['01abc'] = {
      title: 'A “quoted” title — with unicode',
      filename: 'A-quoted-title__01abc.epub',
      updatedAt: '2026-10-01T00:00:00.000Z',
      status: 'synced',
      author: null,
    };
    m.pendingHighlights.push({ docId: '01abc', text: 'some text', note: '', createdAt: '2026-10-08T12:00:00.000Z', attempts: 1, state: 'pending' });
    m.sentHighlightHashes.push('deadbeef');
    await store.save(m);
    expect(await fileManifestStore(p).load()).toEqual(m);
    expect(await readdir(join(dir, 'state', 'nested'))).toEqual(['manifest.folder.json']);

    m.documents['01abc']!.status = 'archived';
    await store.save(m);
    expect((await store.load()).documents['01abc']!.status).toBe('archived');
  });
});
