import { READABLE_CATEGORIES, syncReader, textManifestStore, type ReaderDocument } from '@inkwise/core';
import { FakeReadwise } from '@inkwise/core/testing';
import { describe, expect, it } from 'vitest';
import { SAMPLE_DOCUMENT } from '../src/sample.js';
import { TabletReadwiseClient, describeSkipped } from '../src/readerQueue.js';

function doc(id: string, category: string): ReaderDocument {
  return { ...SAMPLE_DOCUMENT, id, title: id, category, html_content: '<p>Some text.</p>', content: null };
}

function client(documents: ReaderDocument[]) {
  const fake = new FakeReadwise({ documents });
  return new TabletReadwiseClient({ token: fake.token, fetch: fake.fetch, sleep: async () => {} });
}

describe('TabletReadwiseClient', () => {
  const queue = [doc('article', 'article'), doc('post', 'tweet'), doc('paper', 'pdf'), doc('talk', 'video'), doc('slides', 'pdf')];

  it('counts what the sync leaves out, by category', async () => {
    const c = client(queue);
    const docs = await c.listDocuments({ location: 'later', accept: (d) => READABLE_CATEGORIES.includes(d.category as never) });
    expect(docs.map((d) => d.id)).toEqual(['article', 'post']);
    expect(c.skipped).toEqual({ pdf: 2, video: 1 });
  });

  it('lists books opened on the tablet as unchanged', async () => {
    const c = client([{ ...doc('article', 'article'), updated_at: '2026-10-09T00:10:00Z' }]);
    c.opened.set('article', '2026-10-08T23:00:00Z');
    expect((await c.listDocuments({ location: 'later' }))[0].updated_at).toBe('2026-10-08T23:00:00Z');
  });

  it('brings X posts along with articles in a sync, and leaves an opened book unbuilt', async () => {
    const ART = '01articleaaaaaaaaaaaaaaaaa';
    const POST = '01postbbbbbbbbbbbbbbbbbbbb';
    const c = client([{ ...doc(ART, 'article'), title: 'Art', updated_at: '2026-10-09T00:10:00Z' }, { ...doc(POST, 'tweet'), title: 'Post' }, doc('01pdfccccccccccccccccccccc', 'pdf')]);
    const onTablet = `Art__${ART}.epub`;
    let text: string | null = null;
    const manifest = textManifestStore({ read: async () => text, write: async (t) => void (text = t) });
    await manifest.save({ ...(await manifest.load()), documents: { [ART]: { title: 'Art', filename: onTablet, updatedAt: '2026-10-08T23:00:00Z', status: 'synced' } } });
    const written: string[] = [];
    const output = { name: 'device' as const, list: async () => [{ name: onTablet }], put: async (name: string) => void written.push(name) };
    c.opened.set(ART, '2026-10-08T23:00:00Z');
    const result = await syncReader({ client: c, output: output as any, manifest }, { showHighlights: false, includeImages: false });
    expect(written).toEqual([`Post__${POST}.epub`]);
    expect(result).toMatchObject({ added: 1, updated: 0 });
    expect(c.skipped).toEqual({ pdf: 1 });
  });
});

describe('describeSkipped', () => {
  it('says what stayed in Reader', () => {
    expect(describeSkipped({})).toBe('');
    expect(describeSkipped({ pdf: 1 })).toBe('Skipped 1 PDF (InkWise only brings over web pages for now).');
    expect(describeSkipped({ pdf: 2, video: 1, note: 1 })).toBe('Skipped 2 PDFs, 1 video and 1 note item (InkWise only brings over web pages for now).');
  });
});
