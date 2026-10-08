import React, { useState } from 'react';
import type { InkwiseApp } from '../services/app';
import { Button, Line, Page, Row, Section } from './kit';
import { usePressAction } from './usePress';

const MAX_LINES = 8;

export function SyncScreen({ app, run, onClose, onSettings }: { app: InkwiseApp; run: number; onClose: () => void; onSettings: () => void }) {
  const [lines, setLines] = useState<string[]>([]);
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [needsToken, setNeedsToken] = useState(false);
  const sync = usePressAction(run, async () => {
    setBusy(true);
    setResult(null);
    setLines([]);
    try {
      if (!(await app.hasToken())) {
        setNeedsToken(true);
        return;
      }
      setNeedsToken(false);
      const summary = await app.sync((line) => setLines((prev) => [...prev, line].slice(-MAX_LINES)));
      setResult(summary);
    } finally {
      setBusy(false);
    }
  });

  return (
    <Page title="Sync Reader" onClose={onClose}>
      {needsToken ? (
        <Section>
          <Line strong>Connect Readwise first.</Line>
          <Line>Open settings and paste your access token from readwise.io/access_token, or put it in MyStyle/Inkwise/token.txt and import it.</Line>
          <Row>
            <Button label="Open settings" primary onPress={onSettings} />
          </Row>
        </Section>
      ) : (
        <Section>
          {lines.map((l, i) => (
            <Line key={`${i}-${l}`} small>
              {l}
            </Line>
          ))}
          {result ? <Line strong>{result}</Line> : busy ? <Line strong>Working…</Line> : null}
          {result ? <Line small>New articles are in Document/Inkwise.</Line> : null}
        </Section>
      )}
      <Row>
        <Button label="Sync again" onPress={sync} disabled={busy} />
        <Button label="Settings" onPress={onSettings} />
      </Row>
    </Page>
  );
}
