import { useCallback, useEffect, useRef } from 'react';
import { screens } from '../buttons';

/**
 * Runs `action` once per button press. Presses that arrive while the action is
 * still running are ignored: on the Manta one tap can reach the plugin more than
 * once, and re-running a sync straight away replaced "Synced 3 new" with
 * "Synced 0 new". Returns a function for re-running by hand ("Sync again").
 */
export function usePressAction(press: number, action: () => Promise<void>): () => void {
  const busy = useRef(false);
  const latest = useRef(action);
  latest.current = action;

  const start = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      await latest.current().catch(() => {});
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    if (screens.claim(press)) start();
  }, [press, start]);

  return start;
}
