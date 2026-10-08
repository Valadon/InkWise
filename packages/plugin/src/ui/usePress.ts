import { useCallback, useEffect, useRef } from 'react';
import { screens } from '../buttons';

/**
 * Runs `action` once per button press. A press that arrives while the action is
 * still running isn't dropped: the action runs again when the current one ends.
 * Returns a function for re-running by hand (the "Sync again" button).
 */
export function usePressAction(press: number, action: () => Promise<void>): () => void {
  const busy = useRef(false);
  const again = useRef(false);
  const latest = useRef(action);
  latest.current = action;

  const start = useCallback(async () => {
    if (busy.current) {
      again.current = true;
      return;
    }
    busy.current = true;
    try {
      do {
        again.current = false;
        await latest.current().catch(() => {});
      } while (again.current);
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    if (screens.claim(press)) start();
  }, [press, start]);

  return start;
}
