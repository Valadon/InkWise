import { Parser } from 'htmlparser2';

/**
 * Turns Readwise's `html_content` into well-formed XHTML for an EPUB.
 *
 * The text itself is never rewritten: no smart quotes, no whitespace collapsing,
 * no hyphenation. Highlights only reach Readwise if the selected text matches the
 * source exactly, so the EPUB must carry the source text byte for byte.
 */

/** Tags kept as-is (with their filtered attributes). */
const KEEP = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'pre', 'code', 'figure', 'figcaption', 'img', 'a', 'em', 'strong', 'i', 'b', 'u', 's',
  'sub', 'sup', 'small', 'mark', 'q', 'cite', 'abbr', 'del', 'ins', 'kbd', 'samp', 'var',
  'br', 'hr', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption',
  'div', 'span', 'section', 'article', 'aside', 'header', 'footer', 'main', 'time',
]);

/** Tags dropped together with everything inside them. */
const DROP_WITH_CONTENT = new Set([
  'script', 'style', 'iframe', 'form', 'noscript', 'object', 'embed', 'template', 'button',
  'input', 'select', 'textarea', 'option', 'svg', 'math', 'canvas', 'audio', 'video',
  'source', 'track', 'picture-source', 'head', 'title', 'meta', 'link', 'frameset', 'frame',
  'dialog', 'map', 'area',
]);

const VOID = new Set(['img', 'br', 'hr', 'wbr']);

/** Generic containers that are unwrapped rather than split when they land in phrasing content. */
const CONTAINER = new Set(['div', 'section', 'article', 'aside', 'header', 'footer', 'main']);

/** Block-level tags; used to keep blocks from ending up inside a <p>. */
const BLOCK = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'pre', 'figure', 'figcaption', 'hr', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  'caption', 'div', 'section', 'article', 'aside', 'header', 'footer', 'main',
]);

/** Elements whose content model only allows phrasing content. */
const PHRASING_ONLY = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'dt', 'caption', 'span', 'a', 'em', 'strong', 'i', 'b', 'u', 's', 'sub', 'sup', 'small', 'mark', 'q', 'cite', 'abbr', 'code', 'kbd', 'samp', 'var', 'time']);

const ALLOWED_ATTRS: Record<string, string[]> = {
  a: ['href', 'title'],
  img: ['src', 'alt', 'title'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan', 'scope'],
  ol: ['start', 'reversed', 'type'],
  li: ['value'],
  blockquote: ['cite'],
  q: ['cite'],
  abbr: ['title'],
  time: ['datetime'],
  del: ['datetime'],
  ins: ['datetime'],
};

export interface CleanOptions {
  /** Base URL for resolving relative links and images (Reader's `source_url`). */
  baseUrl?: string | null;
  /**
   * Maps an absolute image URL to the path used inside the EPUB.
   * Images without an entry are replaced by their alt text.
   */
  imageMap?: Map<string, string>;
  /** Keep <img> tags at all. When false every image becomes alt text. */
  includeImages?: boolean;
}

export interface CleanResult {
  xhtml: string;
  /** Absolute URLs of every image referenced by the content, in order, deduped. */
  imageUrls: string[];
}

export function cleanHtml(html: string, opts: CleanOptions = {}): CleanResult {
  const out: string[] = [];
  /** Every open source element; `tag` is what we emitted for it, or null if it was unwrapped. */
  const open: { name: string; tag: string | null }[] = [];
  const imageUrls: string[] = [];
  const seenImages = new Set<string>();
  let dropDepth = 0;
  const includeImages = opts.includeImages ?? true;

  const emitted = () => open.filter((e) => e.tag !== null).map((e) => e.tag as string);
  const insideEmitted = (tag: string) => open.some((e) => e.tag === tag);
  const insidePhrasingOnly = () => open.some((e) => e.tag !== null && PHRASING_ONLY.has(e.tag));

  /** Close emitted elements from the innermost outward until (and including) entry `idx`. */
  const closeFrom = (idx: number) => {
    for (let i = open.length - 1; i >= idx; i--) {
      const e = open[i]!;
      if (e.tag !== null) {
        out.push(`</${e.tag}>`);
        e.tag = null;
      }
    }
  };

  const parser = new Parser(
    {
      onopentag(rawName, attribs) {
        const name = rawName.toLowerCase();
        if (dropDepth > 0) {
          if (DROP_WITH_CONTENT.has(name) && !isSelfClosingDropped(name)) dropDepth++;
          return;
        }
        if (DROP_WITH_CONTENT.has(name)) {
          if (!isSelfClosingDropped(name)) dropDepth++;
          return;
        }
        if (name === 'img') {
          emitImage(attribs);
          return;
        }
        if (VOID.has(name)) {
          if (name === 'hr' && insidePhrasingOnly()) return;
          out.push(`<${name} />`);
          return;
        }
        let tag: string | null = KEEP.has(name) ? name : null;
        if (tag === 'a') {
          const href = safeHref(attribs.href, opts.baseUrl);
          if (!href || insideEmitted('a')) tag = null;
          else attribs = { ...attribs, href };
        }
        if (tag && BLOCK.has(tag) && insidePhrasingOnly()) {
          if (CONTAINER.has(tag)) {
            tag = null; // a <div> inside a <p> just disappears
          } else {
            // Close the phrasing-only ancestors so the block can start cleanly.
            const first = open.findIndex((e) => e.tag !== null && PHRASING_ONLY.has(e.tag));
            closeFrom(first);
          }
        }
        if (tag === 'li' && !insideEmitted('ul') && !insideEmitted('ol')) tag = 'p';
        if ((tag === 'td' || tag === 'th' || tag === 'tr') && !insideEmitted('table')) tag = null;
        if (tag) out.push(`<${tag}${renderAttrs(tag, attribs)}>`);
        open.push({ name, tag });
      },
      ontext(text) {
        if (dropDepth > 0) return;
        out.push(escapeText(text));
      },
      onclosetag(rawName) {
        const name = rawName.toLowerCase();
        if (dropDepth > 0) {
          if (DROP_WITH_CONTENT.has(name) && !isSelfClosingDropped(name)) dropDepth--;
          return;
        }
        if (DROP_WITH_CONTENT.has(name) || VOID.has(name)) return;
        let idx = -1;
        for (let i = open.length - 1; i >= 0; i--) {
          if (open[i]!.name === name) {
            idx = i;
            break;
          }
        }
        if (idx === -1) return;
        closeFrom(idx);
        open.splice(idx);
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true, recognizeSelfClosing: true },
  );

  function emitImage(attribs: Record<string, string>) {
    const src = resolveUrl(attribs.src ?? attribs['data-src'] ?? '', opts.baseUrl);
    const alt = (attribs.alt ?? '').trim();
    if (src && /^https?:/i.test(src) && !seenImages.has(src)) {
      seenImages.add(src);
      imageUrls.push(src);
    }
    const local = includeImages && src ? opts.imageMap?.get(src) : undefined;
    if (local) {
      out.push(`<img src="${escapeAttr(local)}" alt="${escapeAttr(alt)}" />`);
    } else if (alt) {
      out.push(`<span class="img-alt">[Image: ${escapeText(alt)}]</span>`);
    }
  }

  parser.write(html);
  parser.end();
  closeFrom(0);
  void emitted;
  return { xhtml: out.join(''), imageUrls };
}

/** Collect image URLs without producing output (used to plan downloads). */
export function extractImageUrls(html: string, baseUrl?: string | null): string[] {
  return cleanHtml(html, { baseUrl, includeImages: false }).imageUrls;
}

function isSelfClosingDropped(name: string) {
  return name === 'input' || name === 'meta' || name === 'link' || name === 'source' || name === 'track' || name === 'area' || name === 'embed';
}

function renderAttrs(tag: string, attribs: Record<string, string>): string {
  const allowed = ALLOWED_ATTRS[tag];
  if (!allowed) return '';
  let s = '';
  for (const key of allowed) {
    const v = attribs[key];
    if (v === undefined) continue;
    if (key === 'reversed') {
      s += ' reversed="reversed"';
      continue;
    }
    if ((key === 'colspan' || key === 'rowspan' || key === 'start' || key === 'value') && !/^-?\d+$/.test(v.trim())) continue;
    s += ` ${key}="${escapeAttr(v)}"`;
  }
  return s;
}

function safeHref(href: string | undefined, base?: string | null): string | null {
  if (!href) return null;
  const trimmed = href.trim();
  if (trimmed.startsWith('#')) return null; // in-page anchors point at ids we strip
  const abs = resolveUrl(trimmed, base);
  if (!abs) return null;
  if (/^(https?:|mailto:)/i.test(abs)) return abs;
  return null;
}

/** Minimal URL resolution; React Native's URL implementation is incomplete. */
export function resolveUrl(href: string, base?: string | null): string {
  const h = href.trim();
  if (!h) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(h)) return h;
  if (!base) return h.startsWith('//') ? `https:${h}` : '';
  const m = /^([a-z][a-z0-9+.-]*:)\/\/([^/?#]*)([^?#]*)/i.exec(base);
  if (!m) return '';
  const [, scheme, host, path = '/'] = m;
  if (h.startsWith('//')) return `${scheme}${h}`;
  if (h.startsWith('/')) return `${scheme}//${host}${h}`;
  if (h.startsWith('?') || h.startsWith('#')) return `${scheme}//${host}${path}${h}`;
  const dir = path.replace(/[^/]*$/, '') || '/';
  const parts = `${dir}${h}`.split('/');
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '..') {
      if (resolved.length > 1) resolved.pop();
    } else if (part !== '.') {
      resolved.push(part);
    }
  }
  let joined = resolved.join('/');
  if (!joined.startsWith('/')) joined = `/${joined}`;
  return `${scheme}//${host}${joined}`;
}

export function escapeText(s: string): string {
  return stripInvalidXmlChars(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, '&quot;');
}

/** XML 1.0 forbids most control characters; they occasionally show up in scraped pages. */
function stripInvalidXmlChars(s: string): string {
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '');
}
