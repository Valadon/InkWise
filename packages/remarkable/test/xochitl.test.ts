import { mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { epubText, epubTitle } from '../src/epubText.js';
import type { LibraryControl } from '../src/librarian.js';
import { XochitlOutput, pageOrder } from '../src/xochitl.js';

function makeEpub(title: string, chapters: string[]): Uint8Array {
  const files: Record<string, Uint8Array> = {
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(
      '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    ),
    'OEBPS/content.opf': strToU8(
      `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title></metadata><manifest>${chapters
        .map((_, i) => `<item id="c${i}" href="text/c${i}.xhtml" media-type="application/xhtml+xml"/>`)
        .join('')}</manifest><spine>${chapters.map((_, i) => `<itemref idref="c${i}"/>`).join('')}</spine></package>`,
    ),
  };
  chapters.forEach((body, i) => {
    files[`OEBPS/text/c${i}.xhtml`] = strToU8(`<html xmlns="http://www.w3.org/1999/xhtml"><body>${body}</body></html>`);
  });
  return zipSync(files);
}

// Text around the highlights in rmscene's Wikipedia sample pages.
const WIKI = makeEpub('reMarkable &amp; friends', [
  '<p>The reMarkable uses electronic paper and a stylus. ReMarkable uses its own operating system, named Codex.[12] Codex is based on Linux and optimized for electronic paper display technology.[13]</p>',
  '<p>The tablet measures 177 mm × 256 mm× 6.7 mm. It also has a folio.</p>',
]);

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const FILE = 'reMarkable-friends__01abcdefghijklmnopqrstuvwx.epub';

let dir: string;
let out: XochitlOutput;
const metadata = (id: string) => JSON.parse(readFileSync(join(dir, 'xochitl', `${id}.metadata`), 'utf8'));
const byName = (name: string) =>
  readdirSync(join(dir, 'xochitl'))
    .filter((n) => n.endsWith('.metadata'))
    .map((n) => ({ id: n.slice(0, -9), ...JSON.parse(readFileSync(join(dir, 'xochitl', n), 'utf8')) }))
    .find((m) => m.visibleName === name);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'inkwise-rm-'));
  out = new XochitlOutput({ dir: join(dir, 'xochitl'), stateFile: join(dir, 'state.json'), now: () => new Date(1_700_000_000_000) });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('epub helpers', () => {
  it('reads the title and the text in spine order', () => {
    expect(epubTitle(WIKI)).toBe('reMarkable & friends');
    const text = epubText(WIKI);
    expect(text.indexOf('named Codex')).toBeLessThan(text.indexOf('177 mm'));
  });
});

describe('pageOrder', () => {
  it('orders 3.x pages by their index and skips deleted ones', () => {
    const content = { cPages: { pages: [{ id: 'b', idx: { value: 'bb' } }, { id: 'x', idx: { value: 'ab' }, deleted: { value: 1 } }, { id: 'a', idx: { value: 'ba' } }] } };
    expect(pageOrder(content)).toEqual(['a', 'b']);
  });
  it('reads the flat page list (EPUBs on 3.28 still use it)', () => {
    expect(pageOrder({ formatVersion: 1, pages: ['p1', 'p2'], redirectionPageMap: [0, 1] })).toEqual(['p1', 'p2']);
  });
});

describe('XochitlOutput', () => {
  it('adds a book inside an Inkwise folder', async () => {
    await out.put(FILE, WIKI);
    const folder = byName('Inkwise');
    expect(folder).toMatchObject({ type: 'CollectionType', parent: '' });
    const book = byName('reMarkable & friends');
    expect(book).toMatchObject({ type: 'DocumentType', parent: folder.id, lastModified: '1700000000000' });
    expect(JSON.parse(readFileSync(join(dir, 'xochitl', `${book.id}.content`), 'utf8'))).toMatchObject({ fileType: 'epub', pages: [] });
    // The fields a Paper Pro on 3.28 writes for a book (values left out).
    const PAPER_PRO_METADATA = ['createdTime', 'deleted', 'lastModified', 'lastOpened', 'lastOpenedPage', 'metadatamodified', 'modified', 'new', 'parent', 'pinned', 'source', 'synced', 'type', 'version', 'visibleName'];
    expect(Object.keys(metadata(book.id)).sort()).toEqual(PAPER_PRO_METADATA);
    expect(readFileSync(join(dir, 'xochitl', `${book.id}.epub`)).equals(Buffer.from(WIKI))).toBe(true);
    expect(await out.list()).toEqual([{ name: FILE, size: WIKI.length }]);
    expect(out.changed).toBe(true);
    expect(readdirSync(join(dir, 'xochitl')).some((n) => n.endsWith('.part'))).toBe(false);
    // Nothing to tell the running app with, so it needs a restart.
    await out.finish();
    expect(out.needsRestart).toBe(true);
  });

  it('updates a book in place, but never under the reader’s annotations', async () => {
    await out.put(FILE, WIKI);
    const id = byName('reMarkable & friends').id;
    const v2 = makeEpub('reMarkable & friends', ['<p>Updated.</p>']);
    await out.put(FILE, v2);
    expect(readFileSync(join(dir, 'xochitl', `${id}.epub`)).equals(Buffer.from(v2))).toBe(true);
    expect(readdirSync(join(dir, 'xochitl')).filter((n) => n.endsWith('.epub'))).toHaveLength(1);
    expect(out.kept.size).toBe(0);

    mkdirSync(join(dir, 'xochitl', id));
    writeFileSync(join(dir, 'xochitl', id, 'page.rm'), fixture('Normal_AB.rm'));
    await out.put(FILE, WIKI);
    expect(readFileSync(join(dir, 'xochitl', `${id}.epub`)).equals(Buffer.from(v2))).toBe(true);
    expect([...out.kept]).toEqual([FILE]);
  });

  it('leaves a book alone once it has been opened, even without annotations', async () => {
    await out.put(FILE, WIKI);
    const id = byName('reMarkable & friends').id;
    // The reading app saves its own layout of a book the first time it opens it.
    writeFileSync(join(dir, 'xochitl', `${id}.pdf`), '%PDF');
    await out.put(FILE, makeEpub('reMarkable & friends', ['<p>Updated.</p>']));
    expect(readFileSync(join(dir, 'xochitl', `${id}.epub`)).equals(Buffer.from(WIKI))).toBe(true);
    expect([...out.kept]).toEqual([FILE]);
  });

  it('knows which Reader documents have been opened here', async () => {
    const other = 'Other__01zzzzzzzzzzzzzzzzzzzzzzzz.epub';
    await out.put(FILE, WIKI);
    await out.put(other, makeEpub('Other', ['<p>x</p>']));
    expect(await out.openedReaderIds()).toEqual(new Set());
    writeFileSync(join(dir, 'xochitl', `${byName('Other').id}.pagedata`), '');
    expect(await out.openedReaderIds()).toEqual(new Set(['01zzzzzzzzzzzzzzzzzzzzzzzz']));
  });

  it('sends removed books to the trash and archived ones to Inkwise/Archive', async () => {
    await out.put(FILE, WIKI);
    const other = 'Other__01zzzzzzzzzzzzzzzzzzzzzzzz.epub';
    await out.put(other, makeEpub('Other', ['<p>x</p>']));
    const id = byName('reMarkable & friends').id;

    await out.moveToSubfolder(FILE, 'Archive');
    const archive = byName('Archive');
    expect(archive).toMatchObject({ type: 'CollectionType', parent: byName('Inkwise').id });
    expect(metadata(id).parent).toBe(archive.id);
    expect((await out.list()).map((f) => f.name)).toEqual([other]);

    await out.remove(other);
    expect(byName('Other').parent).toBe('trash');
    expect(await out.list()).toEqual([]);
  });

  it('finds its folder again after losing its state file', async () => {
    await out.put(FILE, WIKI);
    rmSync(join(dir, 'state.json'));
    const again = new XochitlOutput({ dir: join(dir, 'xochitl'), stateFile: join(dir, 'state.json') });
    await again.put('Next__01yyyyyyyyyyyyyyyyyyyyyyyy.epub', makeEpub('Next', ['<p>y</p>']));
    const folders = readdirSync(join(dir, 'xochitl')).filter((n) => n.endsWith('.metadata') && metadata(n.slice(0, -9)).type === 'CollectionType');
    expect(folders).toHaveLength(1);
  });

  it('reads a book’s highlights from its page files', async () => {
    await out.put(FILE, WIKI);
    const id = byName('reMarkable & friends').id;
    mkdirSync(join(dir, 'xochitl', id));
    writeFileSync(join(dir, 'xochitl', id, 'p1.rm'), fixture('Wikipedia_highlighted_p1.rm'));
    writeFileSync(join(dir, 'xochitl', id, 'p2.rm'), fixture('Wikipedia_highlighted_p2.rm'));
    writeFileSync(
      join(dir, 'xochitl', `${id}.content`),
      JSON.stringify({ fileType: 'epub', cPages: { pages: [{ id: 'p1', idx: { value: 'ba' } }, { id: 'p2', idx: { value: 'bb' } }] } }),
    );
    expect(await out.documents()).toEqual([{ filename: FILE, uuid: id }]);
    const hs = await out.highlights(id);
    expect(hs.map((h) => [h.text, h.color])).toEqual([
      ['The reMarkable uses electronic paper', 3],
      ['ReMarkable uses its own operating system, named Codex.', 3],
      ['Codex is based on Linux and optimized for electronic paper display technology.[13]', 3],
      ['177 mm × 256 mm× 6.7 mm', 4],
      ['also', 5],
    ]);
    expect(existsSync(join(dir, 'xochitl', `${id}.epub`))).toBe(true);
  });

  describe('with librarian', () => {
    function fakeLibrary() {
      const calls: string[] = [];
      const library: LibraryControl & { calls: string[]; failing: boolean } = {
        calls,
        failing: false,
        async createFolder(name, parent) {
          calls.push(`createFolder ${name} ${parent || '(top)'}`);
          if (library.failing) throw new Error('no');
          return `00000000-0000-4000-8000-00000000000${calls.length}`;
        },
        async move(id, parent) {
          calls.push(`move ${id} ${parent}`);
          if (library.failing) throw new Error('no');
        },
        async trash(id) {
          calls.push(`trash ${id}`);
          if (library.failing) throw new Error('no');
        },
        async rescan() {
          calls.push('rescan');
          if (library.failing) throw new Error('no');
        },
      };
      return library;
    }
    const withLibrary = (library: LibraryControl) =>
      new XochitlOutput({ dir: join(dir, 'xochitl'), stateFile: join(dir, 'state.json'), library, now: () => new Date(1_700_000_000_000) });

    it('adds books without a restart: folders through the app, then one rescan', async () => {
      const library = fakeLibrary();
      const o = withLibrary(library);
      await o.put(FILE, WIKI);
      await o.put('Other__01zzzzzzzzzzzzzzzzzzzzzzzz.epub', makeEpub('Other', ['<p>x</p>']));
      const folder = '00000000-0000-4000-8000-000000000001';
      expect(byName('reMarkable & friends').parent).toBe(folder);
      expect(byName('Inkwise')).toBeUndefined(); // the app makes it, not us
      expect(library.calls).toEqual(['createFolder Inkwise (top)']);
      await o.finish();
      expect(library.calls).toEqual(['createFolder Inkwise (top)', 'rescan']);
      expect(o.needsRestart).toBe(false);
      expect(o.changed).toBe(true);
    });

    it('archives and trashes through the app', async () => {
      await out.put(FILE, WIKI);
      await out.put('Other__01zzzzzzzzzzzzzzzzzzzzzzzz.epub', makeEpub('Other', ['<p>x</p>']));
      const id = byName('reMarkable & friends').id;
      const other = byName('Other').id;
      const inkwise = byName('Inkwise').id;
      const library = fakeLibrary();
      const o = withLibrary(library);
      await o.moveToSubfolder(FILE, 'Archive');
      await o.remove('Other__01zzzzzzzzzzzzzzzzzzzzzzzz.epub');
      expect(library.calls).toEqual([`createFolder Archive ${inkwise}`, `move ${id} 00000000-0000-4000-8000-000000000001`, `trash ${other}`]);
      // The app saves those changes itself.
      expect(metadata(id).parent).toBe(inkwise);
      expect(metadata(other).parent).toBe(inkwise);
      await o.finish();
      expect(o.needsRestart).toBe(false);
      expect(library.calls.at(-1)).not.toBe('rescan');
    });

    it('falls back to editing files, and a restart, when librarian fails', async () => {
      await out.put(FILE, WIKI);
      const id = byName('reMarkable & friends').id;
      const library = fakeLibrary();
      library.failing = true;
      const o = withLibrary(library);
      await o.moveToSubfolder(FILE, 'Archive');
      expect(metadata(id).parent).toBe(byName('Archive').id);
      expect(o.needsRestart).toBe(true);
      // Not asked again after the first failure.
      expect(library.calls).toEqual([`createFolder Archive ${byName('Inkwise').id}`]);
    });
  });
});
