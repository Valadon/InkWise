import React, { useEffect, useState } from 'react';
import { BUILD } from '../buildInfo';
import type { InkwiseApp } from '../services/app';
import { highlightState, type HighlightOutcome } from '../services/quickSend';
import { Button, Field, Line, Page, Quote, Row, Section } from './kit';

const PREVIEW_CHARS = 280;

/**
 * Shows the last Send highlight result. Send highlight itself runs without this
 * screen (see quickSend); it opens when something needs the user, or when they
 * re-select a highlight to add a note or delete it.
 */
export function HighlightScreen({ app, onClose, onSettings }: { app: InkwiseApp; onClose: () => void; onSettings: () => void }) {
  const [snapshot, setSnapshot] = useState(() => ({ sending: highlightState.sending, result: highlightState.result }));
  useEffect(
    () => highlightState.subscribe(() => setSnapshot({ sending: highlightState.sending, result: highlightState.result })),
    [],
  );
  const { sending, result } = snapshot;
  // Remount per result, so the note field and delete confirmation start fresh.
  return (
    <Page title="Send highlight" onClose={onClose}>
      {sending || !result ? (
        <Section>
          <Line strong>Sending…</Line>
        </Section>
      ) : (
        <ResultView key={`${result.docId}-${result.existing?.text ?? result.selection}`} app={app} result={result} onClose={onClose} onSettings={onSettings} />
      )}
      <Line small>Inkwise {BUILD.version}</Line>
    </Page>
  );
}

function ResultView({ app, result, onClose, onSettings }: { app: InkwiseApp; result: HighlightOutcome; onClose: () => void; onSettings: () => void }) {
  const existing = result.status === 'duplicate' ? result.existing : undefined;
  const text = existing?.text ?? result.sentText ?? result.selection ?? '';
  const [note, setNote] = useState(existing?.note ?? '');
  const [noteResult, setNoteResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleted, setDeleted] = useState<string | null>(null);

  const canNote = !!result.docId && (existing || result.status === 'sent' || result.status === 'queued_offline');

  const saveNote = async () => {
    if (!result.docId) return;
    setBusy(true);
    try {
      const r = await app.addNote({
        docId: result.docId,
        text: existing?.text ?? result.selection ?? text,
        note,
        highlightId: existing?.highlightId ?? result.highlightId,
      });
      setNoteResult(r.message);
    } catch (err) {
      setNoteResult(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!result.docId || !existing) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setBusy(true);
    try {
      const r = await app.deleteHighlight(result.docId, existing.text);
      if (r.ok) setDeleted(r.message);
      else setNoteResult(r.message);
    } finally {
      setBusy(false);
      setConfirmDelete(false);
    }
  };

  if (deleted) {
    return (
      <Section>
        <Line strong>{deleted}</Line>
        <Row>
          <Button label="Back to reading" primary onPress={onClose} />
        </Row>
      </Section>
    );
  }

  return (
    <>
      <Section>
        {text ? <Quote>{text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text}</Quote> : null}
        <Line strong>{existing ? (existing.queued ? 'Highlighted. Waiting to send.' : 'Highlighted.') : result.message}</Line>
        {result.shading && !existing ? <Line small>{result.shading}</Line> : null}
        {result.status === 'needs_attention' ? (
          <Line small>You can fix the text or send it as a standalone highlight from Inkwise settings.</Line>
        ) : null}
      </Section>
      {canNote ? (
        <Section title={existing ? 'Note' : 'Add a note (optional)'}>
          <Field label="Note" value={note} onChangeText={setNote} placeholder="Your thought…" multiline />
          <Row>
            <Button label={busy ? 'Saving…' : 'Save note'} onPress={saveNote} disabled={busy || !note.trim()} primary />
            {existing ? (
              <Button label={confirmDelete ? 'Tap again to delete' : 'Delete highlight'} onPress={remove} disabled={busy} />
            ) : null}
          </Row>
          {confirmDelete ? <Line small>This deletes it in Readwise too.</Line> : null}
          {noteResult ? <Line>{noteResult}</Line> : null}
        </Section>
      ) : null}
      <Row>
        {result.status === 'needs_attention' || result.status === 'token_rejected' ? <Button label="Settings" onPress={onSettings} /> : null}
      </Row>
    </>
  );
}
