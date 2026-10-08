// Builds an EPUB that shows the same phrase marked up a dozen different ways, to
// find out which highlight styles the Supernote's reader actually draws.
// Usage: node scripts/make-highlight-test-epub.mjs [out.epub]  (needs a built core)
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { buildEpub } from '@inkwise/core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.argv[2] ?? join(root, 'out', 'highlight-test', 'Inkwise-highlight-test.epub'));

const PHRASE = 'these words should look marked';

/** [label, css for .tN (or null), how to wrap the phrase]. */
const VARIANTS = [
  ['Light grey background (what Inkwise used so far)', 'background-color: #d2d2d2;', 'span'],
  ['Dark grey background', 'background-color: #999999;', 'span'],
  ['Underline', 'text-decoration: underline;', 'span'],
  ['Underline plus light grey background (this build)', 'background-color: #d2d2d2; text-decoration: underline;', 'span'],
  ['Built-in ins element, no CSS', null, 'ins'],
  ['Built-in u element, no CSS', null, 'u'],
  ['Built-in mark element, no CSS', null, 'mark'],
  ['Underline written into the tag itself', null, 'inline'],
  ['Grey text', 'color: #777777;', 'span'],
  ['Bold', 'font-weight: bold;', 'span'],
  ['Thick line under the words', 'border-bottom: 2px solid #000000;', 'span'],
  ['Whole paragraph shaded grey', 'background-color: #d2d2d2;', 'paragraph'],
  ['Bar down the left of the paragraph', 'border-left: 4px solid #000000; padding-left: 6px;', 'paragraph'],
];

const css = VARIANTS.map(([, rule, how], i) => (rule ? `${how === 'paragraph' ? 'p' : 'span'}.t${i + 1} { ${rule} }` : '')).filter(Boolean);

const paragraphs = VARIANTS.map(([label, , how], i) => {
  const n = i + 1;
  const lead = `<strong>${n}.</strong> ${label}. Here is a sentence where `;
  const tail = ' and the rest of it should look normal.';
  if (how === 'paragraph') return `<p class="t${n}">${lead}${PHRASE}${tail}</p>`;
  if (how === 'inline') return `<p>${lead}<span style="text-decoration: underline;">${PHRASE}</span>${tail}</p>`;
  if (how === 'span') return `<p>${lead}<span class="t${n}">${PHRASE}</span>${tail}</p>`;
  return `<p>${lead}<${how}>${PHRASE}</${how}>${tail}</p>`;
});

// Start from a real Inkwise EPUB so the package and base stylesheet match what sync writes.
const doc = {
  id: '01inkwisehighlighttest0000',
  title: 'Inkwise highlight test',
  author: 'Inkwise',
  url: 'https://github.com/Valadon/InkWise',
  source_url: 'https://github.com/Valadon/InkWise',
  html_content: '<p>placeholder</p>',
};
const files = unzipSync(buildEpub(doc, { modified: new Date('2026-10-08T00:00:00Z') }).bytes);

const intro =
  '<p>Each line below marks the same words a different way. Note the numbers where you can see those words marked, then tell Claude.</p>';
files['OEBPS/article.xhtml'] = strToU8(
  strFromU8(files['OEBPS/article.xhtml']).replace('<p>placeholder</p>', [intro, ...paragraphs].join('\n')),
);
files['OEBPS/style.css'] = strToU8(`${strFromU8(files['OEBPS/style.css'])}${css.join('\n')}\n`);

const ordered = { mimetype: [files.mimetype, { level: 0 }] };
for (const [name, data] of Object.entries(files)) if (name !== 'mimetype') ordered[name] = data;
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, zipSync(ordered, { level: 9, mtime: new Date('2020-01-01T00:00:00Z') }));
console.log(`Wrote ${out}`);
