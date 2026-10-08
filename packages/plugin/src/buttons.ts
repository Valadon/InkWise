/** Stable button ids. Never renumber them: the host echoes these back on press. */
export const BUTTON = {
  SYNC: 100,
  DONE: 101,
  SEND_HIGHLIGHT: 300,
} as const;

export type Screen = 'sync' | 'highlight' | 'done' | 'settings';

type Listener = (screen: Screen) => void;

/**
 * Remembers which button opened the plugin view. Button presses arrive at module
 * level (index.js) and the React tree may mount after them.
 */
class ScreenStore {
  private current: Screen = 'sync';
  private seq = 0;
  private listeners = new Set<Listener>();

  get screen() {
    return this.current;
  }

  /** Increments on every press, so the same button pressed twice still re-runs its action. */
  get pressCount() {
    return this.seq;
  }

  set(screen: Screen) {
    this.current = screen;
    this.seq++;
    for (const l of this.listeners) l(screen);
  }

  subscribe(l: Listener) {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }
}

export const screens = new ScreenStore();

export function screenForButton(id: number): Screen | null {
  switch (id) {
    case BUTTON.SYNC:
      return 'sync';
    case BUTTON.DONE:
      return 'done';
    case BUTTON.SEND_HIGHLIGHT:
      return 'highlight';
    default:
      return null;
  }
}
