import React, { useEffect, useState } from 'react';
import { app } from './src/appInstance';
import { screens, type Screen } from './src/buttons';
import { closeView } from './src/host';
import { DoneScreen } from './src/ui/DoneScreen';
import { HighlightScreen } from './src/ui/HighlightScreen';
import { SettingsScreen } from './src/ui/SettingsScreen';
import { SyncScreen } from './src/ui/SyncScreen';

export default function App() {
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
      return <HighlightScreen app={app} onClose={closeView} onSettings={openSettings} />;
    case 'done':
      return <DoneScreen app={app} run={run} onClose={closeView} />;
    case 'settings':
      return <SettingsScreen app={app} onClose={closeView} />;
    default:
      return <SyncScreen app={app} run={run} onClose={closeView} onSettings={openSettings} />;
  }
}
