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
export class ScreenStore {
  private current: Screen = 'sync';
  private seq = 0;
  private handled = 0;
  private lastPress = { screen: '' as Screen | '', at: 0 };
  private listeners = new Set<Listener>();

  get screen() {
    return this.current;
  }

  /** Increments on every press, so the same button pressed twice still re-runs its action. */
  get pressCount() {
    return this.seq;
  }

  /**
   * True the first time a press is seen. Screens remount (after visiting
   * settings, say) and must not redo the action for a press already handled.
   */
  claim(press: number): boolean {
    if (press <= this.handled) return false;
    this.handled = press;
    return true;
  }

  /** The same button reported twice within this window counts as one tap. */
  static readonly DOUBLE_TAP_MS = 2000;

  set(screen: Screen, now = Date.now()) {
    const repeat = screen === this.lastPress.screen && now - this.lastPress.at < ScreenStore.DOUBLE_TAP_MS;
    this.lastPress = { screen, at: now };
    if (repeat && screen !== 'settings') return;
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
