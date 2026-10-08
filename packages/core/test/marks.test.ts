import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildEpub, markEpub, markHighlights, stripMarks } from '../src/index.js';
import { fixture } from './helpers.js';

const page = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>A title here</title></head><body><header class="inkwise-header"><h1>A title here</h1></header>${body}</body></html>`;

describe('markHighlights', () => {
  it('wraps a passage without changing any text', () => {
    const src = page('<p>One two three. Four five six.</p>');
    const r = markHighlights(src, ['Four five six.']);
    expect(r.marked).toBe(1);
    expect(r.xhtml).toContain('<p>One two three. <span class="rw-hl">Four five six.</span></p>');
    expect(stripMarks(r.xhtml)).toBe(src);
  });

  it('marks across inline tags and paragraphs, one span per text run', () => {
    const r = markHighlights(page('<p>Start <em>middle</em> end.</p><p>Next para here.</p>'), ['middle end. Next para']);
    expect(r.xhtml).toContain('<em><span class="rw-hl">middle</span></em> <span class="rw-hl">end.</span>');
    expect(r.xhtml).toContain('<p><span class="rw-hl">Next para</span> here.</p>');
  });

  it('matches curly quotes, entities and dashes loosely', () => {
    const r = markHighlights(page('<p>He said “it&#8217;s fine” — then &amp; now.</p>'), ['"it\'s fine" - then & now']);
    expect(r.marked).toBe(1);
    expect(r.xhtml).toContain('<span class="rw-hl">“it&#8217;s fine” — then &amp; now</span>.');
  });

  it('ignores the title block and reports what it could not find', () => {
    const r = markHighlights(page('<p>Body text.</p>'), ['A title here', 'Body text.']);
    expect(r.missing).toEqual(['A title here']);
    expect(r.xhtml).toContain('<h1>A title here</h1>');
  });

  it('is idempotent', () => {
    const once = markHighlights(page('<p>Alpha beta gamma.</p>'), ['beta']).xhtml;
    expect(markHighlights(once, ['beta']).xhtml).toBe(once);
  });
});

describe('markEpub', () => {
  it('shades highlights inside a built EPUB and keeps it a valid zip', () => {
    const doc = fixture('longform');
    const plain = buildEpub(doc, { modified: new Date('2026-10-08T00:00:00Z') });
    const sentence = 'None of this is new.';
    const r = markEpub(plain.bytes, [sentence, 'not in the article at all'])!;
    expect(r.marked).toBe(1);
    expect(r.missing).toEqual(['not in the article at all']);
    const files = unzipSync(r.bytes);
    expect(Object.keys(files)[0]).toBe('mimetype');
    expect(strFromU8(files['OEBPS/article.xhtml']!)).toContain(`<span class="rw-hl">${sentence}</span>`);
    expect(strFromU8(files['OEBPS/style.css']!)).toContain('span.rw-hl');
  });

  it('returns null for something that is not an EPUB', () => {
    expect(markEpub(new Uint8Array([1, 2, 3]), ['x'])).toBeNull();
  });
});
