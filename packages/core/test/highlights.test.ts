import { describe, expect, it } from 'vitest';
import {
  MemoryManifestStore,
  MemoryOutput,
  ReadwiseClient,
  addNoteToHighlight,
  archiveDocument,
  buildEpub,
  deleteHighlight,
  epubFilename,
  epubIdentifier,
  locateInText,
  resolveNeedsAttention,
  sendHighlight,
  syncReader,
} from '../src/index.js';
import { FakeReadwise } from '../src/testing/fake-readwise.js';
import { fixture, loadFixtures, noSleep } from './helpers.js';

const DEVICE_DIR = '/storage/emulated/0/Document/Inkwise';

async function setup() {
  const fake = new FakeReadwise({ documents: loadFixtures() });
  const client = new ReadwiseClient({ token: 'test-token', fetch: fake.fetch, sleep: noSleep });
  const output = new MemoryOutput();
  const manifest = new MemoryManifestStore();
  await syncReader({ client, output, manifest }, { includeImages: false });
  const doc = fixture('longform');
  const path = `${DEVICE_DIR}/${epubFilename(doc)}`;
  return { fake, client, manifest, doc, path, output };
}

describe('sendHighlight', () => {
  it('sends a plain selection to the right document', async () => {
    const { fake, client, manifest, doc, path } = await setup();
    const r = await sendHighlight({ client, manifest, filePath: path, text: 'Speed is a habit, not a virtue.' });
    expect(r).toMatchObject({ status: 'sent', message: 'Highlight sent.', docId: doc.id });
    expect(fake.highlights[0]).toMatchObject({ parent_id: doc.id, content: 'Speed is a habit, not a virtue.', saved_using: 'Inkwise' });
  });

  it('handles selections spanning paragraphs with odd whitespace', async () => {
    const { fake, client, manifest, path } = await setup();
    const r = await sendHighlight({
      client,
      manifest,
      filePath: path,
      text: 'It doesn’t glow; it waits.\n\n“Read slowly,” my teacher said',
    });
    expect(r.status).toBe('sent');
    expect(fake.highlights.length).toBe(1);
  });

  it('recovers when the device straightened quotes and dashes', async () => {
    const { fake, client, manifest, path } = await setup();
    const r = await sendHighlight({
      client,
      manifest,
      filePath: path,
      text: '"Read slowly," my teacher said, "and the book will read you back."',
    });
    expect(r.status).toBe('sent');
    expect(r.sentText).toBe('“Read slowly,” my teacher said, “and the book will read you back.”');
    expect(fake.highlights[0]!.content).toBe(r.sentText);
  });

  it('recovers from soft hyphens, ligatures and case differences', async () => {
    const { client, manifest, path } = await setup();
    const r = await sendHighlight({ client, manifest, filePath: path, text: 'speed is a ha­bit, not a virtue' });
    expect(r.status).toBe('sent');
    expect(r.sentText).toBe('Speed is a habit, not a virtue');
  });

  it('dedupes', async () => {
    const { fake, client, manifest, path } = await setup();
    await sendHighlight({ client, manifest, filePath: path, text: 'Speed is a habit, not a virtue.' });
    const r = await sendHighlight({ client, manifest, filePath: path, text: '  Speed is a habit,  not a virtue. ' });
    expect(r.status).toBe('duplicate');
    expect(fake.highlights.length).toBe(1);
  });

  it('treats re-selecting part of a highlight as editing it', async () => {
    const { client, manifest, path, doc } = await setup();
    const sent = await sendHighlight({ client, manifest, filePath: path, text: 'Speed is a habit, not a virtue.', note: 'first' });
    expect(sent.status).toBe('sent');
    const again = await sendHighlight({ client, manifest, filePath: path, text: 'a habit, not a virtue' });
    expect(again.status).toBe('duplicate');
    expect(again.existing).toMatchObject({ text: 'Speed is a habit, not a virtue.', highlightId: sent.highlightId, note: 'first' });
    // A short word that happens to sit inside the highlight is a new selection, not an edit.
    const word = await sendHighlight({ client, manifest, filePath: path, text: 'habit' });
    expect(word.status).not.toBe('duplicate');
    expect(manifest.manifest.docHighlights[doc.id]).toContain('Speed is a habit, not a virtue.');
  });

  it('updates the note and deletes a sent highlight in Readwise', async () => {
    const { fake, client, manifest, path, doc } = await setup();
    const text = 'Speed is a habit, not a virtue.';
    await sendHighlight({ client, manifest, filePath: path, text });
    const n = await addNoteToHighlight({ client, manifest, docId: doc.id, text, note: 'edited later' });
    expect(n).toEqual({ ok: true, message: 'Note saved.' });
    expect(fake.highlights[0]!.notes).toBe('edited later');
    const d = await deleteHighlight({ client, manifest, docId: doc.id, text });
    expect(d).toEqual({ ok: true, message: 'Highlight deleted.' });
    expect(fake.highlights).toHaveLength(0);
    expect(manifest.manifest.docHighlights[doc.id]).toBeUndefined();
    // Selecting it again now sends a fresh highlight.
    expect((await sendHighlight({ client, manifest, filePath: path, text })).status).toBe('sent');
  });

  it('deletes a queued highlight without touching Readwise', async () => {
    const { fake, client, manifest, path, doc } = await setup();
    fake.offline = true;
    await sendHighlight({ client, manifest, filePath: path, text: 'None of this is new.' });
    const d = await deleteHighlight({ client, manifest, docId: doc.id, text: 'None of this is new.' });
    expect(d.ok).toBe(true);
    expect(manifest.manifest.pendingHighlights).toHaveLength(0);
  });

  it('keeps the highlight when a delete fails offline', async () => {
    const { fake, client, manifest, path, doc } = await setup();
    const text = 'Speed is a habit, not a virtue.';
    await sendHighlight({ client, manifest, filePath: path, text });
    fake.offline = true;
    const d = await deleteHighlight({ client, manifest, docId: doc.id, text });
    expect(d.ok).toBe(false);
    expect(manifest.manifest.docHighlights[doc.id]).toContain(text);
  });

  it('queues offline and sends on the next sync, never losing the highlight', async () => {
    const { fake, client, manifest, path, output } = await setup();
    fake.offline = true;
    const r = await sendHighlight({ client, manifest, filePath: path, text: 'None of this is new.', note: 'true' });
    expect(r).toMatchObject({ status: 'queued_offline', message: 'Saved offline, will send on next sync.' });
    expect(manifest.manifest.pendingHighlights).toHaveLength(1);
    // Same highlight again while offline: still one queued copy.
    await sendHighlight({ client, manifest, filePath: path, text: 'None of this is new.' });
    expect(manifest.manifest.pendingHighlights).toHaveLength(1);
    fake.offline = false;
    const s = await syncReader({ client, output, manifest }, { includeImages: false });
    expect(s.highlights.sent).toBe(1);
    expect(fake.highlights[0]).toMatchObject({ content: 'None of this is new.', notes: 'true' });
    expect(manifest.manifest.pendingHighlights).toHaveLength(0);
  });

  it('queues on server errors too', async () => {
    const { fake, client, manifest, path } = await setup();
    fake.failNext['/api/v3/save/'] = 503;
    const r = await sendHighlight({ client, manifest, filePath: path, text: 'None of this is new.' });
    expect(r.status).toBe('queued_offline');
  });

  it('marks unmatched text as needs_attention and lets the user resolve it', async () => {
    const { fake, client, manifest, path } = await setup();
    const r = await sendHighlight({ client, manifest, filePath: path, text: 'This sentence is not in the article.' });
    expect(r.status).toBe('needs_attention');
    expect(manifest.manifest.pendingHighlights[0]).toMatchObject({ state: 'needs_attention' });
    // Retrying with corrected text works.
    const retry = await resolveNeedsAttention({ client, manifest, index: 0, action: 'retry', text: 'None of this is new.' });
    expect(retry.status).toBe('sent');
    expect(manifest.manifest.pendingHighlights).toHaveLength(0);
    expect(fake.highlights).toHaveLength(1);
  });

  it('can fall back to a classic Readwise highlight', async () => {
    const { fake, client, manifest, path, doc } = await setup();
    await sendHighlight({ client, manifest, filePath: path, text: 'Not in the article at all.' });
    const r = await resolveNeedsAttention({ client, manifest, index: 0, action: 'send_classic' });
    expect(r.status).toBe('sent');
    expect(fake.classicHighlights[0]).toMatchObject({ text: 'Not in the article at all.', title: doc.title, source_type: 'inkwise' });
  });

  it('can discard a highlight from the queue', async () => {
    const { client, manifest, path } = await setup();
    await sendHighlight({ client, manifest, filePath: path, text: 'Nope nope.' });
    await resolveNeedsAttention({ client, manifest, index: 0, action: 'discard' });
    expect(manifest.manifest.pendingHighlights).toHaveLength(0);
  });

  it('refuses files that are not Inkwise EPUBs', async () => {
    const { client, manifest } = await setup();
    const r = await sendHighlight({ client, manifest, filePath: '/storage/emulated/0/Document/manual.pdf', text: 'x' });
    expect(r).toEqual({ status: 'not_inkwise', message: "This document isn't from Readwise." });
  });

  it('falls back to the dc:identifier inside a renamed EPUB', async () => {
    const { fake, client, manifest, doc } = await setup();
    const bytes = buildEpub(doc).bytes;
    const r = await sendHighlight({
      client,
      manifest,
      filePath: '/storage/emulated/0/Document/renamed.epub',
      text: 'None of this is new.',
      readIdentifier: async () => epubIdentifier(bytes),
    });
    expect(r.status).toBe('sent');
    expect(fake.highlights[0]!.parent_id).toBe(doc.id);
  });

  it('asks for a selection when there is none', async () => {
    const { client, manifest, path } = await setup();
    expect((await sendHighlight({ client, manifest, filePath: path, text: '  ' })).status).toBe('empty');
  });

  it('reports a rejected token but keeps the highlight', async () => {
    const { fake, client, manifest, path } = await setup();
    fake.token = 'rotated';
    const r = await sendHighlight({ client, manifest, filePath: path, text: 'None of this is new.' });
    expect(r.status).toBe('token_rejected');
    expect(manifest.manifest.pendingHighlights).toHaveLength(1);
  });
});

describe('archiveDocument', () => {
  it('flushes highlights for the document, then archives it', async () => {
    const { fake, client, manifest, path, doc } = await setup();
    fake.offline = true;
    await sendHighlight({ client, manifest, filePath: path, text: 'None of this is new.' });
    fake.offline = false;
    const r = await archiveDocument({ client, manifest, filePath: path });
    expect(r.status).toBe('archived');
    expect(r.message).toBe('Archived in Reader. Sent 1 saved highlight first.');
    expect(fake.highlights).toHaveLength(1);
    expect(fake.documents.find((d) => d.id === doc.id)!.location).toBe('archive');
    expect(manifest.manifest.documents[doc.id]!.status).toBe('archived');
    const patchIdx = fake.requests.findIndex((q) => q.method === 'PATCH');
    const saveIdx = fake.requests.findIndex((q) => q.url.endsWith('/api/v3/save/'));
    expect(saveIdx).toBeLessThan(patchIdx);
  });

  it('queues the archive offline and completes it on next sync', async () => {
    const { fake, client, manifest, path, doc, output } = await setup();
    fake.offline = true;
    const r = await archiveDocument({ client, manifest, filePath: path });
    expect(r.status).toBe('queued_offline');
    fake.offline = false;
    const s = await syncReader({ client, output, manifest }, { includeImages: false });
    expect(s.highlights.archived).toBe(1);
    expect(fake.documents.find((d) => d.id === doc.id)!.location).toBe('archive');
  });
});

describe('locateInText', () => {
  it('returns the exact source passage', () => {
    const src = 'He said, “Hello — world.”\n\nThen left.';
    expect(locateInText('"hello - world."', src)).toBe('“Hello — world.”');
    expect(locateInText('world.” Then', src)).toBe('world.”\n\nThen');
    expect(locateInText('absent', src)).toBeNull();
    expect(locateInText('', src)).toBeNull();
  });

  it('copes with the reader breaking a line after a hyphen', () => {
    const src = '“There’s no billion-dollar—sorry, billion-token—move I can make,” he says.';
    // Lance's Manta, 2026-10-09: the line broke after "billion-" and the selection put a space there.
    expect(locateInText('“There’s no billion-dollar—sorry, billion- token—move I can make,”', src)).toBe(
      '“There’s no billion-dollar—sorry, billion-token—move I can make,”',
    );
    expect(locateInText('a compa- ny that', 'It is a company that works.')).toBe('a company that');
  });

  it('ignores the underline marks Inkwise adds to highlighted words', () => {
    const underlined = [...'billion-token'].map((c) => `\u0332${c}`).join('');
    expect(locateInText(`sorry, ${underlined}—move`, 'sorry, billion-token—move I')).toBe('sorry, billion-token—move');
  });
});

describe('sendHighlight across a line break', () => {
  it('sends the source text when the selection has a space after a hyphen', async () => {
    const { fake, client, manifest } = await setup();
    const doc = { ...fixture('longform'), id: '01hyphenatedlinebreak0000', html_content: '<p>“There’s no billion-dollar—sorry, billion-token—move I can make,” he says.</p>' };
    fake.documents.push(doc);
    const r = await sendHighlight({
      client,
      manifest,
      filePath: `${DEVICE_DIR}/${epubFilename(doc)}`,
      text: '“There’s no billion-dollar—sorry, billion-\ntoken—move I can make,”',
    });
    expect(r.status).toBe('sent');
    expect(fake.highlights.at(-1)?.content).toBe('“There’s no billion-dollar—sorry, billion-token—move I can make,”');
  });
});
