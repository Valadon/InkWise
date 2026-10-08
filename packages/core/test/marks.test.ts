import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildEpub, highlightCss, markEpub, markHighlights, stripMarks } from '../src/index.js';
import { fixture } from './helpers.js';

const page = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>A title here</title></head><body><header class="inkwise-header"><h1>A title here</h1></header>${body}</body></html>`;

describe('markHighlights', () => {
  it('wraps a passage without changing any text', () => {
    const src = page('<p>One two three. Four five six.</p>');
    const r = markHighlights(src, ['Four five six.']);
    expect(r.marked).toBe(1);
    expect(r.xhtml).toContain('<p class="rw-hl-block">One two three. <span class="rw-hl">Four five six.</span></p>');
    expect(stripMarks(r.xhtml)).toBe(src);
  });

  it('tags only the innermost paragraph-like block, never a wrapper', () => {
    const src = page('<div><p>Kept plain.</p><blockquote><p>Quoted words.</p></blockquote>Loose text.</div><ul><li value="2">Item text.</li></ul>');
    const r = markHighlights(src, ['Quoted words.', 'Loose text.', 'Item text.']);
    expect(r.marked).toBe(3);
    expect(r.xhtml).toContain('<p>Kept plain.</p><blockquote><p class="rw-hl-block">');
    expect(r.xhtml).toContain('<div><p>');
    expect(r.xhtml).toContain('<li class="rw-hl-block" value="2">');
    // Text straight inside a div gets the bold span but no paragraph mark.
    expect(r.xhtml).toContain('</blockquote><span class="rw-hl">Loose text.</span></div>');
    expect(stripMarks(r.xhtml)).toBe(src);
  });

  it('adds to an existing class instead of writing a second one', () => {
    const src = page('<p class="lede">Some lede.</p>');
    const r = markHighlights(src, ['Some lede.']);
    expect(r.xhtml).toContain('<p class="lede rw-hl-block">');
    expect(stripMarks(r.xhtml)).toBe(src);
  });

  it('marks across inline tags and paragraphs, one span per text run', () => {
    const r = markHighlights(page('<p>Start <em>middle</em> end.</p><p>Next para here.</p>'), ['middle end. Next para']);
    expect(r.xhtml).toContain('<em><span class="rw-hl">middle</span></em> <span class="rw-hl">end.</span>');
    expect(r.xhtml).toContain('<p class="rw-hl-block"><span class="rw-hl">Next para</span> here.</p>');
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
    expect(strFromU8(files['OEBPS/style.css']!)).toContain(highlightCss('both'));
  });

  it('writes the CSS for the chosen style', () => {
    const plain = buildEpub(fixture('longform'), { modified: new Date('2026-10-08T00:00:00Z') });
    const cssFor = (style: 'both' | 'bold' | 'paragraph') =>
      strFromU8(unzipSync(markEpub(plain.bytes, ['None of this is new.'], style)!.bytes)['OEBPS/style.css']!);
    expect(cssFor('bold')).toContain('span.rw-hl { font-weight: bold; }');
    expect(cssFor('bold')).not.toContain('.rw-hl-block');
    expect(cssFor('paragraph')).toContain('p.rw-hl-block { background-color: #d2d2d2; }');
    expect(cssFor('paragraph')).toContain('li.rw-hl-block { background-color: #d2d2d2; }');
    expect(cssFor('paragraph')).not.toContain('span.rw-hl');
    expect(cssFor('both')).toContain(highlightCss('both'));
  });

  it('swaps an older highlight rule for the current one, once', () => {
    const doc = fixture('longform');
    const files = unzipSync(buildEpub(doc, { modified: new Date('2026-10-08T00:00:00Z') }).bytes);
    const css = strFromU8(files['OEBPS/style.css']!);
    // What builds 0.2.8 and 0.2.9 wrote, in the middle of the stylesheet.
    files['OEBPS/style.css'] = strToU8(
      css.replace(highlightCss(), '').replace('figcaption {', 'span.rw-hl { background-color: #d2d2d2; text-decoration: underline; }\n.rw-hl-block { background-color: #d2d2d2; }\nfigcaption {'),
    );
    const old = zipSync({ mimetype: [files.mimetype!, { level: 0 }], ...files });
    const r = markEpub(old, ['None of this is new.'])!;
    const after = strFromU8(unzipSync(r.bytes)['OEBPS/style.css']!);
    expect(after.match(/span\.rw-hl/g)).toHaveLength(1);
    expect(after).not.toContain('underline; }\n');
    expect(after).not.toMatch(/^\.rw-hl-block/m);
    expect(after).toContain(highlightCss());
    expect(after).toContain('figcaption {');
    // Marking again leaves the stylesheet alone.
    expect(strFromU8(unzipSync(markEpub(r.bytes, ['None of this is new.'])!.bytes)['OEBPS/style.css']!)).toBe(after);
  });

  it('returns null for something that is not an EPUB', () => {
    expect(markEpub(new Uint8Array([1, 2, 3]), ['x'])).toBeNull();
  });
});
