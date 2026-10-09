import type { ReaderDocument } from '@inkwise/core';
import { FakeReadwise } from '@inkwise/core/testing';
import { describe, expect, it } from 'vitest';
import { SAMPLE_DOCUMENT } from '../src/sample.js';
import { TabletReadwiseClient, describeSkipped } from '../src/readerQueue.js';

function doc(id: string, category: string, html: string | null = '<p>Some text.</p>'): ReaderDocument {
  return { ...SAMPLE_DOCUMENT, id, title: id, category, html_content: html, content: null };
}

function client(documents: ReaderDocument[]) {
  const fake = new FakeReadwise({ documents });
  return new TabletReadwiseClient({ token: fake.token, fetch: fake.fetch, sleep: async () => {} });
}

describe('TabletReadwiseClient', () => {
  const queue = [
    doc('article', 'article'),
    doc('post', 'tweet'),
    doc('newsletter', 'email'),
    doc('feed', 'rss'),
    doc('paper', 'pdf'),
    doc('talk', 'video'),
    doc('blank', 'tweet', ''),
  ];

  it('keeps everything Reader stores as a web page, X posts and newsletters included', async () => {
    const c = client(queue);
    const docs = await c.listDocuments({ location: 'later', withHtmlContent: true });
    expect(docs.map((d) => d.id)).toEqual(['article', 'post', 'newsletter', 'feed']);
    expect(c.skipped).toEqual({ pdf: 1, video: 1, empty: 1 });
  });

  it('counts the limit in kept documents', async () => {
    const docs = await client(queue.slice().reverse()).listDocuments({ location: 'later', withHtmlContent: true, limit: 2 });
    expect(docs.map((d) => d.id)).toEqual(['feed', 'newsletter']);
  });

  it('lists books opened on the tablet as unchanged', async () => {
    const c = client([{ ...doc('article', 'article'), updated_at: '2026-10-09T00:10:00Z' }]);
    c.opened.set('article', '2026-10-08T23:00:00Z');
    expect((await c.listDocuments({ location: 'later', withHtmlContent: true }))[0].updated_at).toBe('2026-10-08T23:00:00Z');
  });

  it('asks Reader directly when a sync wants one category', async () => {
    const c = client(queue);
    expect((await c.listDocuments({ location: 'later', category: 'pdf' })).map((d) => d.id)).toEqual(['paper']);
  });
});

describe('describeSkipped', () => {
  it('says what stayed in Reader', () => {
    expect(describeSkipped({})).toBe('');
    expect(describeSkipped({ pdf: 1 })).toBe('Skipped 1 PDF (InkWise only brings over web pages for now).');
    expect(describeSkipped({ pdf: 2, video: 1, empty: 1 })).toBe('Skipped 2 PDFs, 1 video and 1 page with no text (InkWise only brings over web pages for now).');
  });
});
