// Builds an EPUB from every fixture (with and without images) and runs epubcheck on each.
// Needs Java 11+ and a built core (`npm run build`).
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { path as epubcheckJar } from 'epubcheck-static';
import { buildEpub } from '@inkwise/core';
import { TINY_GIF, TINY_PNG } from '@inkwise/core/testing';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// documents/ feeds the tests too; epubcheck/ holds extra HTML-structure cases.
const fixtureDirs = [join(root, 'fixtures', 'documents'), join(root, 'fixtures', 'epubcheck')];
const out = join(root, 'out', 'epubcheck');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const images = new Map([
  ['https://example.com/img/fog-1.png', { path: 'images/img-1.png', mediaType: 'image/png', data: TINY_PNG }],
  ['https://example.com/photo/field-notes/img/fog-2.gif', { path: 'images/img-2.gif', mediaType: 'image/gif', data: TINY_GIF }],
]);

const files = [];
for (const name of fixtureDirs.flatMap((dir) => readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => join(dir, f)))) {
  const doc = JSON.parse(readFileSync(name, 'utf8'));
  for (const withImages of [true, false]) {
    const epub = buildEpub(doc, { images, includeImages: withImages, modified: new Date('2026-10-08T00:00:00Z') });
    const file = join(out, `${withImages ? 'img' : 'noimg'}-${epub.filename}`);
    writeFileSync(file, epub.bytes);
    files.push(file);
  }
}

let failed = 0;
for (const file of files) {
  try {
    execFileSync('java', ['-jar', epubcheckJar, '--quiet', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    console.log(`ok   ${file.split('/').pop()}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${file.split('/').pop()}`);
    console.log(String(err.stdout ?? '') + String(err.stderr ?? ''));
  }
}
console.log(`${files.length - failed}/${files.length} EPUBs passed epubcheck.`);
process.exit(failed ? 1 : 0);
