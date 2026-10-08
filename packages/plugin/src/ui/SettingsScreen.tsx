import React, { useCallback, useEffect, useState } from 'react';
import type { PendingHighlight } from '@inkwise/core';
import { STORAGE_ROOT, TOKEN_IMPORT_PATH, type InkwiseApp, type Settings } from '../services/app';
import { BUILD } from '../buildInfo';
import { Button, Choice, Field, Line, Page, Quote, Row, Section, Toggle } from './kit';

export function SettingsScreen({ app, onClose }: { app: InkwiseApp; onClose: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [connected, setConnected] = useState(false);
  const [tokenInput, setTokenInput] = useState('');
  const [tokenMsg, setTokenMsg] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [queue, setQueue] = useState<{ pending: PendingHighlight[]; archives: number; titles: Record<string, string> } | null>(null);
  const [queueMsg, setQueueMsg] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setSettings(await app.settings());
    setConnected(await app.hasToken());
    setQueue(await app.queue());
    setEdits({});
  }, [app]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const update = async (patch: Partial<Settings>) => {
    const next = await app.saveSettings(patch);
    setSettings(next);
    setSaved('Saved.');
  };

  const run = async (fn: () => Promise<{ message: string }>, set: (m: string) => void) => {
    setBusy(true);
    try {
      set((await fn()).message);
    } catch (err) {
      set(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      refresh();
    }
  };

  if (!settings) return <Page title="Inkwise settings" onClose={onClose}><Line>Loading…</Line></Page>;

  return (
    <Page title="Inkwise settings" onClose={onClose}>
      <Section title="Readwise">
        <Line>{connected ? 'Connected to Readwise.' : 'Not connected yet.'}</Line>
        <Field
          label="Access token (from readwise.io/access_token)"
          value={tokenInput}
          onChangeText={setTokenInput}
          placeholder="Paste token"
          secureTextEntry
          autoCapitalize="none"
        />
        <Row>
          <Button label="Save token" primary disabled={busy || !tokenInput.trim()} onPress={() => run(async () => {
            const r = await app.setToken(tokenInput);
            if (r.ok) setTokenInput('');
            return r;
          }, setTokenMsg)} />
          <Button label="Import token file" disabled={busy} onPress={() => run(() => app.importToken(), setTokenMsg)} />
          {connected ? <Button label="Disconnect" disabled={busy} onPress={() => run(async () => {
            await app.clearToken();
            return { message: "Token removed. Inkwise won't use token.txt again until you import it." };
          }, setTokenMsg)} /> : null}
        </Row>
        <Line small>
          Token file location: {TOKEN_IMPORT_PATH.replace(`${STORAGE_ROOT}/`, '')}. Inkwise leaves it there and reads it again by itself after a reinstall.
        </Line>
        {tokenMsg ? <Line strong>{tokenMsg}</Line> : null}
      </Section>

      <Section title="What to sync">
        <Choice
          label="Reader location"
          value={settings.location}
          options={[
            { value: 'later', label: 'Later' },
            { value: 'shortlist', label: 'Shortlist' },
            { value: 'new', label: 'Inbox' },
          ]}
          onChange={(location) => update({ location })}
        />
        <Field label="Only this tag (optional)" defaultValue={settings.tag} onEndEditing={(e) => update({ tag: e.nativeEvent.text })} autoCapitalize="none" />
        <Field
          label="Most articles per sync"
          defaultValue={String(settings.maxArticles)}
          keyboardType="number-pad"
          onEndEditing={(e) => update({ maxArticles: Number(e.nativeEvent.text) })}
        />
        <Toggle label="Images" value={settings.images} onChange={(images) => update({ images })} />
        <Toggle label="Mark highlights in articles" value={settings.showHighlights} onChange={(showHighlights) => update({ showHighlights })} />
        <Field label="Folder inside Document" defaultValue={settings.folderName} onEndEditing={(e) => update({ folderName: e.nativeEvent.text })} />
      </Section>

      <Section title="When you tap Done">
        <Choice
          label="After archiving in Reader (happens on your next sync)"
          value={settings.afterArchive}
          options={[
            { value: 'move', label: 'Move to Archive folder' },
            { value: 'keep', label: 'Keep' },
            { value: 'delete', label: 'Delete' },
          ]}
          onChange={(afterArchive) => update({ afterArchive })}
        />
        <Toggle
          label="On sync, move articles that left the queue to Archive"
          value={settings.removeMissing}
          onChange={(removeMissing) => update({ removeMissing })}
        />
        {saved ? <Line small>{saved}</Line> : null}
      </Section>

      <Section title="Highlight queue">
        {!queue || (!queue.pending.length && !queue.archives) ? <Line>Nothing waiting. Every highlight has been sent.</Line> : null}
        {queue?.archives ? <Line>{queue.archives} archive {queue.archives === 1 ? 'request' : 'requests'} waiting.</Line> : null}
        {queue?.pending.map((h) => {
          const key = { docId: h.docId, createdAt: h.createdAt };
          const id = `${h.docId}-${h.createdAt}`;
          return (
          <Section key={id}>
            <Line small>
              {queue.titles[h.docId] ?? 'Unknown article'} · {h.state === 'pending' ? 'waiting to send' : 'needs attention'}
            </Line>
            <Quote>{h.text}</Quote>
            {h.lastError ? <Line small>{h.lastError}</Line> : null}
            {h.state === 'needs_attention' ? (
              <>
                <Field label="Fix the text to match the article" defaultValue={h.text} multiline onChangeText={(t) => setEdits((e) => ({ ...e, [id]: t }))} />
                <Row>
                  <Button label="Try again" compact disabled={busy} onPress={() => run(() => app.review(key, 'retry', edits[id]), setQueueMsg)} />
                  <Button label="Send standalone" compact disabled={busy} onPress={() => run(() => app.review(key, 'send_classic'), setQueueMsg)} />
                  <Button label="Discard" compact disabled={busy} onPress={() => run(() => app.review(key, 'discard'), setQueueMsg)} />
                </Row>
              </>
            ) : null}
          </Section>
          );
        })}
        {queue?.pending.some((h) => h.state === 'pending') || queue?.archives ? (
          <Row>
            <Button label="Send queued now" disabled={busy} onPress={() => run(async () => ({ message: await app.flush() }), setQueueMsg)} />
          </Row>
        ) : null}
        {queueMsg ? <Line strong>{queueMsg}</Line> : null}
      </Section>
      <Line small>
        Inkwise {BUILD.version} (build {BUILD.commit})
      </Line>
    </Page>
  );
}
