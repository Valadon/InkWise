import React, { useEffect, useMemo, useState } from 'react';
import type { FetchLike } from '@inkwise/core';
import { screens, type Screen } from './src/buttons';
import { closeView, supernoteHost } from './src/host';
import { InkwiseApp } from './src/services/app';
import { joinPath } from './src/services/fs';
import { makeImageFetch, rnfs } from './src/services/rnfs';
import { DoneScreen } from './src/ui/DoneScreen';
import { HighlightScreen } from './src/ui/HighlightScreen';
import { SettingsScreen } from './src/ui/SettingsScreen';
import { SyncScreen } from './src/ui/SyncScreen';

const jsonFetch: FetchLike = (url, init) => fetch(url, init) as unknown as ReturnType<FetchLike>;

function createApp() {
  const app: InkwiseApp = new InkwiseApp(
    supernoteHost,
    rnfs,
    jsonFetch,
    makeImageFetch(rnfs, async () => joinPath(await app.privateDir(), 'tmp')),
  );
  return app;
}

export default function App() {
  const app = useMemo(createApp, []);
  const [screen, setScreen] = useState<Screen>(screens.screen);
  const [run, setRun] = useState(screens.pressCount);

  useEffect(
    () =>
      screens.subscribe((next) => {
        setScreen(next);
        setRun(screens.pressCount);
      }),
    [],
  );

  const openSettings = () => screens.set('settings');

  switch (screen) {
    case 'highlight':
      return <HighlightScreen app={app} run={run} onClose={closeView} onSettings={openSettings} />;
    case 'done':
      return <DoneScreen app={app} run={run} onClose={closeView} />;
    case 'settings':
      return <SettingsScreen app={app} onClose={closeView} />;
    default:
      return <SyncScreen app={app} run={run} onClose={closeView} onSettings={openSettings} />;
  }
}
