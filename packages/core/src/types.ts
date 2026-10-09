/**
 * Shared types. Core never touches Node, the DOM, or the device directly:
 * everything that does IO (HTTP, files, clocks) is passed in.
 */

/** The subset of `fetch` core relies on. Node 18+, React Native and test fakes all satisfy it. */
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<FetchResponseLike>;

export interface FetchResponseLike {
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  json(): Promise<any>;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type Sleep = (ms: number) => Promise<void>;

export type ReaderLocation = 'new' | 'later' | 'shortlist' | 'archive' | 'feed';

export type ReaderCategory =
  | 'article'
  | 'email'
  | 'rss'
  | 'highlight'
  | 'note'
  | 'pdf'
  | 'epub'
  | 'tweet'
  | 'video';

/** Reader categories Inkwise can turn into a readable EPUB (they come with HTML content). */
export const READABLE_CATEGORIES: readonly ReaderCategory[] = ['article', 'email', 'rss', 'tweet'];

/** A document as returned by Reader's `GET /api/v3/list/`. Only fields Inkwise reads are typed strictly. */
export interface ReaderDocument {
  id: string;
  url: string;
  source_url: string | null;
  title: string | null;
  author: string | null;
  source?: string | null;
  category: ReaderCategory | string;
  location: ReaderLocation | string | null;
  tags?: Record<string, unknown> | null;
  site_name?: string | null;
  word_count?: number | null;
  reading_time?: string | number | null;
  created_at: string;
  updated_at: string;
  /** Reader has returned this as an ISO string, a date-only string, and epoch milliseconds. */
  published_date?: string | number | null;
  summary?: string | null;
  image_url?: string | null;
  content?: string | null;
  html_content?: string | null;
  parent_id: string | null;
  notes?: string | null;
  reading_progress?: number | null;
  saved_at?: string | null;
}

export interface ListResponse {
  count: number;
  nextPageCursor: string | null;
  results: ReaderDocument[];
}
