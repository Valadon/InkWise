import { buildEpub, epubFilename, idFromFilename } from './epub.js';
import { flushPending, type FlushResult } from './highlights.js';
import { collectImages, type ImageProcessor } from './images.js';
import { extractImageUrls } from './html.js';
import { addDocHighlight, highlightsKey, updateManifest, withManifestLock, type Manifest, type ManifestDocument, type ManifestStore } from './manifest.js';
import type { HighlightStyle } from './markStyle.js';
import type { OutputAdapter } from './output.js';
import { NetworkError, ReadwiseClient, ReadwiseError } from './readwise.js';
import type { FetchLike, ReaderDocument } from './types.js';

export interface SyncOptions {
  /** Reader location to pull from. Default `later`. */
  location?: string;
  /** Reader category. Default `article`. Pass `null` for every category. */
  category?: string | null;
  /** Only documents with all of these tags (max 5). */
  tags?: string[];
  limit?: number;
  includeImages?: boolean;
  /** Remove local files for documents no longer in the queue (or archived elsewhere). */
  removeMissing?: boolean;
  /** When removing, move to `Archive/` instead of deleting, if the adapter can. */
  removeMode?: 'delete' | 'archive-folder';
  dryRun?: boolean;
  /** Rebuild every EPUB even if unchanged. */
  force?: boolean;
  /** Per-EPUB image budget in bytes. */
  imageBudgetBytes?: number;
  /** Mark Readwise highlights in the EPUBs. Default true. */
  showHighlights?: boolean;
  /** How marked highlights look. */
  highlightStyle?: HighlightStyle;
}

export interface SyncDeps {
  client: ReadwiseClient;
  output: OutputAdapter;
  manifest: ManifestStore;
  /** Used to download images. Defaults to no images when absent. */
  fetchImages?: FetchLike;
  processImage?: ImageProcessor;
  onProgress?: (message: string) => void;
  now?: () => Date;
}

export interface SyncItemResult {
  id: string;
  title: string;
  filename: string;
  action: 'added' | 'updated' | 'skipped' | 'removed' | 'failed' | 'adopted';
  error?: string;
}

export interface SyncResult {
  added: number;
  updated: number;
  skipped: number;
  removed: number;
  failed: number;
  items: SyncItemResult[];
  highlights: FlushResult;
  warnings: string[];
  /** One-line summary for e-ink UIs and the CLI. */
  summary: string;
}

export async function syncReader(deps: SyncDeps, opts: SyncOptions = {}): Promise<SyncResult> {
  const now = deps.now ?? (() => new Date());
  const say = deps.onProgress ?? (() => {});
  const warnings: string[] = [];
  const includeImages = opts.includeImages ?? true;
  // Anything queued offline goes first, so a highlight never waits behind a long sync.
  let highlights: FlushResult = { sent: 0, stillPending: 0, needsAttention: 0, archived: 0 };
  // `manifest` is a snapshot for deciding what to write. Saves never write it back
  // whole: they reload under the lock and change only the entries this sync owns,
  // so highlights queued while the sync runs survive.
  const manifest = await withManifestLock(async () => {
    const m = await deps.manifest.load();
    if (!opts.dryRun && (m.pendingHighlights.length || m.pendingArchives?.length)) {
      say('Sending saved highlights…');
      highlights = await flushPending({ client: deps.client, manifest: m, now });
      await deps.manifest.save(m);
    }
    return m;
  });
  const setDoc = (id: string, entry: ManifestDocument) => {
    manifest.documents[id] = entry;
    if (opts.dryRun) return Promise.resolve();
    return updateManifest(deps.manifest, (m) => {
      m.documents[id] = entry;
    });
  };

  say('Fetching your Reader queue…');
  const docs = await deps.client.listDocuments({
    location: opts.location ?? 'later',
    category: opts.category === null ? undefined : opts.category ?? 'article',
    tags: opts.tags,
    withHtmlContent: true,
    limit: opts.limit,
  });
  say(`Found ${docs.length} ${docs.length === 1 ? 'article' : 'articles'}.`);

  const showHighlights = opts.showHighlights ?? true;
  if (showHighlights && docs.length) await pullHighlights(deps, manifest, docs, opts, warnings, say, now);

  const existing = await deps.output.list();
  const existingNames = new Set(existing.map((f) => f.name));
  /** Duplicate guard: whatever the title, a file carrying `__<id>` means we already have it. */
  const existingById = new Map<string, string>();
  for (const f of existing) {
    const id = idFromFilename(f.name);
    if (id) existingById.set(id, f.name);
  }

  const items: SyncItemResult[] = [];
  let written = 0;
  const toWrite = docs.filter((d) => needsWrite(d, manifest, existingById, opts.force, showHighlights, opts.highlightStyle));
  for (const doc of docs) {
    const title = doc.title?.trim() || 'Untitled';
    const filename = epubFilename(doc);
    const entry = manifest.documents[doc.id];
    const onDisk = existingById.get(doc.id);

    if (!toWrite.includes(doc)) {
      if (!entry && onDisk) {
        // Written by the other Inkwise (CLI vs plugin). Track it, don't duplicate it.
        await setDoc(doc.id, {
          title,
          filename: onDisk,
          updatedAt: doc.updated_at,
          status: 'synced',
          url: doc.url,
          author: doc.author,
          sourceUrl: doc.source_url,
          syncedAt: now().toISOString(),
        });
        items.push({ id: doc.id, title, filename: onDisk, action: 'adopted' });
      } else {
        items.push({ id: doc.id, title, filename: onDisk ?? filename, action: 'skipped' });
      }
      continue;
    }

    written++;
    say(`Writing ${written}/${toWrite.length}: ${title}`);
    try {
      let images;
      if (includeImages && deps.fetchImages && doc.html_content) {
        const urls = extractImageUrls(doc.html_content, doc.source_url || doc.url);
        if (urls.length) {
          images = await collectImages(urls, {
            fetch: deps.fetchImages,
            process: deps.processImage,
            budgetBytes: opts.imageBudgetBytes,
            onWarning: (w) => warnings.push(`${title}: ${w}`),
          });
        }
      }
      const highlights = showHighlights ? manifest.docHighlights[doc.id] : undefined;
      const epub = buildEpub(doc, { images, includeImages, modified: now(), highlights, highlightStyle: opts.highlightStyle });
      const isUpdate = !!onDisk || !!entry;
      if (!opts.dryRun) {
        await deps.output.put(epub.filename, epub.bytes);
        // The title changed, so the filename did too: drop the stale copy.
        if (onDisk && onDisk !== epub.filename && existingNames.has(onDisk) && deps.output.remove) {
          await deps.output.remove(onDisk);
        }
        await setDoc(doc.id, {
          title,
          filename: epub.filename,
          updatedAt: doc.updated_at,
          status: 'synced',
          url: doc.url,
          author: doc.author,
          sourceUrl: doc.source_url,
          syncedAt: now().toISOString(),
          marked: highlightsKey(highlights, opts.highlightStyle),
        });
      }
      items.push({ id: doc.id, title, filename: epub.filename, action: isUpdate ? 'updated' : 'added' });
    } catch (err) {
      if (err instanceof NetworkError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      items.push({ id: doc.id, title, filename, action: 'failed', error: message });
      warnings.push(`${title}: ${message}`);
    }
  }

  const statusChanges: Record<string, ManifestDocument['status']> = {};
  // Cleanup only when we saw the whole queue; if the limit cut the list short we can't tell what's missing.
  if (opts.removeMissing && (!opts.limit || docs.length < opts.limit)) {
    const current = new Set(docs.map((d) => d.id));
    for (const [id, entry] of Object.entries(manifest.documents)) {
      if (entry.status !== 'synced' || current.has(id)) continue;
      const name = existingById.get(id) ?? entry.filename;
      if (!existingNames.has(name)) {
        statusChanges[id] = 'removed';
        continue;
      }
      if (!opts.dryRun) {
        if (opts.removeMode === 'archive-folder' && deps.output.moveToSubfolder) {
          await deps.output.moveToSubfolder(name, 'Archive');
          statusChanges[id] = 'archived';
        } else if (deps.output.remove) {
          await deps.output.remove(name);
          statusChanges[id] = 'removed';
        } else {
          warnings.push(`${entry.title}: this target can't delete files; left in place.`);
          continue;
        }
      }
      items.push({ id, title: entry.title, filename: name, action: 'removed' });
    }
  }

  if (!opts.dryRun) {
    await updateManifest(deps.manifest, (m) => {
      for (const [id, status] of Object.entries(statusChanges)) {
        if (m.documents[id]) m.documents[id]!.status = status;
      }
      m.lastSyncAt = now().toISOString();
    });
  }

  const count = (a: SyncItemResult['action']) => items.filter((i) => i.action === a).length;
  const result: SyncResult = {
    added: count('added'),
    updated: count('updated'),
    skipped: count('skipped') + count('adopted'),
    removed: count('removed'),
    failed: count('failed'),
    items,
    highlights,
    warnings,
    summary: '',
  };
  result.summary = summarize(result, !!opts.dryRun);
  return result;
}

function needsWrite(
  doc: ReaderDocument,
  manifest: Manifest,
  existingById: Map<string, string>,
  force?: boolean,
  showHighlights = true,
  style?: HighlightStyle,
): boolean {
  if (force) return true;
  const entry = manifest.documents[doc.id];
  const onDisk = existingById.get(doc.id);
  if (!onDisk) return true;
  // Adopt a copy written by the other tool (or before a reinstall wiped the
  // manifest), unless it should show highlights it can't be known to have.
  if (!entry) return showHighlights && highlightsKey(manifest.docHighlights[doc.id], style) !== '';
  if (showHighlights && (entry.marked ?? '') !== highlightsKey(manifest.docHighlights[doc.id], style)) return true;
  return entry.updatedAt !== doc.updated_at || entry.filename !== onDisk;
}

/**
 * Fetch highlights made in Reader (on the phone, the web, anywhere) for the
 * documents being synced, so the EPUBs can show them. Only highlights changed
 * since the last fetch are requested; the first fetch starts from the oldest
 * document in the queue, since no highlight can be older than its document.
 */
async function pullHighlights(
  deps: SyncDeps,
  manifest: Manifest,
  docs: ReaderDocument[],
  opts: SyncOptions,
  warnings: string[],
  say: (m: string) => void,
  now: () => Date,
): Promise<void> {
  // Reader's clock and the device's can disagree; overlap a little.
  const startedAt = new Date(now().getTime() - 5 * 60 * 1000).toISOString();
  const oldest = docs.map((d) => d.created_at).filter(Boolean).sort()[0];
  const updatedAfter = manifest.highlightsSyncedAt ?? oldest;
  say('Checking for new highlights…');
  let found;
  try {
    found = await deps.client.listHighlights({ updatedAfter });
  } catch (err) {
    if (err instanceof NetworkError) throw err;
    warnings.push(`Couldn't fetch highlights from Readwise: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const wanted = new Set(docs.map((d) => d.id));
  const relevant = found.filter((h) => wanted.has(h.parentId));
  for (const h of relevant) addDocHighlight(manifest, h.parentId, h.text, { id: h.id, note: h.note });
  if (opts.dryRun) return;
  await updateManifest(deps.manifest, (m) => {
    for (const h of relevant) addDocHighlight(m, h.parentId, h.text, { id: h.id, note: h.note });
    m.highlightsSyncedAt = startedAt;
  });
}

export function summarize(r: Omit<SyncResult, 'summary'>, dryRun = false): string {
  const parts: string[] = [];
  const verb = dryRun ? 'Would sync' : 'Synced';
  parts.push(`${verb} ${r.added} new, ${r.updated} updated`);
  if (r.removed) parts.push(`${r.removed} removed`);
  if (r.failed) parts.push(`${r.failed} failed`);
  let line = `${parts.join(', ')}.`;
  if (r.highlights.sent) line += ` Sent ${r.highlights.sent} saved ${r.highlights.sent === 1 ? 'highlight' : 'highlights'}.`;
  if (r.highlights.needsAttention) line += ` ${r.highlights.needsAttention} ${r.highlights.needsAttention === 1 ? 'highlight needs' : 'highlights need'} attention.`;
  return line;
}

/** Human message for an error thrown out of `syncReader`. */
export function describeSyncError(err: unknown): string {
  if (err instanceof NetworkError) return 'No connection to Readwise. Check Wi-Fi and try again.';
  if (err instanceof ReadwiseError) return err.message;
  return err instanceof Error ? err.message : String(err);
}
