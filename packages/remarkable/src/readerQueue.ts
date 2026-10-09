import { ReadwiseClient, type ListOptions, type ReaderDocument } from '@inkwise/core';

/**
 * The Readwise client the tablet syncs with. Core picks which Reader
 * categories become books (articles, newsletters, feed items, X posts); this
 * counts what it leaves out so the summary can say, and lists books already
 * opened on the tablet as unchanged.
 */
export class TabletReadwiseClient extends ReadwiseClient {
  /** What the last listing left out, by Reader category. */
  skipped: Record<string, number> = {};
  /**
   * Books already opened on the tablet, by Reader ID, with the `updated_at`
   * they were built from. They're never rebuilt (see XochitlOutput.put), so
   * they're listed as unchanged rather than downloaded and built for nothing
   * each time Reader bumps them (it does whenever a highlight arrives).
   */
  readonly opened = new Map<string, string>();

  override async listDocuments(opts: ListOptions = {}): Promise<ReaderDocument[]> {
    this.skipped = {};
    const accept = opts.accept;
    const docs = await super.listDocuments({
      ...opts,
      accept:
        accept &&
        ((doc) => {
          if (accept(doc)) return true;
          this.skipped[doc.category] = (this.skipped[doc.category] ?? 0) + 1;
          return false;
        }),
    });
    return docs.map((doc) => {
      const builtFrom = this.opened.get(doc.id);
      return builtFrom ? { ...doc, updated_at: builtFrom } : doc;
    });
  }
}

const NOUNS: Record<string, [string, string]> = {
  pdf: ['PDF', 'PDFs'],
  epub: ['EPUB', 'EPUBs'],
  video: ['video', 'videos'],
};

/** "Skipped 1 PDF and 2 videos (InkWise only brings over web pages for now)." Empty when nothing was skipped. */
export function describeSkipped(skipped: Record<string, number>): string {
  const parts = Object.entries(skipped)
    .filter(([, n]) => n > 0)
    .map(([category, n]) => {
      const [one, many] = NOUNS[category] ?? [`${category} item`, `${category} items`];
      return `${n} ${n === 1 ? one : many}`;
    });
  if (!parts.length) return '';
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `Skipped ${list} (InkWise only brings over web pages for now).`;
}
