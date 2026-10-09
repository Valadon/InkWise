import { ReadwiseClient, type ListOptions, type ReaderDocument } from '@inkwise/core';

/**
 * Reader categories that become books on the tablet: everything Reader keeps
 * as a web page. Reader files a saved X or Twitter post as `tweet` and a
 * newsletter as `email`, so pulling `article` alone missed them. PDFs, EPUBs
 * and videos stay in Reader for now.
 */
export const TABLET_CATEGORIES: ReadonlySet<string> = new Set(['article', 'email', 'rss', 'tweet']);

/**
 * The Readwise client the tablet syncs with. Core asks for one category at a
 * time; when the sync asks for all of them, this lists the whole location once
 * and keeps the web pages, counting what it leaves out so the summary can say.
 */
export class TabletReadwiseClient extends ReadwiseClient {
  /** What the last listing left out, by Reader category (`empty` for pages with no text). */
  skipped: Record<string, number> = {};
  /**
   * Books already opened on the tablet, by Reader ID, with the `updated_at`
   * they were built from. They're never rebuilt (see XochitlOutput.put), so
   * they're listed as unchanged rather than downloaded and built for nothing
   * each time Reader bumps them (it does whenever a highlight arrives).
   */
  readonly opened = new Map<string, string>();

  override async listDocuments(opts: ListOptions = {}): Promise<ReaderDocument[]> {
    if (opts.category) return super.listDocuments(opts);
    // The limit counts what's kept, so it can't cut the listing short.
    const docs = await super.listDocuments({ ...opts, limit: undefined });
    this.skipped = {};
    const out: ReaderDocument[] = [];
    for (const doc of docs) {
      const blank = opts.withHtmlContent && !(doc.html_content || doc.content || '').trim();
      const left = !TABLET_CATEGORIES.has(doc.category) ? doc.category : blank ? 'empty' : null;
      if (left) {
        this.skipped[left] = (this.skipped[left] ?? 0) + 1;
        continue;
      }
      const builtFrom = this.opened.get(doc.id);
      out.push(builtFrom ? { ...doc, updated_at: builtFrom } : doc);
      if (opts.limit && out.length >= opts.limit) break;
    }
    return out;
  }
}

const NOUNS: Record<string, [string, string]> = {
  pdf: ['PDF', 'PDFs'],
  epub: ['EPUB', 'EPUBs'],
  video: ['video', 'videos'],
  empty: ['page with no text', 'pages with no text'],
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
