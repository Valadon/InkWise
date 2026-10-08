import { Parser } from 'htmlparser2';
import { idFromFilename } from './epub.js';
import { addDocHighlight, docIdForFilename, withManifestLock, type Manifest, type ManifestStore, type PendingHighlight } from './manifest.js';
import { highlightHash, highlightVariants, normalizeSelection, straighten } from './normalize.js';
import { NetworkError, ReadwiseClient, ReadwiseError } from './readwise.js';

export type SendStatus =
  | 'sent'
  | 'duplicate'
  | 'queued_offline'
  | 'needs_attention'
  | 'not_inkwise'
  | 'empty'
  | 'token_rejected';

export interface SendResult {
  status: SendStatus;
  /** One line for the e-ink UI. */
  message: string;
  docId?: string;
  /** The text Readwise accepted, when it differs from the selection. */
  sentText?: string;
  /** Reader id of the new highlight (lets the UI attach a note afterwards). */
  highlightId?: string;
}

export interface SendHighlightInput {
  client: ReadwiseClient;
  manifest: ManifestStore;
  /** Path of the open file (from `PluginCommAPI.getCurrentFilePath()`). */
  filePath: string;
  /** Raw selection (from `PluginDocAPI.getLastSelectedText()`). */
  text: string;
  note?: string;
  /** Last-chance id lookup: read `dc:identifier` from the EPUB itself. */
  readIdentifier?: (filePath: string) => Promise<string | null>;
  now?: () => Date;
}

/** Work out which Reader document a file on the device belongs to. */
export async function resolveDocId(
  manifest: Manifest,
  filePath: string,
  readIdentifier?: (filePath: string) => Promise<string | null>,
): Promise<string | null> {
  if (!filePath) return null;
  const fromManifest = docIdForFilename(manifest, filePath);
  if (fromManifest) return fromManifest;
  const fromName = idFromFilename(filePath);
  if (fromName) return fromName;
  if (readIdentifier && /\.epub$/i.test(filePath)) {
    try {
      const ident = await readIdentifier(filePath);
      const m = ident ? /^urn:readwise:([A-Za-z0-9]+)$/.exec(ident.trim()) : null;
      if (m) return m[1]!;
    } catch {
      // Unreadable file: fall through to "not from Readwise".
    }
  }
  return null;
}

/**
 * The Send highlight button. Never loses a highlight: anything that can't be sent
 * now is queued in the manifest, either to retry later or for the user to review.
 */
export function sendHighlight(opts: Parameters<typeof sendHighlightUnlocked>[0]): ReturnType<typeof sendHighlightUnlocked> {
  return withManifestLock(() => sendHighlightUnlocked(opts));
}

async function sendHighlightUnlocked(input: SendHighlightInput): Promise<SendResult> {
  const now = input.now ?? (() => new Date());
  const text = normalizeSelection(input.text ?? '');
  if (!text) return { status: 'empty', message: 'Select some text first, then tap Send highlight.' };

  const manifest = await input.manifest.load();
  const docId = await resolveDocId(manifest, input.filePath, input.readIdentifier);
  if (!docId) return { status: 'not_inkwise', message: "This document isn't from Readwise." };

  const hash = highlightHash(docId, text);
  if (manifest.sentHighlightHashes.includes(hash)) {
    return { status: 'duplicate', message: 'Already sent this highlight.', docId };
  }
  const already = manifest.pendingHighlights.find((p) => p.docId === docId && highlightHash(p.docId, p.text) === hash);
  if (already) {
    return {
      status: already.state === 'needs_attention' ? 'needs_attention' : 'queued_offline',
      message: 'This highlight is already saved and waiting to send.',
      docId,
    };
  }

  const pending: PendingHighlight = {
    docId,
    text,
    note: (input.note ?? '').trim(),
    createdAt: now().toISOString(),
    attempts: 0,
    state: 'pending',
  };

  // Flush older queued items first so highlights reach Readwise in reading order.
  if (manifest.pendingHighlights.some((p) => p.state === 'pending')) {
    try {
      await flushPending({ client: input.client, manifest, now, onlyHighlights: true });
    } catch {
      // Best effort; the new highlight is handled below either way.
    }
  }

  const outcome = await attemptSend(input.client, pending);
  return finish(input.manifest, manifest, pending, outcome, hash);
}

type Attempt =
  | { kind: 'sent'; sentText: string; highlightId?: string }
  | { kind: 'not_found'; error: string }
  | { kind: 'offline'; error: string }
  | { kind: 'auth'; error: string }
  | { kind: 'retryable'; error: string };

/** Try the selection, then the exact text located in Reader's copy, then quote/dash variants. */
async function attemptSend(client: ReadwiseClient, p: PendingHighlight): Promise<Attempt> {
  p.attempts++;
  const tried = new Set<string>();
  const tryOne = async (candidate: string): Promise<Attempt | null> => {
    if (!candidate || tried.has(candidate)) return null;
    tried.add(candidate);
    try {
      const created = await client.createHighlight({ parentId: p.docId, text: candidate, note: p.note || undefined });
      return { kind: 'sent', sentText: candidate, highlightId: created.id || undefined };
    } catch (err) {
      if (err instanceof NetworkError) return { kind: 'offline', error: err.message };
      if (err instanceof ReadwiseError) {
        if (err.status === 400) return null;
        if (err.status === 401 || err.status === 403) return { kind: 'auth', error: err.message };
        if (err.status === 404) return { kind: 'not_found', error: 'Reader no longer has this document.' };
        return { kind: 'retryable', error: err.message };
      }
      return { kind: 'retryable', error: err instanceof Error ? err.message : String(err) };
    }
  };

  const first = await tryOne(p.text);
  if (first) return first;

  // Readwise couldn't find the text. Fetch its copy and locate the passage exactly.
  try {
    const doc = await client.getDocument(p.docId, true);
    if (!doc) return { kind: 'not_found', error: 'Reader no longer has this document.' };
    if (doc.html_content) {
      const located = locateInHtml(p.text, doc.html_content);
      if (located) {
        const r = await tryOne(located);
        if (r) return r;
      }
    }
  } catch (err) {
    if (err instanceof NetworkError) return { kind: 'offline', error: err.message };
    // Lookup failed for another reason; still try the cheap variants.
  }

  for (const v of highlightVariants(p.text)) {
    const r = await tryOne(v);
    if (r) return r;
  }
  return {
    kind: 'not_found',
    error: "Readwise couldn't match this text to the article.",
  };
}

async function finish(
  store: ManifestStore,
  manifest: Manifest,
  p: PendingHighlight,
  outcome: Attempt,
  hash: string,
): Promise<SendResult> {
  switch (outcome.kind) {
    case 'sent':
      manifest.sentHighlightHashes.push(hash);
      addDocHighlight(manifest, p.docId, outcome.sentText ?? p.text);
      await store.save(manifest);
      return {
        status: 'sent',
        message: 'Highlight sent.',
        docId: p.docId,
        sentText: outcome.sentText !== p.text ? outcome.sentText : undefined,
        highlightId: outcome.highlightId,
      };
    case 'offline':
    case 'retryable':
      p.lastError = outcome.error;
      manifest.pendingHighlights.push(p);
      addDocHighlight(manifest, p.docId, p.text);
      await store.save(manifest);
      return { status: 'queued_offline', message: 'Saved offline, will send on next sync.', docId: p.docId };
    case 'auth':
      p.lastError = outcome.error;
      manifest.pendingHighlights.push(p);
      await store.save(manifest);
      return {
        status: 'token_rejected',
        message: 'Readwise token rejected. Highlight saved; open Inkwise settings to re-enter the token.',
        docId: p.docId,
      };
    case 'not_found':
      p.state = 'needs_attention';
      p.lastError = outcome.error;
      manifest.pendingHighlights.push(p);
      await store.save(manifest);
      return {
        status: 'needs_attention',
        message: "Readwise couldn't match this text. Saved in Inkwise settings for review.",
        docId: p.docId,
      };
  }
}

/**
 * Attach a note after the fact: on Readwise if the highlight was sent, or on the
 * queued copy if it's still waiting.
 */
export function addNoteToHighlight(opts: Parameters<typeof addNoteToHighlightUnlocked>[0]): ReturnType<typeof addNoteToHighlightUnlocked> {
  return withManifestLock(() => addNoteToHighlightUnlocked(opts));
}

async function addNoteToHighlightUnlocked(opts: {
  client: ReadwiseClient;
  manifest: ManifestStore;
  docId: string;
  text: string;
  note: string;
  highlightId?: string;
}): Promise<{ ok: boolean; message: string }> {
  const note = opts.note.trim();
  if (!note) return { ok: false, message: 'Type a note first.' };
  const manifest = await opts.manifest.load();
  const hash = highlightHash(opts.docId, opts.text);
  const queued = manifest.pendingHighlights.find((p) => p.docId === opts.docId && highlightHash(p.docId, p.text) === hash);
  if (queued) {
    queued.note = note;
    await opts.manifest.save(manifest);
    return { ok: true, message: 'Note saved; it will go with the highlight.' };
  }
  if (!opts.highlightId) return { ok: false, message: "Couldn't find that highlight to attach a note." };
  try {
    await opts.client.updateHighlightNotes(opts.highlightId, note);
    return { ok: true, message: 'Note added.' };
  } catch (err) {
    if (err instanceof NetworkError) return { ok: false, message: 'No connection. The highlight is saved; add the note in Reader later.' };
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export interface FlushResult {
  sent: number;
  stillPending: number;
  needsAttention: number;
  archived: number;
}

/**
 * Send queued highlights (state `pending`) and queued archive requests. Mutates
 * `manifest`; the caller saves it. Stops early when offline.
 */
export async function flushPending(opts: {
  client: ReadwiseClient;
  manifest: Manifest;
  now?: () => Date;
  onlyHighlights?: boolean;
  /** Only flush this document's items (used before archiving it). */
  docId?: string;
}): Promise<FlushResult> {
  const { client, manifest } = opts;
  const result: FlushResult = { sent: 0, stillPending: 0, needsAttention: 0, archived: 0 };
  const keep: PendingHighlight[] = [];
  let offline = false;
  for (const p of manifest.pendingHighlights) {
    if (p.state !== 'pending' || offline || (opts.docId && p.docId !== opts.docId)) {
      keep.push(p);
      continue;
    }
    const outcome = await attemptSend(client, p);
    const hash = highlightHash(p.docId, p.text);
    if (outcome.kind === 'sent') {
      if (!manifest.sentHighlightHashes.includes(hash)) manifest.sentHighlightHashes.push(hash);
      addDocHighlight(manifest, p.docId, outcome.sentText);
      result.sent++;
      continue;
    }
    p.lastError = outcome.error;
    if (outcome.kind === 'not_found') p.state = 'needs_attention';
    if (outcome.kind === 'offline' || outcome.kind === 'auth') offline = true;
    keep.push(p);
  }
  manifest.pendingHighlights = keep;

  if (!opts.onlyHighlights && !offline && manifest.pendingArchives?.length) {
    const left = [];
    for (const a of manifest.pendingArchives) {
      if (offline || (opts.docId && a.docId !== opts.docId)) {
        left.push(a);
        continue;
      }
      try {
        a.attempts++;
        await client.archive(a.docId);
        const d = manifest.documents[a.docId];
        if (d) d.status = 'archived';
        result.archived++;
      } catch (err) {
        if (err instanceof ReadwiseError && err.status === 404) continue; // gone already
        a.lastError = err instanceof Error ? err.message : String(err);
        if (err instanceof NetworkError) offline = true;
        left.push(a);
      }
    }
    manifest.pendingArchives = left;
  }

  result.stillPending = manifest.pendingHighlights.filter((p) => p.state === 'pending').length;
  result.needsAttention = manifest.pendingHighlights.filter((p) => p.state === 'needs_attention').length;
  return result;
}

/** What the settings view can do with a highlight that needs attention. */
export type ReviewAction = 'retry' | 'send_classic' | 'discard';

export function resolveNeedsAttention(opts: Parameters<typeof resolveNeedsAttentionUnlocked>[0]): ReturnType<typeof resolveNeedsAttentionUnlocked> {
  return withManifestLock(() => resolveNeedsAttentionUnlocked(opts));
}

async function resolveNeedsAttentionUnlocked(opts: {
  client: ReadwiseClient;
  manifest: ManifestStore;
  /** Position in the queue; ignored when `key` is given. */
  index?: number;
  action: ReviewAction;
  /** Optional corrected text when retrying. */
  text?: string;
  /** Identifies the highlight independent of its position in the queue. */
  key?: { docId: string; createdAt: string };
}): Promise<SendResult> {
  const manifest = await opts.manifest.load();
  // Prefer the stable key: the queue may have changed since the list was drawn.
  const index =
    opts.key != null
      ? manifest.pendingHighlights.findIndex((h) => h.docId === opts.key!.docId && h.createdAt === opts.key!.createdAt)
      : opts.index ?? -1;
  const p = index >= 0 ? manifest.pendingHighlights[index] : undefined;
  if (!p) return { status: 'empty', message: 'That highlight is no longer in the queue.' };
  if (opts.action === 'discard') {
    manifest.pendingHighlights.splice(index, 1);
    await opts.manifest.save(manifest);
    return { status: 'sent', message: 'Highlight removed from the queue.', docId: p.docId };
  }
  if (opts.action === 'send_classic') {
    const d = manifest.documents[p.docId];
    try {
      await opts.client.createClassicHighlight({
        text: p.text,
        title: d?.title || 'Inkwise highlight',
        author: d?.author,
        sourceUrl: d?.sourceUrl ?? d?.url,
        note: p.note,
        highlightedAt: p.createdAt,
      });
    } catch (err) {
      return {
        status: err instanceof NetworkError ? 'queued_offline' : 'needs_attention',
        message: err instanceof NetworkError ? 'No connection. Try again when online.' : 'Readwise rejected the highlight.',
        docId: p.docId,
      };
    }
    manifest.pendingHighlights.splice(index, 1);
    manifest.sentHighlightHashes.push(highlightHash(p.docId, p.text));
    await opts.manifest.save(manifest);
    return { status: 'sent', message: 'Saved to Readwise as a standalone highlight.', docId: p.docId };
  }
  if (opts.text) p.text = normalizeSelection(opts.text);
  const outcome = await attemptSend(opts.client, p);
  manifest.pendingHighlights.splice(index, 1);
  return finish(opts.manifest, manifest, { ...p, state: 'pending' }, outcome, highlightHash(p.docId, p.text));
}

export interface ArchiveResult {
  status: 'archived' | 'queued_offline' | 'not_inkwise' | 'failed';
  message: string;
  docId?: string;
}

/**
 * The Done button: flush this document's highlights, then archive it in Reader.
 * Offline, the archive is queued and happens on the next sync.
 */
export function archiveDocument(opts: Parameters<typeof archiveDocumentUnlocked>[0]): ReturnType<typeof archiveDocumentUnlocked> {
  return withManifestLock(() => archiveDocumentUnlocked(opts));
}

async function archiveDocumentUnlocked(opts: {
  client: ReadwiseClient;
  manifest: ManifestStore;
  filePath: string;
  readIdentifier?: (filePath: string) => Promise<string | null>;
  now?: () => Date;
}): Promise<ArchiveResult> {
  const now = opts.now ?? (() => new Date());
  const manifest = await opts.manifest.load();
  const docId = await resolveDocId(manifest, opts.filePath, opts.readIdentifier);
  if (!docId) return { status: 'not_inkwise', message: "This document isn't from Readwise." };

  const queue = () => {
    manifest.pendingArchives ??= [];
    if (!manifest.pendingArchives.some((a) => a.docId === docId)) {
      manifest.pendingArchives.push({ docId, createdAt: now().toISOString(), attempts: 0 });
    }
  };

  const flushed = await flushPending({ client: opts.client, manifest, now, onlyHighlights: true, docId });
  const stillQueued = manifest.pendingHighlights.some((p) => p.docId === docId && p.state === 'pending');
  if (stillQueued) {
    // Don't archive ahead of this document's highlights; do both on the next sync.
    queue();
    await opts.manifest.save(manifest);
    return { status: 'queued_offline', message: 'Saved offline. Will archive after its highlights send.', docId };
  }
  try {
    await opts.client.archive(docId);
  } catch (err) {
    if (err instanceof NetworkError) {
      queue();
      await opts.manifest.save(manifest);
      return { status: 'queued_offline', message: 'Saved offline, will archive on next sync.', docId };
    }
    await opts.manifest.save(manifest);
    return { status: 'failed', message: err instanceof Error ? err.message : String(err), docId };
  }
  const d = manifest.documents[docId];
  if (d) d.status = 'archived';
  manifest.pendingArchives = (manifest.pendingArchives ?? []).filter((a) => a.docId !== docId);
  await opts.manifest.save(manifest);
  const extra = flushed.sent ? ` Sent ${flushed.sent} saved ${flushed.sent === 1 ? 'highlight' : 'highlights'} first.` : '';
  return { status: 'archived', message: `Archived in Reader.${extra}`, docId };
}

// ---------------------------------------------------------------------------
// Locating a selection inside Reader's own HTML
// ---------------------------------------------------------------------------

const BLOCK_TAGS = new Set([
  'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'pre', 'figure',
  'figcaption', 'tr', 'td', 'th', 'section', 'article', 'header', 'footer', 'br', 'hr', 'dt', 'dd',
]);
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template']);

/** Plain text of an HTML fragment, with newlines between blocks. */
export function htmlToText(html: string): string {
  const out: string[] = [];
  let skip = 0;
  const parser = new Parser(
    {
      onopentag(name) {
        if (SKIP_TAGS.has(name)) skip++;
        else if (BLOCK_TAGS.has(name)) out.push('\n');
      },
      ontext(t) {
        if (!skip) out.push(t);
      },
      onclosetag(name) {
        if (SKIP_TAGS.has(name)) skip = Math.max(0, skip - 1);
        else if (BLOCK_TAGS.has(name)) out.push('\n');
      },
    },
    { decodeEntities: true, lowerCaseTags: true },
  );
  parser.write(html);
  parser.end();
  return out.join('');
}

/**
 * Find `selection` inside the HTML's text, comparing loosely (quotes, dashes,
 * whitespace, soft hyphens, case), and return the passage exactly as the source
 * has it. Returns null when there's no match.
 */
export function locateInHtml(selection: string, html: string): string | null {
  return locateInText(selection, htmlToText(html));
}

export function locateInText(selection: string, source: string): string | null {
  const range = findLoose(selection, source);
  return range ? source.slice(range.start, range.end).trim() : null;
}

/**
 * Where `needle` sits in `source` under the same loose comparison, as source
 * offsets (`end` exclusive). Searches from `from` (a source offset).
 */
export function findLoose(needle: string, source: string, from = 0): { start: number; end: number } | null {
  const n = foldForMatch(needle).text;
  if (!n) return null;
  const folded = foldForMatch(source);
  let fromFolded = folded.map.findIndex((i) => i >= from);
  if (fromFolded === -1) return null;
  const at = folded.text.indexOf(n, fromFolded);
  if (at === -1) return null;
  return { start: folded.map[at]!, end: folded.map[at + n.length - 1]! + 1 };
}

/** Lowercase, straighten, collapse whitespace; `map[i]` is the source index of folded char i. */
function foldForMatch(s: string): { text: string; map: number[] } {
  let text = '';
  const map: number[] = [];
  let lastWasSpace = true;
  for (let i = 0; i < s.length; i++) {
    let ch = s[i]!;
    if (/[­​-‍⁠﻿]/.test(ch)) continue;
    if (/\s| /.test(ch)) {
      if (lastWasSpace) continue;
      text += ' ';
      map.push(i);
      lastWasSpace = true;
      continue;
    }
    ch = straighten(ch).toLowerCase();
    for (const c of ch) {
      text += c;
      map.push(i);
    }
    lastWasSpace = false;
  }
  if (text.endsWith(' ')) {
    text = text.slice(0, -1);
    map.pop();
  }
  return { text, map };
}
