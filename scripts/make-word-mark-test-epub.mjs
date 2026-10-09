// Round two of the style test: ways to mark only the highlighted words, since
// the Supernote reader draws no background behind inline text (round one,
// make-highlight-test-epub.mjs). Every rule names its element (span.t1, not
// .t1), because the reader skips rules written for a bare class.
// Usage: node scripts/make-word-mark-test-epub.mjs [out.epub]  (needs a built core)
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { buildEpub } from '@inkwise/core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.argv[2] ?? join(root, 'out', 'highlight-test', 'Inkwise-word-mark-test.epub'));

const SHORT = 'these words should look marked';
const LONG =
  'this longer highlight runs across two or three lines on the tablet, so it shows what happens when the marked words have to wrap onto the next line';

const words = (text) => text.split(' ');
const GREY = '#d2d2d2';

/** [label, css (for span.tN unless it says otherwise), text, how to mark the text]. */
const VARIANTS = [
  ['Grey box behind the words', `display: inline-block; background-color: ${GREY};`, SHORT, 'span'],
  ['Darker grey box behind the words', 'display: inline-block; background-color: #aaaaaa;', SHORT, 'span'],
  ['Grey box around a long highlight', `display: inline-block; background-color: ${GREY};`, LONG, 'span'],
  ['A grey box for each word, touching', `display: inline-block; background-color: ${GREY};`, LONG, 'per-word-joined'],
  ['A grey box for each word, small gaps', `display: inline-block; background-color: ${GREY};`, LONG, 'per-word'],
  ['A line under each word', 'display: inline-block; border-bottom: 2px solid #000000;', LONG, 'per-word-joined'],
  ['Underline built from the font (combining low line)', null, LONG, 'combining'],
  ['White words on a black box', 'display: inline-block; background-color: #000000; color: #ffffff;', SHORT, 'span'],
  ['Bold and italic', 'font-weight: bold; font-style: italic;', LONG, 'span'],
  ['Bold words, bar down the left of the paragraph', 'font-weight: bold;', LONG, 'bar'],
  ['Highlight pulled out onto its own grey lines', `display: block; background-color: ${GREY};`, LONG, 'span'],
  ['Grey box written into the tag itself', null, SHORT, 'inline-style'],
  ['Outline around the words', 'outline: 2px solid #000000;', SHORT, 'span'],
];

const css = [];
const paragraphs = VARIANTS.map(([label, rule, text, how], i) => {
  const n = i + 1;
  const cls = `t${n}`;
  if (rule) css.push(`span.${cls} { ${rule} }`);
  const lead = `<strong>${n}.</strong> ${label}. Here is a sentence where `;
  const tail = ' and the rest of it should look normal, which gives the paragraph enough length to wrap.';
  let marked;
  if (how === 'span') marked = `<span class="${cls}">${text}</span>`;
  else if (how === 'inline-style') marked = `<span style="display: inline-block; background-color: ${GREY};">${text}</span>`;
  else if (how === 'per-word') marked = words(text).map((w) => `<span class="${cls}">${w}</span>`).join(' ');
  // A no-break space inside each box (except the last) closes the gap between boxes.
  else if (how === 'per-word-joined') marked = words(text).map((w, j, all) => `<span class="${cls}">${w}${j < all.length - 1 ? '&#160;' : ''}</span>`).join('');
  else if (how === 'combining') marked = [...text].map((ch) => `${ch}̲`).join('');
  else if (how === 'bar') marked = `<span class="${cls}">${text}</span>`;
  const pClass = how === 'bar' ? ` class="${cls}-p"` : '';
  if (how === 'bar') css.push(`p.${cls}-p { border-left: 4px solid #000000; padding-left: 6px; }`);
  return `<p${pClass}>${lead}${marked}${tail}</p>`;
});

const doc = {
  id: '01inkwisewordmarktest00000',
  title: 'Inkwise word marking test',
  author: 'Inkwise',
  url: 'https://github.com/Valadon/InkWise',
  source_url: 'https://github.com/Valadon/InkWise',
  html_content: '<p>placeholder</p>',
};
const files = unzipSync(buildEpub(doc, { modified: new Date('2026-10-09T00:00:00Z') }).bytes);

const intro =
  '<p>Each line below tries a different way to mark only the highlighted words. Note the numbers where the marked words stand out and the rest of the paragraph looks normal, then tell Claude.</p>';
files['OEBPS/article.xhtml'] = strToU8(
  strFromU8(files['OEBPS/article.xhtml']).replace('<p>placeholder</p>', [intro, ...paragraphs].join('\n')),
);
files['OEBPS/style.css'] = strToU8(`${strFromU8(files['OEBPS/style.css'])}${css.join('\n')}\n`);

const ordered = { mimetype: [files.mimetype, { level: 0 }] };
for (const [name, data] of Object.entries(files)) if (name !== 'mimetype') ordered[name] = data;
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, zipSync(ordered, { level: 9, mtime: new Date('2020-01-01T00:00:00Z') }));
console.log(`Wrote ${out}`);
