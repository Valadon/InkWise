import type { SendResult } from '@inkwise/core';
import { SHADED, type InkwiseApp } from './app';

export type HighlightOutcome = SendResult & { selection?: string; shading?: string };

type Listener = () => void;

/** The latest Send highlight result, shared by the button handler and the highlight screen. */
export class HighlightState {
  sending = false;
  result: HighlightOutcome | null = null;
  private listeners = new Set<Listener>();

  start() {
    this.sending = true;
    this.result = null;
    this.emit();
  }

  finish(result: HighlightOutcome) {
    this.sending = false;
    this.result = result;
    this.emit();
  }

  subscribe(l: Listener) {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }

  private emit() {
    for (const l of this.listeners) l();
  }
}

export const highlightState = new HighlightState();

/**
 * Whether a send needs the highlight screen. A highlight that went through and
 * got shaded speaks for itself, so the user just keeps reading.
 */
export function needsScreen(r: HighlightOutcome): boolean {
  // Re-selected an existing highlight: show its note and Delete.
  if (r.status === 'duplicate') return true;
  if (r.status !== 'sent' && r.status !== 'queued_offline') return true;
  // Shading off or failed: the screen is the only sign it worked.
  return r.shading !== SHADED;
}

/**
 * Send highlight without a popup: send, shade, and only open the plugin view
 * when there's something to show.
 */
export async function quickSend(
  app: InkwiseApp,
  ui: { show(): unknown; close(): unknown },
  state: HighlightState = highlightState,
): Promise<HighlightOutcome | null> {
  if (state.sending) return null;
  state.start();
  let r: HighlightOutcome;
  try {
    r = await app.sendSelection();
  } catch (err) {
    r = { status: 'needs_attention', message: err instanceof Error ? err.message : String(err) };
  }
  state.finish(r);
  try {
    if (needsScreen(r)) await ui.show();
    else await ui.close();
  } catch {
    // The host refusing to show or close the view isn't worth surfacing.
  }
  return r;
}
