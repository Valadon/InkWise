import React, { useEffect, useRef, useState } from 'react';
import type { InkwiseApp } from '../services/app';
import { Line, Page, Section } from './kit';

export function DoneScreen({ app, run, onClose }: { app: InkwiseApp; run: number; onClose: () => void }) {
  const [message, setMessage] = useState<string | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    if (busy.current) return;
    busy.current = true;
    setMessage(null);
    app
      .done()
      .then((r) => setMessage(r.message))
      .catch((err) => setMessage(err instanceof Error ? err.message : String(err)))
      .finally(() => {
        busy.current = false;
      });
  }, [app, run]);

  return (
    <Page title="Done" onClose={onClose}>
      <Section>
        <Line strong>{message ?? 'Archiving in Reader…'}</Line>
      </Section>
    </Page>
  );
}
