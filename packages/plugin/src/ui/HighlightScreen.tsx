import React, { useEffect, useRef, useState } from 'react';
import type { SendResult } from '@inkwise/core';
import type { InkwiseApp } from '../services/app';
import { Button, Field, Line, Page, Quote, Row, Section } from './kit';

const PREVIEW_CHARS = 280;

export function HighlightScreen({ app, run, onClose, onSettings }: { app: InkwiseApp; run: number; onClose: () => void; onSettings: () => void }) {
  const [result, setResult] = useState<(SendResult & { selection?: string }) | null>(null);
  const [note, setNote] = useState('');
  const [noteResult, setNoteResult] = useState<string | null>(null);
  const [savingNote, setSavingNote] = useState(false);
  const busy = useRef(false);

  useEffect(() => {
    if (busy.current) return;
    busy.current = true;
    setResult(null);
    setNote('');
    setNoteResult(null);
    app
      .sendSelection()
      .then(setResult)
      .catch((err) => setResult({ status: 'needs_attention', message: err instanceof Error ? err.message : String(err) }))
      .finally(() => {
        busy.current = false;
      });
  }, [app, run]);

  const canNote = result && result.docId && (result.status === 'sent' || result.status === 'queued_offline');
  const text = result?.sentText ?? result?.selection ?? '';

  const saveNote = async () => {
    if (!result?.docId) return;
    setSavingNote(true);
    try {
      const r = await app.addNote({ docId: result.docId, text: result.selection ?? text, note, highlightId: result.highlightId });
      setNoteResult(r.message);
    } catch (err) {
      setNoteResult(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingNote(false);
    }
  };

  return (
    <Page title="Send highlight" onClose={onClose}>
      <Section>
        {text ? <Quote>{text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text}</Quote> : null}
        <Line strong>{result ? result.message : 'Sending…'}</Line>
        {result?.status === 'needs_attention' ? (
          <Line small>You can fix the text or send it as a standalone highlight from Inkwise settings.</Line>
        ) : null}
      </Section>
      {canNote ? (
        <Section title="Add a note (optional)">
          <Field label="Note" value={note} onChangeText={setNote} placeholder="Your thought…" multiline />
          <Row>
            <Button label={savingNote ? 'Saving…' : 'Save note'} onPress={saveNote} disabled={savingNote || !note.trim()} primary />
          </Row>
          {noteResult ? <Line>{noteResult}</Line> : null}
        </Section>
      ) : null}
      <Row>
        {result?.status === 'needs_attention' || result?.status === 'token_rejected' ? <Button label="Settings" onPress={onSettings} /> : null}
      </Row>
    </Page>
  );
}
