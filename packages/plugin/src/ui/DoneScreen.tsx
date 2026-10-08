import React, { useState } from 'react';
import type { InkwiseApp } from '../services/app';
import { Line, Page, Section } from './kit';
import { usePressAction } from './usePress';

export function DoneScreen({ app, run, onClose }: { app: InkwiseApp; run: number; onClose: () => void }) {
  const [message, setMessage] = useState<string | null>(null);
  usePressAction(run, async () => {
    setMessage(null);
    try {
      setMessage((await app.done()).message);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    }
  });

  return (
    <Page title="Done" onClose={onClose}>
      <Section>
        <Line strong>{message ?? 'Archiving in Reader…'}</Line>
      </Section>
    </Page>
  );
}
