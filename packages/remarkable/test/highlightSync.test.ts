import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryManifestStore, ReadwiseClient, syncReader, type ReaderDocument } from '@inkwise/core';
import { FakeReadwise } from '@inkwise/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { sendDeviceHighlights } from '../src/highlightSync.js';
import { XochitlOutput } from '../src/xochitl.js';

const doc: ReaderDocument = {
  id: '01remarkablewikifixture0000',
  url: 'https://read.readwise.io/read/01remarkablewikifixture0000',
  source_url: 'https://example.org/remarkable',
  title: 'reMarkable',
  author: null,
  category: 'article',
  location: 'later',
  tags: {},
  site_name: null,
  word_count: 40,
  reading_time: null,
  created_at: '2026-10-04T12:00:00.000000+00:00',
  updated_at: '2026-10-04T12:00:00.000000+00:00',
  published_date: null,
  content: null,
  parent_id: null,
  notes: '',
  html_content:
    '<p>The reMarkable uses electronic paper and a stylus. ReMarkable uses its own operating system, named Codex.[12] Codex is based on Linux and optimized for electronic paper display technology.[13]</p><p>The tablet measures 177 mm × 256 mm × 6.7 mm. It also has a folio.</p>',
} as ReaderDocument;

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('reMarkable round trip', () => {
  it('puts a Reader article on the tablet and sends its highlights back', async () => {
    dir = mkdtempSync(join(tmpdir(), 'inkwise-rm-'));
    const fake = new FakeReadwise({ documents: [doc] });
    const client = new ReadwiseClient({ token: 'test-token', fetch: fake.fetch, sleep: async () => {} });
    const manifest = new MemoryManifestStore();
    const output = new XochitlOutput({ dir: join(dir, 'xochitl'), stateFile: join(dir, 'state.json') });

    const sync = await syncReader({ client, output, manifest }, { showHighlights: false });
    expect(sync.added).toBe(1);
    const [{ uuid }] = await output.documents();

    // The reader highlights two pages on the tablet.
    mkdirSync(join(dir, 'xochitl', uuid!));
    for (const p of ['p1', 'p2']) {
      writeFileSync(join(dir, 'xochitl', uuid!, `${p}.rm`), readFileSync(new URL(`./fixtures/Wikipedia_highlighted_${p}.rm`, import.meta.url)));
    }

    const first = await sendDeviceHighlights({ client, manifest, output });
    expect(first).toEqual({ counts: { sent: 5 }, unlocated: 0 });
    expect(fake.highlights.map((h) => h.content)).toContain('Codex is based on Linux and optimized for electronic paper display technology.[13]');

    // Running again sends nothing new.
    const again = await sendDeviceHighlights({ client, manifest, output });
    expect(again.counts).toEqual({ duplicate: 5 });
    expect(fake.highlights).toHaveLength(5);
  });
});
