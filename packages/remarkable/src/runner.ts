import { appendFile, chmod, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ReadwiseClient, ReadwiseError, describeSyncError, NetworkError, summarize, syncReader, textManifestStore, type FetchLike } from '@inkwise/core';
import { FakeReadwise } from '@inkwise/core/testing';
import { sendDeviceHighlights } from './highlightSync.js';
import { Librarian, type LibraryControl } from './librarian.js';
import { TabletReadwiseClient, describeSkipped } from './readerQueue.js';
import { highlightColorName } from './rmHighlights.js';
import { SAMPLE_DOCUMENT } from './sample.js';
import { XOCHITL_DIR, XochitlOutput } from './xochitl.js';

/**
 * One sync, shared by the `inkwise-rm` command and the tablet app: highlights
 * go to Readwise, then Reader articles come to the tablet. Only one runs at a
 * time (a lock file), and each run leaves its result in `status.json` and a
 * line in `log.txt` for the app to show.
 */

export interface Settings {
  /** Minutes between automatic syncs; 0 turns them off. */
  autoSyncMinutes: number;
  /** Reader location to pull from. */
  location: string;
}

export const DEFAULT_SETTINGS: Settings = { autoSyncMinutes: 30, location: 'later' };

export interface LastSync {
  /** ISO time the sync finished. */
  at: string;
  ok: boolean;
  /** One line for people, e.g. "Synced 2 new, 0 updated. Sent 3 highlights." */
  summary: string;
  /** True when the run couldn't reach Readwise (worth retrying soon). */
  offline?: boolean;
  added: number;
  highlightsSent: number;
  /** New articles are on disk but the reading app won't show them until it restarts. */
  waitingForRestart: boolean;
  /** The sync's warnings, so the next one can tell which are new. */
  warnings?: string[];
}

export class SyncBusy extends Error {
  constructor() {
    super('A sync is already running.');
  }
}

/** Where everything lives. Mock runs keep their own state so the test article never mixes with real ones. */
export function inkwisePaths(home: string, mock = false) {
  const base = mock ? join(home, 'mock') : home;
  return {
    token: join(home, 'token'),
    settings: join(home, 'settings.json'),
    lock: join(home, 'sync.lock'),
    manifest: join(base, 'manifest.json'),
    library: join(base, 'library.json'),
    status: join(base, 'status.json'),
    log: join(base, 'log.txt'),
  };
}

export async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw err;
  }
}

export async function writeText(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, text);
  await rename(`${path}.tmp`, path);
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse((await readText(path)) ?? 'null');
  } catch {
    return null;
  }
}

export async function loadSettings(home: string): Promise<Settings> {
  const s = (await readJson<Partial<Settings>>(inkwisePaths(home).settings)) ?? {};
  return {
    autoSyncMinutes: typeof s.autoSyncMinutes === 'number' && s.autoSyncMinutes >= 0 ? s.autoSyncMinutes : DEFAULT_SETTINGS.autoSyncMinutes,
    location: typeof s.location === 'string' && s.location ? s.location : DEFAULT_SETTINGS.location,
  };
}

export async function saveSettings(home: string, patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await loadSettings(home)), ...patch };
  await writeText(inkwisePaths(home).settings, JSON.stringify(next, null, 2));
  return next;
}

export async function loadLastSync(home: string, mock = false): Promise<LastSync | null> {
  return readJson<LastSync>(inkwisePaths(home, mock).status);
}

export async function readToken(home: string): Promise<string> {
  return (process.env.READWISE_TOKEN ?? (await readText(inkwisePaths(home).token)) ?? '').trim();
}

/** Last lines of the sync log, oldest first. */
export async function recentLog(home: string, mock = false, lines = 20): Promise<string[]> {
  const text = (await readText(inkwisePaths(home, mock).log)) ?? '';
  return text.split('\n').filter(Boolean).slice(-lines);
}

const LOG_KEEP = 300;

async function appendLog(path: string, lines: string[]) {
  if (!lines.length) return;
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, lines.map((l) => `${l}\n`).join(''));
  const all = ((await readText(path)) ?? '').split('\n').filter(Boolean);
  if (all.length > LOG_KEEP * 2) await writeText(path, `${all.slice(-LOG_KEEP).join('\n')}\n`);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Runs `fn` holding the sync lock. A lock left by a process that's gone is taken over. */
export async function withSyncLock<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const lock = inkwisePaths(home).lock;
  await mkdir(dirname(lock), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try {
      const fh = await open(lock, 'wx');
      await fh.writeFile(String(process.pid));
      await fh.close();
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const pid = Number((await readText(lock)) ?? '');
      if (attempt > 0 || (pid && alive(pid))) throw new SyncBusy();
      await rm(lock, { force: true });
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lock, { force: true });
  }
}

/** Is someone else syncing right now? */
export async function syncRunning(home: string): Promise<boolean> {
  const pid = Number((await readText(inkwisePaths(home).lock)) ?? '');
  return !!pid && alive(pid);
}

const realFetch: FetchLike = (url, init) => fetch(url, init as RequestInit) as any;

export interface RunOptions {
  home: string;
  /** xochitl's library directory. */
  library?: string;
  mock?: boolean;
  limit?: number;
  location?: string;
  dryRun?: boolean;
  /** The reading app, through librarian. Undefined: look for it. */
  libraryControl?: LibraryControl | null;
  /** Progress, highlight by highlight and article by article. */
  onLine?: (line: string) => void;
  now?: () => Date;
}

export interface RunResult extends LastSync {
  /** Something in the library changed. */
  changed: boolean;
  librarian: boolean;
  error?: unknown;
}

/** Readwise turned the token down (revoked, or mistyped). */
export function isAuthError(err: unknown): boolean {
  return err instanceof ReadwiseError && (err.status === 401 || err.status === 403);
}

export class NoToken extends Error {
  constructor() {
    super('No Readwise token yet. Run: inkwise-rm connect');
  }
}

/**
 * One full sync. Never restarts the reading app; when it needs one,
 * `waitingForRestart` says so and the caller decides. Errors don't throw:
 * they come back as `ok: false` with `error` set, after the status is saved.
 */
export async function runSync(opts: RunOptions): Promise<RunResult> {
  const now = opts.now ?? (() => new Date());
  const p = inkwisePaths(opts.home, opts.mock);
  /** What goes in the log: highlights sent and warnings, then the summary. */
  const logged: string[] = [];
  const say = (line: string, log = false) => {
    opts.onLine?.(line);
    if (log) logged.push(line.length > 160 ? `${line.slice(0, 157)}…` : line);
  };

  return withSyncLock(opts.home, async () => {
    const settings = await loadSettings(opts.home);
    let client: TabletReadwiseClient;
    let imageFetch: FetchLike | undefined = realFetch;
    if (opts.mock) {
      const fake = new FakeReadwise({ documents: [SAMPLE_DOCUMENT] });
      client = new TabletReadwiseClient({ token: fake.token, fetch: fake.fetch, sleep: async () => {} });
      imageFetch = undefined;
    } else {
      const token = await readToken(opts.home);
      if (!token) throw new NoToken();
      client = new TabletReadwiseClient({ token, fetch: realFetch, onRateLimit: (s) => say(`Readwise asked us to wait ${s}s…`) });
    }
    const manifest = textManifestStore({ read: () => readText(p.manifest), write: (t) => writeText(p.manifest, t) });
    const libraryControl = opts.libraryControl === undefined ? await Librarian.connect() : opts.libraryControl;
    const output = new XochitlOutput({ dir: opts.library ?? XOCHITL_DIR, stateFile: p.library, library: libraryControl });

    let added = 0;
    let highlightsSent = 0;
    let warnings: string[] = [];
    let summary = '';
    let error: unknown;
    try {
      if (!opts.dryRun) {
        const sent = await sendDeviceHighlights({
          client,
          manifest,
          output,
          onHighlight: (_file, h, status) => {
            if (status !== 'duplicate') say(`[${status}] (${highlightColorName(h)}) ${h.text.replace(/\s+/g, ' ')}`, true);
          },
        });
        const c = sent.counts;
        highlightsSent = c.sent ?? 0;
        say(`Highlights: ${c.sent ?? 0} sent, ${c.duplicate ?? 0} already in Readwise, ${(c.queued_offline ?? 0) + (c.needs_attention ?? 0)} waiting.`);
      }
      const built = (await manifest.load()).documents;
      for (const id of await output.openedReaderIds()) {
        if (built[id]?.updatedAt) client.opened.set(id, built[id].updatedAt);
      }
      const result = await syncReader(
        { client, output, manifest, fetchImages: imageFetch, onProgress: (m) => say(m), now },
        { location: opts.location ?? settings.location, limit: opts.limit, dryRun: opts.dryRun, showHighlights: false, includeImages: !!imageFetch },
      );
      warnings = result.warnings;
      // A warning the last sync already logged (a PDF still in Later, a picture
      // that can't be shown) isn't logged again every half hour.
      const seen = new Set((await loadLastSync(opts.home, opts.mock))?.warnings ?? []);
      for (const w of warnings) say(`warning: ${w}`, !seen.has(w));
      // Reader bumps an article whenever it gets a highlight, so core asks to rebuild it;
      // books already opened on the tablet are left as they are (see XochitlOutput.put).
      const kept = result.items.filter((i) => i.action === 'updated' && output.kept.has(i.filename)).length;
      added = result.added;
      summary = summarize({ ...result, updated: result.updated - kept }, !!opts.dryRun);
      if (highlightsSent) summary += ` Sent ${highlightsSent} ${highlightsSent === 1 ? 'highlight' : 'highlights'} to Readwise.`;
      highlightsSent += result.highlights.sent;
      if (kept) summary += ` Left ${kept} ${kept === 1 ? 'article' : 'articles'} you've opened as ${kept === 1 ? 'it is' : 'they are'}.`;
      const skipped = describeSkipped(client.skipped);
      if (skipped) summary += ` ${skipped}`;
    } catch (err) {
      error = err;
      summary = isAuthError(err)
        ? 'Readwise didn’t accept the saved token. Enter it again in the InkWise app (or run: inkwise-rm connect).'
        : describeSyncError(err);
    }
    // Even after a failure, whatever did get written should show up.
    if (!opts.dryRun) await output.finish();

    const res: RunResult = {
      at: now().toISOString(),
      ok: !error,
      summary,
      offline: error instanceof NetworkError || undefined,
      added,
      highlightsSent,
      waitingForRestart: output.needsRestart,
      warnings,
      changed: output.changed,
      librarian: !!libraryControl,
      error,
    };
    if (!opts.dryRun) {
      const { error: _e, changed: _c, librarian: _l, ...last } = res;
      await writeText(p.status, JSON.stringify(last, null, 2));
      // ISO time first: the app shows it in the tablet's own time zone.
      await appendLog(p.log, [...logged, summary].map((l) => `${res.at} ${l}`));
    }
    return res;
  });
}

/** Checks the token with Readwise and saves it if it works. */
export async function saveToken(home: string, token: string): Promise<boolean> {
  const ok = await new ReadwiseClient({ token, fetch: realFetch }).validateToken();
  if (!ok) return false;
  const path = inkwisePaths(home).token;
  await writeText(path, token);
  await chmod(path, 0o600);
  return true;
}
