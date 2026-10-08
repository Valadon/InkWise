/**
 * Local state: which Reader documents are on the device, plus queued highlights
 * and archive requests that haven't reached Readwise yet. The Readwise token is
 * never stored here.
 */

export type DocStatus = 'synced' | 'archived' | 'removed';

export interface ManifestDocument {
  title: string;
  filename: string;
  updatedAt: string;
  status: DocStatus;
  /** Reader's own URL for the document (handy for "open in Reader" links). */
  url?: string;
  author?: string | null;
  sourceUrl?: string | null;
  syncedAt?: string;
}

export type PendingState = 'pending' | 'needs_attention';

export interface PendingHighlight {
  docId: string;
  text: string;
  note: string;
  createdAt: string;
  attempts: number;
  state: PendingState;
  lastError?: string;
}

export interface PendingArchive {
  docId: string;
  createdAt: string;
  attempts: number;
  lastError?: string;
}

export interface Manifest {
  version: 1;
  lastSyncAt: string | null;
  documents: Record<string, ManifestDocument>;
  pendingHighlights: PendingHighlight[];
  sentHighlightHashes: string[];
  pendingArchives?: PendingArchive[];
}

export interface ManifestStore {
  load(): Promise<Manifest>;
  save(manifest: Manifest): Promise<void>;
}

export function emptyManifest(): Manifest {
  return {
    version: 1,
    lastSyncAt: null,
    documents: {},
    pendingHighlights: [],
    sentHighlightHashes: [],
    pendingArchives: [],
  };
}

/** Parse a stored manifest, tolerating missing fields and garbage (a corrupt file must not block sync). */
export function parseManifest(json: string | null | undefined): Manifest {
  if (!json) return emptyManifest();
  let raw: any;
  try {
    raw = JSON.parse(json);
  } catch {
    return emptyManifest();
  }
  if (!raw || typeof raw !== 'object') return emptyManifest();
  const m = emptyManifest();
  m.lastSyncAt = typeof raw.lastSyncAt === 'string' ? raw.lastSyncAt : null;
  if (raw.documents && typeof raw.documents === 'object') {
    for (const [id, d] of Object.entries<any>(raw.documents)) {
      if (d && typeof d.filename === 'string') {
        m.documents[id] = {
          title: String(d.title ?? ''),
          filename: d.filename,
          updatedAt: String(d.updatedAt ?? ''),
          status: d.status === 'archived' || d.status === 'removed' ? d.status : 'synced',
          url: d.url,
          author: d.author,
          sourceUrl: d.sourceUrl,
          syncedAt: d.syncedAt,
        };
      }
    }
  }
  if (Array.isArray(raw.pendingHighlights)) {
    m.pendingHighlights = raw.pendingHighlights
      .filter((h: any) => h && typeof h.docId === 'string' && typeof h.text === 'string')
      .map((h: any) => ({
        docId: h.docId,
        text: h.text,
        note: typeof h.note === 'string' ? h.note : '',
        createdAt: String(h.createdAt ?? new Date(0).toISOString()),
        attempts: Number(h.attempts) || 0,
        state: h.state === 'needs_attention' ? 'needs_attention' : 'pending',
        lastError: h.lastError,
      }));
  }
  if (Array.isArray(raw.sentHighlightHashes)) {
    m.sentHighlightHashes = raw.sentHighlightHashes.filter((x: unknown) => typeof x === 'string');
  }
  if (Array.isArray(raw.pendingArchives)) {
    m.pendingArchives = raw.pendingArchives
      .filter((a: any) => a && typeof a.docId === 'string')
      .map((a: any) => ({
        docId: a.docId,
        createdAt: String(a.createdAt ?? new Date(0).toISOString()),
        attempts: Number(a.attempts) || 0,
        lastError: a.lastError,
      }));
  }
  return m;
}

export function serializeManifest(m: Manifest): string {
  return JSON.stringify(m, null, 2);
}

/** Find the Reader id for a file on the device: manifest first, then the `__<id>` filename suffix. */
export function docIdForFilename(manifest: Manifest, pathOrName: string): string | null {
  const name = pathOrName.split(/[\\/]/).pop() ?? '';
  for (const [id, d] of Object.entries(manifest.documents)) {
    if (d.filename === name) return id;
  }
  return null;
}

/** In-memory store, for tests and dry runs. */
export class MemoryManifestStore implements ManifestStore {
  constructor(public manifest: Manifest = emptyManifest()) {}
  async load() {
    return structuredCloneSafe(this.manifest);
  }
  async save(m: Manifest) {
    this.manifest = structuredCloneSafe(m);
  }
}

function structuredCloneSafe<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

/**
 * Adapter over a "load/save some text" pair, which is all both the Node CLI and the
 * device need to provide.
 */
export function textManifestStore(io: { read(): Promise<string | null>; write(text: string): Promise<void> }): ManifestStore {
  return {
    async load() {
      return parseManifest(await io.read());
    },
    async save(m) {
      await io.write(serializeManifest(m));
    },
  };
}

let lockTail: Promise<unknown> = Promise.resolve();

/**
 * Run `fn` with exclusive access to the manifest. Every read-modify-write of the
 * manifest goes through here, so a sync running in the background can't save a
 * stale copy over a highlight that was queued while it ran. Not reentrant: `fn`
 * must not call another locked operation.
 */
export function withManifestLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = lockTail.then(fn, fn);
  lockTail = run.catch(() => undefined);
  return run;
}

/** Load, change and save the manifest under the lock. */
export function updateManifest<T>(store: ManifestStore, fn: (m: Manifest) => T | Promise<T>): Promise<T> {
  return withManifestLock(async () => {
    const m = await store.load();
    const out = await fn(m);
    await store.save(m);
    return out;
  });
}
