import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { findLoose } from './highlights.js';
import { HIGHLIGHT_BLOCK_CLASS, HIGHLIGHT_CLASS, MARKABLE_BLOCKS as BLOCK_TAGS, highlightCss, type HighlightStyle } from './markStyle.js';

/**
 * Shows Readwise highlights inside an Inkwise EPUB. The Supernote plugin SDK
 * can't add a highlight to a DOC page, so Inkwise wraps the passage in a styled
 * span in the EPUB itself, and tags the paragraphs it touches. No characters
 * are added, moved or removed; how it looks is up to the CSS (markStyle.ts).
 */

/** An Inkwise highlight rule from any version, so an old one can be replaced. */
const HIGHLIGHT_RULE = new RegExp(`^(?:span\\.${HIGHLIGHT_CLASS}|[a-z0-9]*\\.${HIGHLIGHT_BLOCK_CLASS})\\s*\\{[^}]*\\}[ \\t]*\\n?`, 'gm');

const OPEN_MARK = `<span class="${HIGHLIGHT_CLASS}">`;
const TEXT_FILE = /\.(x?html?|css|opf|ncx|xml|txt|svg)$/i;
const BLOCK_ATTR = ` class="${HIGHLIGHT_BLOCK_CLASS}"`;

const MARKABLE_BLOCKS = new Set(BLOCK_TAGS);

/** Tags after which text on either side reads as separate words. */
const BREAKING_TAGS = new Set([
  'p', 'div', 'li', 'ul', 'ol', 'dl', 'dt', 'dd', 'blockquote', 'pre', 'figure', 'figcaption',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  'caption', 'section', 'article', 'aside', 'header', 'footer', 'main', 'br', 'hr', 'img',
]);

/** Text inside these is never highlighted. */
const NO_MARK_INSIDE = new Set(['head', 'title', 'style', 'script']);

export interface MarkResult {
  xhtml: string;
  /** How many of the highlights were found and marked. */
  marked: number;
  /** Highlights that couldn't be found in the text. */
  missing: string[];
}

interface TextToken {
  kind: 'text';
  raw: string;
  /** Decoded characters, and the raw [start, end) each came from. */
  plain: string;
  rawStart: number[];
  rawEnd: number[];
  eligible: boolean;
}

type Token = TextToken | { kind: 'tag'; raw: string };

/**
 * Wrap each highlight's passage in `<span class="rw-hl">`. Existing Inkwise
 * marks are removed first, so calling this again with the full list is safe.
 */
export function markHighlights(xhtml: string, highlights: string[]): MarkResult {
  const tokens = tokenize(stripMarks(xhtml));
  const blockOf = innermostBlocks(tokens);

  // Join eligible text into one string, with a space where a block boundary
  // separated two runs. `owner[i]` says which token and character produced it.
  let plain = '';
  const owner: ({ token: number; index: number } | null)[] = [];
  let pendingBreak = false;
  tokens.forEach((t, ti) => {
    if (t.kind === 'tag') {
      const name = tagName(t.raw);
      if (name && BREAKING_TAGS.has(name)) pendingBreak = true;
      return;
    }
    if (!t.eligible) return;
    if (pendingBreak && plain && !/\s$/.test(plain)) {
      plain += ' ';
      owner.push(null);
    }
    pendingBreak = false;
    for (let i = 0; i < t.plain.length; i++) {
      plain += t.plain[i];
      owner.push({ token: ti, index: i });
    }
  });

  /** Per token: plain-character ranges to wrap. */
  const wraps = new Map<number, [number, number][]>();
  /** Opening tags of the blocks to tag. */
  const blocks = new Set<number>();
  let marked = 0;
  const missing: string[] = [];
  for (const h of dedupe(highlights)) {
    const range = findLoose(h, plain);
    if (!range) {
      missing.push(h);
      continue;
    }
    marked++;
    for (let i = range.start; i < range.end; i++) {
      const o = owner[i];
      if (!o) continue;
      const block = blockOf.get(o.token);
      if (block !== undefined && !/\s/.test(plain[i]!)) blocks.add(block);
      const list = wraps.get(o.token) ?? [];
      const last = list[list.length - 1];
      if (last && last[1] === o.index) last[1] = o.index + 1;
      else list.push([o.index, o.index + 1]);
      wraps.set(o.token, list);
    }
  }

  const out = tokens.map((t, ti) => {
    if (t.kind === 'tag') return blocks.has(ti) ? addBlockClass(t.raw) : t.raw;
    const list = wraps.get(ti);
    return list ? wrapToken(t, mergeRanges(list)) : t.raw;
  });
  return { xhtml: out.join(''), marked, missing };
}

/** For each text token, the opening tag of the innermost markable block around it. */
function innermostBlocks(tokens: Token[]): Map<number, number> {
  const out = new Map<number, number>();
  const stack: { name: string; token: number }[] = [];
  tokens.forEach((t, ti) => {
    if (t.kind === 'text') {
      const top = stack[stack.length - 1];
      if (top) out.set(ti, top.token);
      return;
    }
    const name = tagName(t.raw);
    if (!name || !MARKABLE_BLOCKS.has(name) || t.raw.endsWith('/>')) return;
    if (!t.raw.startsWith('</')) {
      stack.push({ name, token: ti });
      return;
    }
    const at = stack.map((b) => b.name).lastIndexOf(name);
    if (at >= 0) stack.length = at;
  });
  return out;
}

/** Add the block class to an opening tag, merging with a class it already has. */
function addBlockClass(tag: string): string {
  const cls = /\sclass\s*=\s*(["'])(.*?)\1/.exec(tag);
  if (!cls) return tag.replace(/^<[a-zA-Z][a-zA-Z0-9]*/, (open) => open + BLOCK_ATTR);
  const names = cls[2]!.split(/\s+/).filter(Boolean);
  if (names.includes(HIGHLIGHT_BLOCK_CLASS)) return tag;
  return tag.replace(cls[0], ` class=${cls[1]}${[...names, HIGHLIGHT_BLOCK_CLASS].join(' ')}${cls[1]}`);
}

function wrapToken(t: TextToken, ranges: [number, number][]): string {
  let s = '';
  let pos = 0;
  for (const [a, b] of ranges) {
    // Leave whitespace at the edges outside the mark.
    let start = a;
    let end = b;
    while (start < end && /\s/.test(t.plain[start]!)) start++;
    while (end > start && /\s/.test(t.plain[end - 1]!)) end--;
    if (start === end) continue;
    const rawA = t.rawStart[start]!;
    const rawB = t.rawEnd[end - 1]!;
    s += t.raw.slice(pos, rawA) + OPEN_MARK + t.raw.slice(rawA, rawB) + '</span>';
    pos = rawB;
  }
  return s + t.raw.slice(pos);
}

function mergeRanges(list: [number, number][]): [number, number][] {
  const sorted = [...list].sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

function dedupe(list: string[]): string[] {
  return [...new Set(list.map((h) => h.trim()).filter(Boolean))];
}

/** Remove Inkwise's own highlight spans and paragraph tags, keeping their text. */
export function stripMarks(xhtml: string): string {
  if (xhtml.includes(HIGHLIGHT_BLOCK_CLASS)) {
    xhtml = xhtml.replace(/<[a-zA-Z][^>]*>/g, (tag) =>
      !tag.includes(HIGHLIGHT_BLOCK_CLASS)
        ? tag
        : tag
            .replace(BLOCK_ATTR, '')
            .replace(new RegExp(`(\\sclass\\s*=\\s*(["'])[^"']*?)\\s+${HIGHLIGHT_BLOCK_CLASS}(?=[\\s"'])`), '$1'),
    );
  }
  if (!xhtml.includes(OPEN_MARK)) return xhtml;
  const stack: boolean[] = [];
  return xhtml.replace(/<\/?span\b[^>]*>/g, (tag) => {
    if (tag.startsWith('</')) return stack.pop() ? '' : tag;
    const ours = tag === OPEN_MARK;
    stack.push(ours);
    return ours ? '' : tag;
  });
}

function tagName(raw: string): string | null {
  const m = /^<\/?([a-zA-Z][a-zA-Z0-9]*)/.exec(raw);
  return m ? m[1]!.toLowerCase() : null;
}

function tokenize(xhtml: string): Token[] {
  const tokens: Token[] = [];
  let inBody = false;
  let blocked = 0;
  /** Inside Inkwise's own title block, which isn't article text. */
  let inTitleBlock = false;
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]*>|[^<]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xhtml))) {
    const raw = m[0];
    if (raw.startsWith('<')) {
      tokens.push({ kind: 'tag', raw });
      const name = tagName(raw);
      if (!name) continue;
      const closing = raw.startsWith('</');
      const selfClosing = raw.endsWith('/>');
      if (name === 'body') inBody = !closing;
      if (name === 'header' && !closing && raw.includes('inkwise-header')) inTitleBlock = true;
      else if (name === 'header' && closing) inTitleBlock = false;
      if (NO_MARK_INSIDE.has(name) && !selfClosing) blocked += closing ? -1 : 1;
      continue;
    }
    tokens.push(decodeText(raw, inBody && blocked <= 0 && !inTitleBlock));
  }
  return tokens;
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeText(raw: string, eligible: boolean): TextToken {
  let plain = '';
  const rawStart: number[] = [];
  const rawEnd: number[] = [];
  let i = 0;
  while (i < raw.length) {
    let ch = raw[i]!;
    let len = 1;
    if (ch === '&') {
      const m = /^&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/.exec(raw.slice(i, i + 12));
      if (m) {
        const body = m[1]!;
        if (body[0] === '#') {
          const code = body[1] === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
          ch = String.fromCodePoint(code);
        } else {
          ch = NAMED[body] ?? m[0];
        }
        len = m[0].length;
      }
    }
    for (const unit of splitUnits(ch)) {
      plain += unit;
      rawStart.push(i);
      rawEnd.push(i + len);
    }
    i += len;
  }
  return { kind: 'text', raw, plain, rawStart, rawEnd, eligible };
}

/** UTF-16 code units, so `plain[i]` and the offset arrays stay aligned. */
function splitUnits(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) out.push(s[i]!);
  return out;
}

/**
 * Apply highlights to every content document in an EPUB and make sure its
 * stylesheet can show them. Returns null when the bytes aren't a readable EPUB.
 */
export function markEpub(
  bytes: Uint8Array,
  highlights: string[],
  style?: HighlightStyle,
): { bytes: Uint8Array; marked: number; missing: string[] } | null {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    return null;
  }
  if (!files.mimetype) return null;
  const content = Object.keys(files).filter((n) => /\.x?html?$/i.test(n) && !/(^|\/)nav\.xhtml$/i.test(n));
  if (!content.length) return null;

  let marked = 0;
  let missing = dedupe(highlights);
  for (const name of content) {
    // Each highlight is looked for in every document, and counts as found once.
    const r = markHighlights(strFromU8(files[name]!), highlights);
    files[name] = strToU8(r.xhtml);
    missing = missing.filter((h) => r.missing.includes(h));
  }
  marked = dedupe(highlights).length - missing.length;

  // Swap in the current rules for whatever an older build (or style) wrote.
  for (const name of Object.keys(files).filter((n) => n.endsWith('.css'))) {
    const rest = strFromU8(files[name]!).replace(HIGHLIGHT_RULE, '');
    files[name] = strToU8(rest + (rest === '' || rest.endsWith('\n') ? '' : '\n') + highlightCss(style));
  }

  // The mimetype entry must come first and be stored uncompressed. Images are
  // already compressed, and deflating them again is most of the work on a
  // tablet's CPU, so they're stored as they are.
  const ordered: Record<string, any> = { mimetype: [files.mimetype, { level: 0 }] };
  for (const [name, data] of Object.entries(files)) {
    if (name !== 'mimetype') ordered[name] = TEXT_FILE.test(name) ? data : [data, { level: 0 }];
  }
  return { bytes: zipSync(ordered, { level: 6 }), marked, missing };
}
