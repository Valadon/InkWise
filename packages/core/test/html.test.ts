import { describe, expect, it } from 'vitest';
import { cleanHtml, resolveUrl } from '../src/index.js';
import { fixture } from './helpers.js';

describe('cleanHtml', () => {
  it('keeps text byte for byte (no smartening, no whitespace changes)', () => {
    const html = '<p>“Read slowly,”  he said — it’s  <em>fine</em>.</p>';
    expect(cleanHtml(html).xhtml).toBe('<p>“Read slowly,”  he said — it’s  <em>fine</em>.</p>');
  });

  it('strips scripts, styles, iframes, forms and event handlers', () => {
    const { xhtml } = cleanHtml(fixture('messy').html_content!, { baseUrl: 'https://news.example.org/2026/10/a-messy-page.html' });
    expect(xhtml).not.toMatch(/script|alert|iframe|<form|<input|<button|onclick|style=|svg text|Enable JS|Subscribe/);
    expect(xhtml).toContain('The first paragraph');
    expect(xhtml).toContain('with a div inside it');
    expect(xhtml).toContain('<a href="https://news.example.org/relative/link">relative link</a>');
    expect(xhtml).not.toContain('javascript:');
    expect(xhtml).toContain('a bad link');
    expect(xhtml).toContain('an anchor');
    expect(xhtml).not.toContain('#footnote');
    expect(xhtml).toContain('Old font tag');
    expect(xhtml).not.toContain('<font');
    expect(xhtml).not.toContain('\u0007');
    expect(xhtml).toContain('soft­hyphen');
  });

  it('produces well-formed markup for unclosed and misnested tags', () => {
    const { xhtml } = cleanHtml('<p>Unclosed <em>emphasis and <strong>strong<p>Next</p><li>orphan</li>');
    expect(isBalanced(xhtml)).toBe(true);
    expect(xhtml).toContain('<p>orphan</p>');
  });

  it('escapes text and keeps code blocks intact', () => {
    const { xhtml } = cleanHtml(fixture('code-and-tables').html_content!);
    expect(xhtml).toContain('return a &lt; b ? b + a : a + b; // &amp;&amp; done\n}');
    expect(xhtml).toContain('<th colspan="2">Value</th>');
    expect(xhtml).toContain('<td>3</td>'); // invalid colspan dropped
    expect(xhtml).not.toContain('class=');
    expect(isBalanced(xhtml)).toBe(true);
  });

  it('collects absolute image URLs and swaps in local paths or alt text', () => {
    const doc = fixture('images');
    const base = doc.source_url!;
    const first = cleanHtml(doc.html_content!, { baseUrl: base });
    expect(first.imageUrls).toEqual([
      'https://example.com/img/fog-1.png',
      'https://cdn.example.com/missing.jpg',
      'https://example.com/photo/field-notes/img/fog-2.gif',
    ]);
    const map = new Map([['https://example.com/img/fog-1.png', 'images/img-1.png']]);
    const { xhtml } = cleanHtml(doc.html_content!, { baseUrl: base, imageMap: map });
    expect(xhtml).toContain('<img src="images/img-1.png" alt="A pier vanishing into fog" />');
    expect(xhtml).toContain('[Image: Broken image]');
    expect(xhtml).not.toContain('fog-2');
  });

  it('drops every image when includeImages is false', () => {
    const map = new Map([['https://x.test/a.png', 'images/img-1.png']]);
    const { xhtml } = cleanHtml('<img src="https://x.test/a.png" alt="A">', { imageMap: map, includeImages: false });
    expect(xhtml).toBe('<span class="img-alt">[Image: A]</span>');
  });

  it('never nests links', () => {
    const { xhtml } = cleanHtml('<a href="https://a.test">one <a href="https://b.test">two</a> three</a>');
    expect(xhtml.match(/<a /g)?.length).toBe(1);
    expect(isBalanced(xhtml)).toBe(true);
  });
});

describe('resolveUrl', () => {
  const base = 'https://example.com/a/b/page.html?x=1';
  it.each([
    ['img.png', 'https://example.com/a/b/img.png'],
    ['../img.png', 'https://example.com/a/img.png'],
    ['/root.png', 'https://example.com/root.png'],
    ['//cdn.test/x.png', 'https://cdn.test/x.png'],
    ['https://other.test/y', 'https://other.test/y'],
  ])('%s', (href, expected) => {
    expect(resolveUrl(href, base)).toBe(expected);
  });
});

/** Tag balance check: every opened tag is closed in order. */
function isBalanced(xhtml: string): boolean {
  const stack: string[] = [];
  for (const m of xhtml.matchAll(/<(\/?)([a-z0-9]+)[^>]*?(\/?)>/g)) {
    const [, close, name, self] = m;
    if (self) continue;
    if (close) {
      if (stack.pop() !== name) return false;
    } else stack.push(name!);
  }
  return stack.length === 0;
}
