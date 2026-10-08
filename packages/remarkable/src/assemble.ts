import type { RmHighlight } from './rmHighlights.js';

/**
 * Turns the raw highlight pieces from a document's pages into the highlights
 * the reader meant, with their text taken from the source document.
 *
 * What the Paper Pro stores is lossy:
 * - A highlight dragged over several lines is saved as one piece per stroke,
 *   and one across a page turn is saved on both pages.
 * - Line breaks inside a piece vanish ("Every’sJanuary").
 * - Ligatures come out as junk or not at all ("offsite" -> "o2site",
 *   "filled" -> "lled").
 *
 * So each piece is found in the source text with a tolerant match, and pieces
 * of the same colour that touch in the source (nothing but whitespace between
 * them) are joined into one highlight.
 */

export interface PagePiece {
  /** Page position in the document (from the .content file's page list). */
  pageIndex: number;
  highlight: RmHighlight;
}

export interface AssembledHighlight {
  /** Passage exactly as the source has it; the device text when not found. */
  text: string;
  color: number;
  /** Source offsets (end exclusive); -1 when the passage wasn't found. */
  start: number;
  end: number;
  /** "page:item" ids of the pieces that make up this highlight. */
  pieces: string[];
  located: boolean;
}

interface Folded {
  text: string;
  /** Source index of each folded character. */
  map: number[];
}

const ALNUM = /[\p{L}\p{N}]/u;

/** Letters and digits only, lowercased. Spacing and punctuation are too unreliable to compare. */
function fold(s: string): Folded {
  let text = '';
  const map: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (!ALNUM.test(ch)) continue;
    for (const c of ch.toLowerCase()) {
      text += c;
      map.push(i);
    }
  }
  return { text, map };
}

interface Match {
  /** Folded source offsets, end exclusive. */
  start: number;
  end: number;
  distance: number;
}

const F = 'f'.charCodeAt(0);
const I = 'i'.charCodeAt(0);
const L = 'l'.charCodeAt(0);

/**
 * Best place for `needle` inside `hay[from, to)`, by edit distance
 * (semi-global alignment). Costs are in half-errors: an ordinary edit costs 2,
 * but the letters inside an f-ligature (ff, fi, fl, ffi, ffl) cost 1 to skip
 * or to stand in for, since that's exactly what the device garbles.
 */
function align(needle: string, hay: string, from: number, to: number): Match {
  const m = needle.length;
  const n = to - from;
  let prev = new Int32Array(n + 1);
  let prevStart = new Int32Array(n + 1);
  let cur = new Int32Array(n + 1);
  let curStart = new Int32Array(n + 1);
  for (let j = 0; j <= n; j++) prevStart[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = 2 * i;
    curStart[0] = 0;
    const a = needle.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const b = hay.charCodeAt(from + j - 1);
      let best = prev[j - 1]! + (a === b ? 0 : b === F ? 1 : 2);
      let start = prevStart[j - 1]!;
      if (prev[j]! + 2 < best) {
        best = prev[j]! + 2;
        start = prevStart[j]!;
      }
      const skip = b === F || b === I || b === L ? 1 : 2;
      if (cur[j - 1]! + skip < best) {
        best = cur[j - 1]! + skip;
        start = curStart[j - 1]!;
      }
      cur[j] = best;
      curStart[j] = start;
    }
    [prev, cur] = [cur, prev];
    [prevStart, curStart] = [curStart, prevStart];
  }
  let end = 0;
  for (let j = 1; j <= n; j++) if (prev[j]! < prev[end]!) end = j;
  return { start: from + prevStart[end]!, end: from + end, distance: prev[end]! };
}

/** How many edits a match of this length may need, in the half-error units `align` uses. */
function allowedErrors(len: number): number {
  return len < 8 ? 0 : 2 * Math.max(1, Math.floor(len * 0.12));
}

/**
 * Every plausible place `needle` (folded) occurs in `source` (folded), best
 * first. Long needles are pinned down by exact 12-character chunks, then
 * aligned around each candidate so a few junk characters don't matter.
 */
function findCandidates(needle: string, source: string): Match[] {
  const m = needle.length;
  if (!m) return [];
  const exact: Match[] = [];
  for (let at = source.indexOf(needle); at !== -1 && exact.length < 50; at = source.indexOf(needle, at + 1)) {
    exact.push({ start: at, end: at + m, distance: 0 });
  }
  const limit = allowedErrors(m);
  if (exact.length || limit === 0) return exact;
  // Short and not found as-is: cheap enough to align against the whole text.
  if (m < 24) {
    const hit = align(needle, source, 0, source.length);
    return hit.distance <= limit ? [hit] : [];
  }

  for (const chunk of [12, 6]) {
    const out = alignAroundChunks(needle, source, chunk, limit);
    if (out.length) return out;
  }
  // Too garbled for any chunk to land: align against everything, if that's affordable.
  if (m * source.length > 50_000_000) return [];
  const hit = align(needle, source, 0, source.length);
  return hit.distance <= limit ? [hit] : [];
}

/** Vote on where the needle starts from exact chunk hits, then align around the best guesses. */
function alignAroundChunks(needle: string, source: string, size: number, limit: number): Match[] {
  const m = needle.length;
  const votes = new Map<number, number>();
  for (let k = 0; k + size <= m; k += size) {
    const chunk = needle.slice(k, k + size);
    let hits = 0;
    for (let at = source.indexOf(chunk); at !== -1 && hits < 20; at = source.indexOf(chunk, at + 1), hits++) {
      const key = Math.round((at - k) / 32);
      votes.set(key, (votes.get(key) ?? 0) + 1);
    }
  }
  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const out: Match[] = [];
  const pad = Math.ceil(m * 0.25) + 40;
  for (const [key] of ranked) {
    const guess = key * 32;
    const from = Math.max(0, guess - pad);
    const to = Math.min(source.length, guess + m + pad);
    const hit = align(needle, source, from, to);
    if (hit.distance <= limit && !out.some((o) => Math.abs(o.start - hit.start) < m / 2)) out.push(hit);
  }
  return out.sort((a, b) => a.distance - b.distance);
}

const isMark = (ch: string | undefined) => !!ch && !ALNUM.test(ch) && !/\s/.test(ch);

/** Source span for a folded match, widened to whole words and over the punctuation the device text starts or ends with. */
function toSourceSpan(match: Match, folded: Folded, source: string, deviceText: string): { start: number; end: number } {
  let start = folded.map[match.start]!;
  let end = folded.map[match.end - 1]! + 1;
  // Highlights cover whole words; this also restores a ligature lost at either edge ("fifty" read as "fty").
  while (start > 0 && ALNUM.test(source[start - 1]!)) start--;
  while (end < source.length && ALNUM.test(source[end]!)) end++;
  const t = deviceText.trim();
  let lead = 0;
  while (isMark(t[lead])) lead++;
  let trail = 0;
  while (isMark(t[t.length - 1 - trail])) trail++;
  for (let k = 0; k < lead && isMark(source[start - 1]); k++) start--;
  for (let k = 0; k < trail && isMark(source[end]); k++) end++;
  return { start, end };
}

/** Assemble the highlights of one document. Output is in source order; unlocated pieces come last. */
export function assembleHighlights(pieces: PagePiece[], source: string): AssembledHighlight[] {
  const folded = fold(source);
  const located: (AssembledHighlight & { page: number })[] = [];
  const lost: AssembledHighlight[] = [];

  // Long pieces first: their positions settle which copy of a short, repeated piece is meant.
  const order = [...pieces].sort((a, b) => b.highlight.text.length - a.highlight.text.length);
  for (const p of order) {
    const id = `${p.pageIndex}:${p.highlight.id}`;
    const needle = fold(p.highlight.text).text;
    const candidates = findCandidates(needle, folded.text);
    if (!candidates.length) {
      lost.push({ text: p.highlight.text, color: p.highlight.color, start: -1, end: -1, pieces: [id], located: false });
      continue;
    }
    let pick = candidates[0]!;
    if (candidates.length > 1) {
      // A repeated phrase: take the copy closest to this page's other highlights, same colour first.
      const near = located.filter((l) => Math.abs(l.page - p.pageIndex) <= 1);
      const sameColor = near.filter((l) => l.color === p.highlight.color);
      const anchors = sameColor.length ? sameColor : near;
      if (anchors.length) {
        const dist = (c: Match) => Math.min(...anchors.map((l) => Math.abs(folded.map[c.start]! - l.start)));
        pick = candidates.reduce((best, c) => (c.distance < best.distance || (c.distance === best.distance && dist(c) < dist(best)) ? c : best));
      }
    }
    const span = toSourceSpan(pick, folded, source, p.highlight.text);
    located.push({ ...span, text: '', color: p.highlight.color, pieces: [id], located: true, page: p.pageIndex });
  }

  located.sort((a, b) => a.start - b.start);
  const merged: AssembledHighlight[] = [];
  for (const { page: _page, ...h } of located) {
    const last = merged[merged.length - 1];
    if (last && last.color === h.color && (h.start <= last.end || /^\s*$/.test(source.slice(last.end, h.start)))) {
      last.end = Math.max(last.end, h.end);
      last.pieces.push(...h.pieces);
    } else {
      merged.push(h);
    }
  }
  for (const h of merged) h.text = source.slice(h.start, h.end);
  return [...merged, ...lost];
}
