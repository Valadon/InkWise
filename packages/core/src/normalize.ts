/**
 * Text normalization for highlights.
 *
 * Readwise rejects a highlight (HTTP 400) unless its text appears in the parent
 * document. The EPUB keeps the original text untouched, so most selections match
 * as-is; these helpers clean up what the device's selection adds (odd whitespace,
 * soft hyphens) and generate fallback variants for quote and dash mismatches.
 */

const ZERO_WIDTH = /[​-‍⁠﻿]/g;
const SOFT_HYPHEN = /­/g;
/** Inkwise underlines highlights with U+0332 (markStyle.ts), so a selection over one carries them. */
const UNDERLINE_RE = /\u0332/g;
const NBSP_LIKE = /[   ]/g;
const WHITESPACE_RUN = /\s+/g;

const LIGATURES: Record<string, string> = {
  'ﬀ': 'ff',
  'ﬁ': 'fi',
  'ﬂ': 'fl',
  'ﬃ': 'ffi',
  'ﬄ': 'ffl',
  'ﬅ': 'st',
  'ﬆ': 'st',
};
const LIGATURE_RE = /[ﬀ-ﬆ]/g;

/** Clean a selection the way the PRD describes: trim, collapse whitespace, NBSP to space, drop soft hyphens and zero-width characters, expand ligatures. */
export function normalizeSelection(text: string): string {
  return text
    .replace(ZERO_WIDTH, '')
    .replace(SOFT_HYPHEN, '')
    .replace(UNDERLINE_RE, '')
    .replace(LIGATURE_RE, (ch) => LIGATURES[ch] ?? ch)
    .replace(NBSP_LIKE, ' ')
    .replace(WHITESPACE_RUN, ' ')
    .trim();
}

/** Curly quotes and fancy dashes swapped for their plain ASCII forms. */
export function straighten(text: string): string {
  return text
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[–—―−]/g, '-')
    .replace(/…/g, '...');
}

/** Plain quotes turned into typographic ones (a best guess at what the source used). */
export function curl(text: string): string {
  return text
    .replace(/(^|[\s([{—-])"/g, '$1“')
    .replace(/"/g, '”')
    .replace(/(^|[\s([{—-])'/g, '$1‘')
    .replace(/'/g, '’')
    .replace(/ -- /g, ' — ')
    .replace(/--/g, '—');
}

/**
 * Candidate texts to try, in order, when sending a highlight.
 * The first is the normalized selection; later ones swap quote and dash styles.
 */
export function highlightVariants(raw: string): string[] {
  const base = normalizeSelection(raw);
  const out = [base, straighten(base), curl(straighten(base))];
  // Em dashes are often rendered without surrounding spaces; try both ways.
  out.push(base.replace(/\s*—\s*/g, '—'));
  out.push(straighten(base).replace(/\s*-\s*/g, '-'));
  // The reader breaks lines after a hyphen and the selection puts a space there: "billion- token".
  out.push(base.replace(/([0-9A-Za-z\u00c0-\u024f])[-\u2010\u2011]\s+(?=[0-9A-Za-z\u00c0-\u024f])/g, '$1-'));
  return unique(out.filter((s) => s.length > 0));
}

/** Dedupe key for a highlight: sha1(docId + "\n" + normalized text). */
export function highlightHash(docId: string, text: string): string {
  return sha1(`${docId}\n${straighten(normalizeSelection(text))}`);
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

/** Small pure SHA-1 over UTF-8, so core works in React Native without crypto polyfills. */
export function sha1(input: string): string {
  const bytes = utf8(input);
  const ml = bytes.length * 8;
  const withPadding = ((bytes.length + 9 + 63) >> 6) << 6;
  const msg = new Uint8Array(withPadding);
  msg.set(bytes);
  msg[bytes.length] = 0x80;
  const view = new DataView(msg.buffer);
  view.setUint32(withPadding - 8, Math.floor(ml / 0x100000000));
  view.setUint32(withPadding - 4, ml >>> 0);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let off = 0; off < withPadding; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!;
      w[i] = (x << 1) | (x >>> 31);
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number, k: number;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const temp = (((a << 5) | (a >>> 27)) + f + e + k + w[i]!) >>> 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = temp;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map((h) => (h >>> 0).toString(16).padStart(8, '0')).join('');
}

/** UTF-8 encode without TextEncoder (missing on some Hermes builds). */
export function utf8(str: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let cp = str.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < str.length) {
      const lo = str.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
        i++;
      }
    }
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  return new Uint8Array(out);
}
