import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildEpub, epubFilename, epubIdentifier, formatPublishedDate, idFromFilename, sanitizeTitle } from '../src/index.js';
import { TINY_PNG } from '../src/testing/fake-readwise.js';
import { fixture, loadFixtures } from './helpers.js';

describe('filenames', () => {
  it('sanitizes titles and appends the Readwise id', () => {
    expect(epubFilename({ id: 'abc123', title: 'The Quiet Page: Reading on E‑Ink' })).toBe('The-Quiet-Page-Reading-on-E-Ink__abc123.epub');
    expect(epubFilename({ id: 'x1', title: '  ' })).toBe('Untitled__x1.epub');
    expect(epubFilename({ id: 'x1', title: null })).toBe('Untitled__x1.epub');
    expect(sanitizeTitle('a/b\\c:d*e?f"g<h>i|j')).toBe('abcdefghij');
    expect(sanitizeTitle('x'.repeat(200)).length).toBe(80);
    expect(sanitizeTitle('Double__underscore')).toBe('Double_underscore');
  });
  it('reads the id back from a filename or path', () => {
    expect(idFromFilename('/storage/emulated/0/Document/Inkwise/Some-Title__01abcDEF.epub')).toBe('01abcDEF');
    expect(idFromFilename('Some-Title.epub')).toBeNull();
    expect(idFromFilename('notes.pdf')).toBeNull();
  });
});

describe('formatPublishedDate', () => {
  it('handles date strings, ISO strings, epoch ms and seconds', () => {
    expect(formatPublishedDate('2026-09-28')).toBe('2026-09-28');
    expect(formatPublishedDate('2026-10-05T09:00:00+00:00')).toBe('2026-10-05');
    expect(formatPublishedDate(1759190400000)).toBe('2025-09-30');
    expect(formatPublishedDate(1759190400)).toBe('2025-09-30');
    expect(formatPublishedDate(null)).toBeNull();
  });
});

describe('buildEpub', () => {
  const modified = new Date('2026-10-08T00:00:00Z');

  it('writes mimetype first and uncompressed', () => {
    const { bytes } = buildEpub(fixture('longform'), { modified });
    // Local file header: name at offset 30, compression method at offset 8 (0 = stored).
    expect(strFromU8(bytes.slice(30, 38))).toBe('mimetype');
    expect(bytes[8]).toBe(0);
    expect(strFromU8(bytes.slice(38, 58))).toBe('application/epub+zip');
  });

  it('includes metadata, nav, ncx and the untouched article text', () => {
    const doc = fixture('longform');
    const { bytes, filename } = buildEpub(doc, { modified });
    expect(filename).toBe(`The-Quiet-Page-Reading-on-E-Ink-in-a-Loud-World__${doc.id}.epub`);
    const files = unzipSync(bytes);
    const opf = strFromU8(files['OEBPS/content.opf']!);
    expect(opf).toContain(`<dc:identifier id="uid">urn:readwise:${doc.id}</dc:identifier>`);
    expect(opf).toContain('<dc:creator>Ada Example</dc:creator>');
    expect(opf).toContain('<dc:source>https://example.com/essays/the-quiet-page</dc:source>');
    expect(opf).toContain('<dc:date>2026-09-28</dc:date>');
    expect(opf).toContain('<meta property="dcterms:modified">2026-10-08T00:00:00Z</meta>');
    expect(files['OEBPS/nav.xhtml']).toBeDefined();
    expect(files['OEBPS/toc.ncx']).toBeDefined();
    const article = strFromU8(files['OEBPS/article.xhtml']!);
    expect(article).toContain('“Read slowly,” my teacher said, “and the book will read you back.”');
    expect(article).toContain('texture — the small turns');
    expect(article).toContain('Example Essays · 2026-09-28 · 4 mins');
  });

  it('embeds downloaded images and lists them in the manifest', () => {
    const doc = fixture('images');
    const images = new Map([
      ['https://example.com/img/fog-1.png', { path: 'images/img-1.png', mediaType: 'image/png' as const, data: TINY_PNG }],
    ]);
    const { bytes } = buildEpub(doc, { images, modified });
    const files = unzipSync(bytes);
    expect(files['OEBPS/images/img-1.png']).toEqual(TINY_PNG);
    expect(strFromU8(files['OEBPS/content.opf']!)).toContain('href="images/img-1.png" media-type="image/png"');
  });

  it('is reproducible for a fixed timestamp', () => {
    const a = buildEpub(fixture('messy'), { modified });
    const b = buildEpub(fixture('messy'), { modified });
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
  });

  it('reads dc:identifier back out', () => {
    for (const doc of loadFixtures()) {
      expect(epubIdentifier(buildEpub(doc, { modified }).bytes)).toBe(`urn:readwise:${doc.id}`);
    }
    expect(epubIdentifier(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it('copes with a document that has no html', () => {
    const doc = { ...fixture('longform'), html_content: null, content: 'Plain <text> only' };
    const article = strFromU8(unzipSync(buildEpub(doc, { modified }).bytes)['OEBPS/article.xhtml']!);
    expect(article).toContain('<p>Plain &lt;text&gt; only</p>');
  });
});
