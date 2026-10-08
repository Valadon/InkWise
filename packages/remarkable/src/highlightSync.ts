import { sendHighlight, type ManifestStore, type ReadwiseClient, type SendStatus } from '@inkwise/core';
import type { XochitlOutput } from './xochitl.js';

export interface DeviceHighlightResult {
  /** How many highlights ended in each state; `duplicate` means already in Readwise. */
  counts: Partial<Record<SendStatus, number>>;
  /** Pieces that couldn't be placed in the book's text (sent as-is; Readwise may reject them). */
  unlocated: number;
}

/**
 * Every highlight on every Inkwise document, sent to Readwise. Safe to run on
 * each sync: highlights already sent are recognised locally and skipped.
 */
export async function sendDeviceHighlights(deps: {
  client: ReadwiseClient;
  manifest: ManifestStore;
  output: XochitlOutput;
}): Promise<DeviceHighlightResult> {
  const result: DeviceHighlightResult = { counts: {}, unlocated: 0 };
  for (const { filename, uuid } of await deps.output.documents()) {
    for (const h of await deps.output.highlights(uuid)) {
      if (!h.located) result.unlocated++;
      // The Inkwise filename carries the Reader id, which is how core finds the document.
      const r = await sendHighlight({ client: deps.client, manifest: deps.manifest, filePath: filename, text: h.text });
      result.counts[r.status] = (result.counts[r.status] ?? 0) + 1;
    }
  }
  return result;
}
