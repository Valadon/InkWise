import {
  ReadwiseClient,
  addNoteToHighlight,
  archiveDocument,
  describeSyncError,
  epubIdentifier,
  flushPending,
  resolveDocId,
  resolveNeedsAttention,
  sendHighlight,
  syncReader,
  textManifestStore,
  updateManifest,
  highlightsKey,
  markEpub,
  type FetchLike,
  type ManifestStore,
  type OutputAdapter,
  type PendingHighlight,
  type ReviewAction,
  type SendResult,
} from '@inkwise/core';
import { dirOf, joinPath, type DeviceFs } from './fs';

/** What the plugin needs from the Supernote host (wrapped around sn-plugin-lib in host.ts). */
export interface Host {
  pluginDir(): Promise<string>;
  hasPermission(permission: Permission): Promise<boolean>;
  requestPermission(permission: Permission, description: string): Promise<boolean>;
  /** The DOC app's current selection. */
  selectedText(): Promise<{ ok: true; text: string } | { ok: false; error: string }>;
  currentFilePath(): Promise<string | null>;
  /** Ask the DOC app to re-read the open file after Inkwise changed it. */
  reloadFile(): Promise<void>;
}

export type Permission =
  | 'plugin.permission.INTERNET'
  | 'plugin.permission.FILE:READ'
  | 'plugin.permission.FILE:WRITE'
  | 'plugin.permission.FILE:DELETE';

const PERMISSION_REASONS: Record<Permission, string> = {
  'plugin.permission.INTERNET': 'Inkwise talks to Readwise to fetch your articles and send highlights. Choose "Always allow" so you are not asked every time.',
  'plugin.permission.FILE:READ': 'Inkwise reads its own EPUBs in Document/Inkwise to match highlights to articles, and can import your token from MyStyle/Inkwise/token.txt.',
  'plugin.permission.FILE:WRITE': 'Inkwise saves articles as EPUBs in Document/Inkwise so the built-in reader can open them.',
  'plugin.permission.FILE:DELETE': 'Inkwise removes articles you archived (only if you turn that on) and deletes the token file after importing it.',
};

export type AfterArchive = 'keep' | 'move' | 'delete';

export interface Settings {
  location: 'later' | 'shortlist' | 'new';
  /** Optional Reader tag filter. */
  tag: string;
  maxArticles: number;
  images: boolean;
  folderName: string;
  afterArchive: AfterArchive;
  /** Tidy up EPUBs whose documents left the queue on each sync. */
  removeMissing: boolean;
  /** Shade sent highlights (and ones made in Reader) in the EPUBs. */
  showHighlights: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  location: 'later',
  tag: '',
  maxArticles: 30,
  images: true,
  folderName: 'Inkwise',
  afterArchive: 'move',
  removeMissing: false,
  showHighlights: true,
};

export const STORAGE_ROOT = '/storage/emulated/0';
export const TOKEN_IMPORT_PATH = `${STORAGE_ROOT}/MyStyle/Inkwise/token.txt`;

export class PermissionError extends Error {}

/**
 * Everything the three buttons and the settings page do, independent of React.
 */
export class InkwiseApp {
  private dir: string | null = null;

  constructor(
    readonly host: Host,
    readonly fs: DeviceFs,
    readonly fetch: FetchLike,
    /** Fetch used for images (on the device it downloads through the file system). */
    readonly imageFetch?: FetchLike,
  ) {}

  // ---- paths & storage -------------------------------------------------

  async privateDir(): Promise<string> {
    if (!this.dir) this.dir = await this.host.pluginDir();
    return this.dir;
  }

  async libraryDir(): Promise<string> {
    const s = await this.settings();
    return joinPath(STORAGE_ROOT, 'Document', sanitizeFolder(s.folderName));
  }

  async manifest(): Promise<ManifestStore> {
    const path = joinPath(await this.privateDir(), 'manifest.json');
    const fs = this.fs;
    return textManifestStore({
      async read() {
        const main = (await fs.exists(path)) ? await fs.readText(path) : null;
        if (main === null || parses(main)) return main;
        // Corrupt manifest: keep a copy for diagnosis, then fall back to the last
        // complete write if one is lying around.
        await fs.writeText(`${path}.corrupt`, main).catch(() => {});
        const tmp = (await fs.exists(`${path}.tmp`)) ? await fs.readText(`${path}.tmp`) : null;
        return tmp !== null && parses(tmp) ? tmp : main;
      },
      async write(text) {
        // Write then rename, so a crash mid-write can't corrupt the queue.
        await fs.writeText(`${path}.tmp`, text);
        await fs.move(`${path}.tmp`, path);
      },
    });
  }

  async settings(): Promise<Settings> {
    const path = joinPath(await this.privateDir(), 'settings.json');
    try {
      if (await this.fs.exists(path)) return { ...DEFAULT_SETTINGS, ...JSON.parse(await this.fs.readText(path)) };
    } catch {
      // Corrupt settings fall back to defaults.
    }
    return { ...DEFAULT_SETTINGS };
  }

  async saveSettings(patch: Partial<Settings>): Promise<Settings> {
    const next = { ...(await this.settings()), ...patch };
    next.maxArticles = Math.max(1, Math.min(200, Math.round(Number(next.maxArticles) || DEFAULT_SETTINGS.maxArticles)));
    next.folderName = sanitizeFolder(next.folderName);
    next.tag = next.tag.trim();
    await this.fs.writeText(joinPath(await this.privateDir(), 'settings.json'), JSON.stringify(next, null, 2));
    return next;
  }

  // ---- token ---------------------------------------------------------------

  private async tokenPath() {
    return joinPath(await this.privateDir(), 'readwise-token');
  }

  async hasToken(): Promise<boolean> {
    return !!(await this.token());
  }

  async token(): Promise<string | null> {
    const p = await this.tokenPath();
    if (!(await this.fs.exists(p))) return null;
    const t = (await this.fs.readText(p)).trim();
    return t || null;
  }

  /** Validate, then store the token in the private plugin folder. */
  async setToken(raw: string): Promise<{ ok: boolean; message: string }> {
    const token = cleanToken(raw);
    if (!token) return { ok: false, message: 'Paste your Readwise access token first.' };
    await this.ensure('plugin.permission.INTERNET');
    const client = new ReadwiseClient({ token, fetch: this.fetch });
    let valid: boolean;
    try {
      valid = await client.validateToken();
    } catch (err) {
      return { ok: false, message: describeSyncError(err) };
    }
    if (!valid) return { ok: false, message: 'Readwise rejected that token. Copy it again from readwise.io/access_token.' };
    await this.fs.writeText(await this.tokenPath(), token);
    return { ok: true, message: 'Token works. You are connected to Readwise.' };
  }

  /** Import from MyStyle/Inkwise/token.txt, then delete that file. */
  async importToken(): Promise<{ ok: boolean; message: string }> {
    await this.ensure('plugin.permission.FILE:READ');
    if (!(await this.fs.exists(TOKEN_IMPORT_PATH))) {
      return { ok: false, message: 'No token file found. Put your token in MyStyle/Inkwise/token.txt and try again.' };
    }
    const result = await this.setToken(await this.fs.readText(TOKEN_IMPORT_PATH));
    if (result.ok) {
      try {
        await this.ensure('plugin.permission.FILE:DELETE');
        await this.fs.unlink(TOKEN_IMPORT_PATH);
        return { ok: true, message: `${result.message} The token file was deleted.` };
      } catch {
        return { ok: true, message: `${result.message} Please delete MyStyle/Inkwise/token.txt yourself.` };
      }
    }
    return result;
  }

  async clearToken(): Promise<void> {
    const p = await this.tokenPath();
    if (await this.fs.exists(p)) await this.fs.unlink(p);
  }

  private async client(): Promise<ReadwiseClient> {
    const token = await this.token();
    if (!token) throw new PermissionError('Connect Readwise first: open Inkwise settings and add your token.');
    return new ReadwiseClient({ token, fetch: this.fetch });
  }

  // ---- permissions -----------------------------------------------------

  async ensure(permission: Permission): Promise<void> {
    if (await this.host.hasPermission(permission)) return;
    if (await this.host.requestPermission(permission, PERMISSION_REASONS[permission])) return;
    const what = permission.split('.').pop();
    throw new PermissionError(`Inkwise needs the ${what} permission for this. You can allow it next time you try.`);
  }

  // ---- actions -----------------------------------------------------------

  /** Sync Reader button. Returns the one-line result. */
  async sync(onProgress: (line: string) => void): Promise<string> {
    try {
      await this.ensure('plugin.permission.INTERNET');
      await this.ensure('plugin.permission.FILE:WRITE');
      // Listing Document/Inkwise is how sync spots files the CLI already wrote.
      await this.ensure('plugin.permission.FILE:READ');
      const settings = await this.settings();
      if (settings.removeMissing) await this.ensure('plugin.permission.FILE:DELETE');
      const client = await this.client();
      const libraryDir = await this.libraryDir();
      await this.fs.mkdir(libraryDir);
      const result = await syncReader(
        {
          client,
          output: this.output(libraryDir),
          manifest: await this.manifest(),
          fetchImages: settings.images ? this.imageFetch ?? this.fetch : undefined,
          onProgress,
        },
        {
          location: settings.location,
          tags: settings.tag ? [settings.tag] : undefined,
          limit: settings.maxArticles,
          includeImages: settings.images,
          // Device images skip processing, so keep each EPUB small.
          imageBudgetBytes: 4 * 1024 * 1024,
          removeMissing: settings.removeMissing,
          removeMode: 'archive-folder',
          showHighlights: settings.showHighlights,
        },
      );
      return result.summary;
    } catch (err) {
      return describeSyncError(err);
    }
  }

  /** Send highlight button: reads the selection and current file from the DOC app. */
  async sendSelection(): Promise<SendResult & { selection?: string; shading?: string }> {
    const sel = await this.host.selectedText();
    if (!sel.ok || !sel.text.trim()) {
      return { status: 'empty', message: 'Select some text first, then tap Send highlight.' };
    }
    const filePath = await this.host.currentFilePath();
    if (!filePath) return { status: 'not_inkwise', message: "This document isn't from Readwise.", selection: sel.text };
    try {
      await this.ensure('plugin.permission.INTERNET');
    } catch {
      // No network permission: sendHighlight will queue it offline.
    }
    let client: ReadwiseClient;
    try {
      client = await this.client();
    } catch (err) {
      return { status: 'token_rejected', message: (err as Error).message, selection: sel.text };
    }
    const result = await sendHighlight({
      client,
      manifest: await this.manifest(),
      filePath,
      text: sel.text,
      readIdentifier: (p) => this.readIdentifier(p),
    });
    let shading: string | undefined;
    if (result.docId && (result.status === 'sent' || result.status === 'queued_offline' || result.status === 'duplicate')) {
      shading = await this.shadeOpenFile(filePath, result.docId);
    }
    return { ...result, selection: sel.text, shading };
  }

  /**
   * Rewrite the open EPUB so its highlights show, then have the DOC app reload
   * it. The SDK can't draw a highlight on a DOC page, so this is the way to make
   * a sent highlight visible. Returns a line for the screen, or undefined when
   * shading is off or doesn't apply.
   */
  async shadeOpenFile(filePath: string, docId: string): Promise<string | undefined> {
    if (!/\.epub$/i.test(filePath) || !(await this.settings()).showHighlights) return undefined;
    try {
      const store = await this.manifest();
      const texts = (await store.load()).docHighlights[docId] ?? [];
      if (!texts.length) return undefined;
      await this.ensure('plugin.permission.FILE:WRITE');
      const r = markEpub(await this.fs.readBytes(filePath), texts);
      if (!r) return "Couldn't shade it on the page: the file isn't a readable EPUB.";
      const name = filePath.split('/').pop()!;
      const tmp = joinPath(dirOf(filePath), `.${name}.part`);
      await this.fs.writeBytes(tmp, r.bytes);
      await this.fs.move(tmp, filePath);
      await updateManifest(store, (m) => {
        const d = m.documents[docId];
        if (d && d.filename === name) d.marked = highlightsKey(texts);
      });
      await this.host.reloadFile();
      return r.marked ? 'Shaded on the page.' : "Couldn't find the passage on the page to shade it.";
    } catch (err) {
      return `Couldn't shade it on the page: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  async addNote(args: { docId: string; text: string; note: string; highlightId?: string }) {
    return addNoteToHighlight({ client: await this.client(), manifest: await this.manifest(), ...args });
  }

  /** Done button: flush highlights, archive in Reader, then tidy the local file. */
  async done(): Promise<{ ok: boolean; message: string }> {
    const filePath = await this.host.currentFilePath();
    if (!filePath) return { ok: false, message: "This document isn't from Readwise." };
    const manifest = await this.manifest();
    const docId = await resolveDocId(await manifest.load(), filePath, (p) => this.readIdentifier(p));
    if (!docId) return { ok: false, message: "This document isn't from Readwise." };
    try {
      await this.ensure('plugin.permission.INTERNET');
    } catch {
      // Offline path below queues the archive.
    }
    let client: ReadwiseClient;
    try {
      client = await this.client();
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
    const r = await archiveDocument({ client, manifest, filePath, readIdentifier: (p) => this.readIdentifier(p) });
    if (r.status !== 'archived') return { ok: r.status === 'queued_offline', message: r.message };
    const tidy = await this.afterArchive(filePath);
    return { ok: true, message: tidy ? `${r.message} ${tidy}` : r.message };
  }

  private async afterArchive(filePath: string): Promise<string> {
    const { afterArchive } = await this.settings();
    const library = await this.libraryDir();
    // Only touch files Inkwise itself manages.
    if (afterArchive === 'keep' || !filePath.startsWith(`${library}/`)) return '';
    const name = filePath.slice(library.length + 1);
    try {
      if (afterArchive === 'move') {
        await this.ensure('plugin.permission.FILE:WRITE');
        await this.fs.mkdir(joinPath(library, 'Archive'));
        await this.fs.move(filePath, joinPath(library, 'Archive', name));
        return 'Moved to Inkwise/Archive.';
      }
      await this.ensure('plugin.permission.FILE:DELETE');
      await this.fs.unlink(filePath);
      return 'Removed from the device.';
    } catch {
      return 'The file stayed where it was.';
    }
  }

  /** Highlights waiting to send or needing review (for the settings page). */
  async queue(): Promise<{ pending: PendingHighlight[]; archives: number; titles: Record<string, string> }> {
    const m = await (await this.manifest()).load();
    const titles: Record<string, string> = {};
    for (const [id, d] of Object.entries(m.documents)) titles[id] = d.title;
    return { pending: m.pendingHighlights, archives: m.pendingArchives?.length ?? 0, titles };
  }

  /** `key` is the highlight's docId and createdAt, which stay put when the queue changes. */
  async review(key: { docId: string; createdAt: string }, action: ReviewAction, text?: string) {
    return resolveNeedsAttention({ client: await this.client(), manifest: await this.manifest(), key, action, text });
  }

  /** Send everything queued without a full sync. */
  async flush(): Promise<string> {
    try {
      const client = await this.client();
      const r = await updateManifest(await this.manifest(), (m) => flushPending({ client, manifest: m }));
      if (!r.sent && !r.archived && r.stillPending) return 'Still offline. Everything stays queued.';
      return `Sent ${r.sent} ${r.sent === 1 ? 'highlight' : 'highlights'}${r.archived ? `, archived ${r.archived}` : ''}.`;
    } catch (err) {
      return describeSyncError(err);
    }
  }

  // ---- device plumbing ---------------------------------------------------

  private async readIdentifier(path: string): Promise<string | null> {
    try {
      await this.ensure('plugin.permission.FILE:READ');
      return epubIdentifier(await this.fs.readBytes(path));
    } catch {
      return null;
    }
  }

  output(dir: string): OutputAdapter {
    const fs = this.fs;
    return {
      name: 'device',
      async list() {
        return (await fs.exists(dir)) ? fs.listFiles(dir) : [];
      },
      async put(filename, bytes) {
        // Write to a hidden temp name first so the DOC app never sees half a file.
        const tmp = joinPath(dir, `.${filename}.part`);
        await fs.writeBytes(tmp, bytes);
        await fs.move(tmp, joinPath(dir, filename));
      },
      async remove(filename) {
        await fs.unlink(joinPath(dir, filename));
      },
      async moveToSubfolder(filename, subfolder) {
        await fs.mkdir(joinPath(dir, subfolder));
        await fs.move(joinPath(dir, filename), joinPath(dir, subfolder, filename));
      },
    };
  }
}

function parses(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Accept a bare token, "Token xyz", or a file with surrounding whitespace/newlines. */
export function cleanToken(raw: string): string {
  return raw
    .replace(/^﻿/, '')
    .trim()
    .replace(/^Token\s+/i, '')
    .split(/\s+/)[0] ?? '';
}

export function sanitizeFolder(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, '').trim();
  return cleaned || DEFAULT_SETTINGS.folderName;
}
