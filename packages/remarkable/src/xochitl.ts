import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { OutputAdapter, RemoteFile } from '@inkwise/core';
import { assembleHighlights, type AssembledHighlight, type PagePiece } from './assemble.js';
import { epubText, epubTitle } from './epubText.js';
import { readRmHighlights, RmFormatError } from './rmHighlights.js';

/**
 * The reMarkable library on disk. xochitl (the reading app) keeps every
 * document and folder flat in one directory, keyed by UUID:
 *
 *   <uuid>.metadata   JSON: name, parent folder, type, timestamps
 *   <uuid>.content    JSON: file type and page list
 *   <uuid>.epub       the book itself
 *   <uuid>/           one .rm file per annotated page
 *
 * xochitl reads this directory when it starts, so new documents show up after
 * it restarts (see `XochitlOutput.changed`).
 */
export const XOCHITL_DIR = '/home/root/.local/share/remarkable/xochitl';

export interface XochitlMetadata {
  visibleName: string;
  type: 'DocumentType' | 'CollectionType';
  /** Folder UUID, '' for the top level, 'trash' once deleted on the tablet. */
  parent: string;
  deleted?: boolean;
  [key: string]: unknown;
}

/** Metadata for a new item, with the same fields a Paper Pro on 3.28 writes. */
export function newMetadata(name: string, type: XochitlMetadata['type'], parent: string, now: Date): XochitlMetadata {
  const ms = String(now.getTime());
  return {
    createdTime: ms,
    deleted: false,
    lastModified: ms,
    lastOpened: '0',
    lastOpenedPage: 0,
    metadatamodified: false,
    modified: false,
    new: false,
    parent,
    pinned: false,
    source: '',
    synced: false,
    type,
    version: 0,
    visibleName: name,
  };
}

/**
 * `.content` for a new EPUB: the settings a Paper Pro writes, minus the page
 * list and layout details, which xochitl fills in when it first lays the book out.
 */
export function newEpubContent(): Record<string, unknown> {
  return {
    coverPageNumber: -1,
    documentMetadata: {},
    dummyDocument: false,
    extraMetadata: {},
    fileType: 'epub',
    fontName: '',
    formatVersion: 1,
    lineHeight: -1,
    orientation: 'portrait',
    pageCount: 0,
    pageTags: [],
    pages: [],
    tags: [],
    textAlignment: 'justify',
    textScale: 1,
    zoomMode: 'bestFit',
  };
}

/** Page UUIDs in reading order, from a `.content` file (3.x `cPages`, or the older `pages` list). */
export function pageOrder(content: unknown): string[] {
  const c = content as { cPages?: { pages?: { id?: string; idx?: { value?: string }; deleted?: unknown }[] }; pages?: unknown };
  const pages = c?.cPages?.pages;
  if (Array.isArray(pages)) {
    return pages
      .filter((p) => p?.id && !p.deleted)
      .map((p, i) => ({ id: p.id!, key: p.idx?.value ?? '', i }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.i - b.i))
      .map((p) => p.id);
  }
  return Array.isArray(c?.pages) ? c.pages.filter((p): p is string => typeof p === 'string') : [];
}

/** Highlights of one document, given its files. Pages missing from the page list sort last. */
export function documentHighlights(content: unknown, pages: { name: string; bytes: Uint8Array }[], epub: Uint8Array): AssembledHighlight[] {
  const order = pageOrder(content);
  const pieces: PagePiece[] = [];
  for (const page of pages) {
    const id = page.name.replace(/\.rm$/, '');
    const at = order.indexOf(id);
    let hs;
    try {
      hs = readRmHighlights(page.bytes);
    } catch (e) {
      if (e instanceof RmFormatError) continue;
      throw e;
    }
    for (const highlight of hs) pieces.push({ pageIndex: at === -1 ? order.length : at, highlight });
  }
  return pieces.length ? assembleHighlights(pieces, epubText(epub)) : [];
}

interface State {
  folderId?: string;
  archiveId?: string;
  /** Inkwise filename -> xochitl document UUID. */
  docs: Record<string, string>;
}

export interface XochitlOutputOptions {
  /** The xochitl directory. Default: the tablet's. */
  dir?: string;
  /** Where to keep the filename-to-UUID map (outside xochitl's directory). */
  stateFile: string;
  folderName?: string;
  now?: () => Date;
}

/**
 * Core's output adapter for the reMarkable: presents an "Inkwise" folder in the
 * library as if it were a plain folder of `<title>__<id>.epub` files.
 */
export class XochitlOutput implements OutputAdapter {
  readonly name = 'device' as const;
  /** True once something was written; xochitl needs a restart to show it. */
  changed = false;
  /** Filenames core asked to rewrite but that were left alone because they're marked up. */
  readonly kept = new Set<string>();
  private readonly dir: string;
  private readonly folderName: string;
  private readonly now: () => Date;
  private state: State | null = null;

  constructor(private readonly opts: XochitlOutputOptions) {
    this.dir = opts.dir ?? XOCHITL_DIR;
    this.folderName = opts.folderName ?? 'Inkwise';
    this.now = opts.now ?? (() => new Date());
  }

  /** Document UUID for an Inkwise filename, if it's still in the library. */
  async uuidFor(filename: string): Promise<string | null> {
    const id = (await this.load()).docs[filename];
    return id && (await this.isLive(id)) ? id : null;
  }

  /** Every Inkwise document still in the library, by filename. */
  async documents(): Promise<{ filename: string; uuid: string }[]> {
    const out = [];
    for (const [filename, uuid] of Object.entries((await this.load()).docs)) {
      if (await this.isLive(uuid)) out.push({ filename, uuid });
    }
    return out;
  }

  /** Assembled highlights for one of our documents. */
  async highlights(uuid: string): Promise<AssembledHighlight[]> {
    const content = await this.readJson(`${uuid}.content`);
    const epub = await readFile(join(this.dir, `${uuid}.epub`));
    const pages = [];
    for (const name of await this.listDir(join(this.dir, uuid))) {
      if (name.endsWith('.rm')) pages.push({ name, bytes: new Uint8Array(await readFile(join(this.dir, uuid, name))) });
    }
    return documentHighlights(content, pages, new Uint8Array(epub));
  }

  async list(): Promise<RemoteFile[]> {
    const files: RemoteFile[] = [];
    for (const { filename, uuid } of await this.documents()) {
      const parent = (await this.readJson(`${uuid}.metadata`))?.parent;
      if (parent && parent === (await this.load()).archiveId) continue;
      const size = (await stat(join(this.dir, `${uuid}.epub`)).catch(() => null))?.size;
      files.push({ name: filename, size });
    }
    return files;
  }

  async put(filename: string, bytes: Uint8Array): Promise<void> {
    const state = await this.load();
    const folder = await this.folder();
    const existing = state.docs[filename];
    if (existing && (await this.isLive(existing))) {
      // Replacing the book under existing annotations would leave them on the wrong
      // words, so a document the reader has marked up keeps its original EPUB.
      if ((await this.listDir(join(this.dir, existing))).some((n) => n.endsWith('.rm'))) {
        this.kept.add(filename);
        return;
      }
      await this.writeAtomic(`${existing}.epub`, bytes);
      await this.touch(existing);
      this.changed = true;
      return;
    }
    const id = randomUUID();
    const name = epubTitle(bytes) ?? filename.replace(/__[0-9a-z]+\.epub$/, '').replace(/-/g, ' ');
    await this.writeAtomic(`${id}.epub`, bytes);
    await this.writeAtomic(`${id}.content`, JSON.stringify(newEpubContent(), null, 4));
    // Metadata last: it's what makes xochitl treat the files as a document.
    await this.writeAtomic(`${id}.metadata`, JSON.stringify(newMetadata(name, 'DocumentType', folder, this.now()), null, 4));
    state.docs[filename] = id;
    await this.save();
    this.changed = true;
  }

  /** Sends the document to the tablet's trash rather than deleting it outright. */
  async remove(filename: string): Promise<void> {
    const state = await this.load();
    const id = state.docs[filename];
    if (!id) return;
    if (await this.isLive(id)) await this.updateMetadata(id, { parent: 'trash' });
    delete state.docs[filename];
    await this.save();
    this.changed = true;
  }

  async moveToSubfolder(filename: string, subfolder: string): Promise<void> {
    const id = await this.uuidFor(filename);
    if (!id) return;
    const state = await this.load();
    if (!state.archiveId || !(await this.isLive(state.archiveId))) {
      state.archiveId = await this.createFolder(subfolder, await this.folder());
      await this.save();
    }
    await this.updateMetadata(id, { parent: state.archiveId });
    this.changed = true;
  }

  // --- internals ---

  private async folder(): Promise<string> {
    const state = await this.load();
    if (state.folderId && (await this.isLive(state.folderId))) return state.folderId;
    // Reuse a top-level folder with our name (e.g. after a reinstall lost the state file).
    for (const name of await this.listDir(this.dir)) {
      if (!name.endsWith('.metadata')) continue;
      const m = await this.readJson(name);
      if (m?.type === 'CollectionType' && m.visibleName === this.folderName && m.parent === '' && !m.deleted) {
        state.folderId = name.slice(0, -'.metadata'.length);
        await this.save();
        return state.folderId;
      }
    }
    state.folderId = await this.createFolder(this.folderName, '');
    await this.save();
    return state.folderId;
  }

  private async createFolder(name: string, parent: string): Promise<string> {
    const id = randomUUID();
    await this.writeAtomic(`${id}.content`, '{}');
    await this.writeAtomic(`${id}.metadata`, JSON.stringify(newMetadata(name, 'CollectionType', parent, this.now()), null, 4));
    this.changed = true;
    return id;
  }

  private async isLive(id: string): Promise<boolean> {
    const m = await this.readJson(`${id}.metadata`);
    return !!m && !m.deleted && m.parent !== 'trash';
  }

  private async touch(id: string) {
    await this.updateMetadata(id, { lastModified: String(this.now().getTime()) });
  }

  /** Read-modify-write so fields xochitl added survive. */
  private async updateMetadata(id: string, patch: Partial<XochitlMetadata>) {
    const m = await this.readJson(`${id}.metadata`);
    if (!m) return;
    await this.writeAtomic(`${id}.metadata`, JSON.stringify({ ...m, ...patch, lastModified: String(this.now().getTime()) }, null, 4));
  }

  private async readJson(name: string): Promise<XochitlMetadata | null> {
    try {
      return JSON.parse(await readFile(join(this.dir, name), 'utf8'));
    } catch {
      return null;
    }
  }

  private async listDir(path: string): Promise<string[]> {
    try {
      return await readdir(path);
    } catch {
      return [];
    }
  }

  private async writeAtomic(name: string, data: Uint8Array | string) {
    await mkdir(this.dir, { recursive: true });
    const tmp = join(this.dir, `.${name}.part`);
    await writeFile(tmp, data);
    await rename(tmp, join(this.dir, name));
  }

  private async load(): Promise<State> {
    if (this.state) return this.state;
    try {
      const s = JSON.parse(await readFile(this.opts.stateFile, 'utf8'));
      this.state = { folderId: s.folderId, archiveId: s.archiveId, docs: s.docs ?? {} };
    } catch {
      this.state = { docs: {} };
    }
    return this.state;
  }

  private async save() {
    await mkdir(dirname(this.opts.stateFile), { recursive: true });
    const tmp = `${this.opts.stateFile}.part`;
    await writeFile(tmp, JSON.stringify(this.state, null, 2));
    await rename(tmp, this.opts.stateFile);
  }
}
