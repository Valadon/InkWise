import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { markHighlights } from './marks.js';
import { cleanHtml, escapeAttr, escapeText } from './html.js';
import type { ReaderDocument } from './types.js';

export interface EpubImage {
  /** Path inside OEBPS, e.g. `images/img-1.jpg`. */
  path: string;
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/svg+xml' | 'image/webp';
  data: Uint8Array;
}

export interface BuildEpubOptions {
  /** Downloaded images keyed by their absolute source URL. */
  images?: Map<string, EpubImage>;
  includeImages?: boolean;
  /** Timestamp for `dcterms:modified`. Pass a fixed value in tests for reproducible output. */
  modified?: Date;
  language?: string;
  /** Highlight texts to shade in the article (see marks.ts). */
  highlights?: string[];
}

export interface BuiltEpub {
  filename: string;
  bytes: Uint8Array;
  /** Image URLs referenced by the article (whether or not they were embedded). */
  imageUrls: string[];
}

export const EPUB_CSS = `html, body { margin: 0; padding: 0; }
body { line-height: 1.6; }
.inkwise-header { margin: 0 0 1.5em 0; padding-bottom: 0.8em; border-bottom: 1px solid #000; }
.inkwise-header h1 { font-size: 1.6em; line-height: 1.25; margin: 0 0 0.4em 0; }
.inkwise-header p { margin: 0.15em 0; font-size: 0.85em; }
.inkwise-source { word-break: break-all; }
h1, h2, h3, h4, h5, h6 { line-height: 1.3; margin: 1.2em 0 0.5em 0; page-break-after: avoid; }
p { margin: 0 0 0.9em 0; }
blockquote { margin: 1em 0 1em 1em; padding-left: 0.8em; border-left: 3px solid #000; }
pre { white-space: pre-wrap; word-wrap: break-word; font-size: 0.85em; border: 1px solid #000; padding: 0.5em; }
code { font-size: 0.9em; }
img { max-width: 100%; height: auto; }
figure { margin: 1em 0; text-align: center; }
span.rw-hl { background-color: #d2d2d2; }
figcaption { font-size: 0.85em; font-style: italic; }
table { border-collapse: collapse; max-width: 100%; font-size: 0.85em; }
td, th { border: 1px solid #000; padding: 0.2em 0.4em; vertical-align: top; }
a { color: inherit; text-decoration: underline; }
.img-alt { font-style: italic; }
`;

const MAX_TITLE_CHARS = 80;

/** `<sanitized-title>__<readwise-id>.epub`, safe for Android, Windows and the Supernote file browser. */
export function epubFilename(doc: Pick<ReaderDocument, 'id' | 'title'>): string {
  const title = sanitizeTitle(doc.title ?? '') || 'Untitled';
  return `${title}__${doc.id}.epub`;
}

export function sanitizeTitle(title: string): string {
  const cleaned = title
    .normalize('NFKC')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\u2018\u2019\u201C\u201D]/g, '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[\\/:*?"<>|#%&{}$!'`@=+^~[\];,]/g, '')
    .replace(/__+/g, '_')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return truncate(cleaned, MAX_TITLE_CHARS).replace(/[-.]+$/g, '');
}

function truncate(s: string, max: number): string {
  const chars = [...s];
  return chars.length <= max ? s : chars.slice(0, max).join('');
}

/** The Readwise id embedded in an Inkwise filename (or a full path), if any. */
export function idFromFilename(pathOrName: string): string | null {
  const name = pathOrName.split(/[\\/]/).pop() ?? '';
  // Reader ids are 20+ lowercase letters and digits (ULID-style). Requiring that
  // shape keeps names like "Moby_Dick__gutenberg.epub" from looking like ours.
  const m = /__([0-9a-z]{20,40})\.epub$/.exec(name);
  return m ? m[1]! : null;
}

export function formatPublishedDate(value: ReaderDocument['published_date']): string | null {
  if (value === null || value === undefined || value === '') return null;
  let d: Date;
  if (typeof value === 'number') d = new Date(value < 1e12 ? value * 1000 : value);
  else if (/^\d+$/.test(value)) {
    const n = Number(value);
    d = new Date(n < 1e12 ? n * 1000 : n);
  } else d = new Date(value);
  if (Number.isNaN(d.getTime())) return typeof value === 'string' ? value : null;
  return d.toISOString().slice(0, 10);
}

function readingTime(doc: ReaderDocument): string | null {
  if (typeof doc.reading_time === 'string' && doc.reading_time.trim()) return doc.reading_time.trim();
  if (typeof doc.reading_time === 'number') return `${doc.reading_time} min`;
  if (doc.word_count) return `${Math.max(1, Math.round(doc.word_count / 230))} min`;
  return null;
}

/** Article HTML for the EPUB: a metadata header followed by the cleaned Readwise content. */
export function renderArticleXhtml(doc: ReaderDocument, bodyXhtml: string, language = 'en'): string {
  const title = doc.title?.trim() || 'Untitled';
  const lines: string[] = [];
  if (doc.author) lines.push(`<p class="inkwise-author">${escapeText(doc.author)}</p>`);
  const meta = [doc.site_name, formatPublishedDate(doc.published_date), readingTime(doc)].filter(
    (x): x is string => !!x && String(x).trim().length > 0,
  );
  if (meta.length) lines.push(`<p class="inkwise-meta">${meta.map(escapeText).join(' · ')}</p>`);
  const source = doc.source_url || doc.url;
  if (source) lines.push(`<p class="inkwise-source">${escapeText(source)}</p>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${escapeAttr(language)}" xml:lang="${escapeAttr(language)}">
<head>
<meta charset="UTF-8" />
<title>${escapeText(title)}</title>
<link rel="stylesheet" type="text/css" href="style.css" />
</head>
<body>
<section epub:type="chapter" id="article">
<header class="inkwise-header">
<h1>${escapeText(title)}</h1>
${lines.join('\n')}
</header>
<div class="inkwise-content">${bodyXhtml}</div>
</section>
</body>
</html>
`;
}

function withHighlights(xhtml: string, highlights?: string[]): string {
  return highlights?.length ? markHighlights(xhtml, highlights).xhtml : xhtml;
}

export function buildEpub(doc: ReaderDocument, opts: BuildEpubOptions = {}): BuiltEpub {
  const language = opts.language ?? 'en';
  const includeImages = opts.includeImages ?? true;
  const images = includeImages ? opts.images ?? new Map<string, EpubImage>() : new Map<string, EpubImage>();
  const imageMap = new Map<string, string>();
  for (const [url, img] of images) imageMap.set(url, img.path);

  const html = doc.html_content ?? (doc.content ? `<p>${escapeText(doc.content)}</p>` : '');
  const cleaned = cleanHtml(html, { baseUrl: doc.source_url || doc.url, imageMap, includeImages });
  const body = cleaned.xhtml.trim() ? cleaned.xhtml : '<p>(Readwise did not return any content for this document.)</p>';

  const title = doc.title?.trim() || 'Untitled';
  const modified = (opts.modified ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const uid = `urn:readwise:${doc.id}`;
  const usedImages = [...images.values()].filter((img) => cleaned.xhtml.includes(`src="${escapeAttr(img.path)}"`));

  const manifestImages = usedImages
    .map((img, i) => `    <item id="img${i + 1}" href="${escapeAttr(img.path)}" media-type="${img.mediaType}" />`)
    .join('\n');

  const published = formatPublishedDate(doc.published_date);
  const source = doc.source_url || doc.url;
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid" xml:lang="${escapeAttr(language)}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">${escapeText(uid)}</dc:identifier>
    <dc:title>${escapeText(title)}</dc:title>
    <dc:language>${escapeText(language)}</dc:language>
${doc.author ? `    <dc:creator>${escapeText(doc.author)}</dc:creator>\n` : ''}${source ? `    <dc:source>${escapeText(source)}</dc:source>\n` : ''}${published && /^\d{4}-\d{2}-\d{2}$/.test(published) ? `    <dc:date>${published}</dc:date>\n` : ''}${doc.site_name ? `    <dc:publisher>${escapeText(doc.site_name)}</dc:publisher>\n` : ''}    <meta property="dcterms:modified">${modified}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml" />
    <item id="css" href="style.css" media-type="text/css" />
    <item id="article" href="article.xhtml" media-type="application/xhtml+xml" />
${manifestImages ? `${manifestImages}\n` : ''}  </manifest>
  <spine toc="ncx">
    <itemref idref="article" />
  </spine>
</package>
`;

  const nav = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${escapeAttr(language)}" xml:lang="${escapeAttr(language)}">
<head>
<meta charset="UTF-8" />
<title>${escapeText(title)}</title>
</head>
<body>
<nav epub:type="toc" id="toc">
<h1>Contents</h1>
<ol>
<li><a href="article.xhtml">${escapeText(title)}</a></li>
</ol>
</nav>
</body>
</html>
`;

  const ncx = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="${escapeAttr(uid)}" />
    <meta name="dtb:depth" content="1" />
    <meta name="dtb:totalPageCount" content="0" />
    <meta name="dtb:maxPageNumber" content="0" />
  </head>
  <docTitle><text>${escapeText(title)}</text></docTitle>
  <navMap>
    <navPoint id="article" playOrder="1">
      <navLabel><text>${escapeText(title)}</text></navLabel>
      <content src="article.xhtml" />
    </navPoint>
  </navMap>
</ncx>
`;

  const container = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml" />
  </rootfiles>
</container>
`;

  // Insertion order matters: `mimetype` must be the first entry and stored uncompressed.
  const files: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {
    mimetype: [strToU8('application/epub+zip'), { level: 0 }],
    'META-INF/container.xml': strToU8(container),
    'OEBPS/content.opf': strToU8(opf),
    'OEBPS/nav.xhtml': strToU8(nav),
    'OEBPS/toc.ncx': strToU8(ncx),
    'OEBPS/style.css': strToU8(EPUB_CSS),
    'OEBPS/article.xhtml': strToU8(withHighlights(renderArticleXhtml(doc, body, language), opts.highlights)),
  };
  for (const img of usedImages) files[`OEBPS/${img.path}`] = [img.data, { level: 0 }];

  const bytes = zipSync(files as any, { level: 9, mtime: opts.modified ?? new Date('2020-01-01T00:00:00Z') });
  return { filename: epubFilename(doc), bytes, imageUrls: cleaned.imageUrls };
}

/** Read `dc:identifier` from an EPUB's package document (fallback for renamed files). */
export function epubIdentifier(bytes: Uint8Array): string | null {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, { filter: (f) => f.name === 'META-INF/container.xml' || f.name.endsWith('.opf') });
  } catch {
    return null;
  }
  const container = files['META-INF/container.xml'];
  let opfPath: string | undefined;
  if (container) opfPath = /full-path="([^"]+)"/.exec(strFromU8(container))?.[1];
  const opf = (opfPath && files[opfPath]) || Object.entries(files).find(([n]) => n.endsWith('.opf'))?.[1];
  if (!opf) return null;
  const m = /<dc:identifier[^>]*>([^<]+)<\/dc:identifier>/.exec(strFromU8(opf));
  return m ? m[1]!.trim() : null;
}
