import { connectAppLoad, MSG_NEW_COORDINATOR, MSG_TERMINATE, type AppLoadMessage, type Channel } from './appload.js';
import { Librarian, type LibraryControl } from './librarian.js';
import {
  DEFAULT_SETTINGS,
  NoToken,
  SyncBusy,
  isAuthError,
  loadLastSync,
  loadSettings,
  readToken,
  recentLog,
  runSync,
  saveSettings,
  saveToken,
  syncRunning,
  type LastSync,
  type RunOptions,
  type RunResult,
  type Settings,
} from './runner.js';

/**
 * The tablet app's backend. The screen sends small JSON requests; the backend
 * answers every one with the whole app state, so the screen never has to
 * piece anything together. It keeps running after the screen closes and syncs
 * on its own: every few minutes while the tablet is awake, and shortly after
 * it wakes up.
 */

/** Screen to backend. */
export const IN = { hello: 1, sync: 2, settings: 3, token: 4 } as const;
/** Backend to screen: the full state, as JSON. */
export const OUT_STATE = 100;

export interface AppState {
  version: string;
  connected: boolean;
  librarian: boolean;
  syncing: boolean;
  /** The latest progress line while syncing, or a short notice afterwards. */
  progress: string;
  last: LastSync | null;
  settings: Settings;
  /** Recent log lines, newest last. */
  log: string[];
  /** When the next automatic sync is due (ISO), if one is. */
  nextSyncAt: string | null;
  /** Answer to the last token attempt. */
  tokenMessage: string;
}

export interface BackendDeps {
  home: string;
  library: string;
  version: string;
  send: (type: number, contents: string) => void;
  now?: () => number;
  /** Finds librarian. Default: the real probe. */
  findLibrarian?: () => Promise<LibraryControl | null>;
  sync?: (opts: RunOptions) => Promise<RunResult>;
  saveToken?: (home: string, token: string) => Promise<boolean>;
  /** Wait before syncing after the tablet wakes, so Wi-Fi can reconnect. */
  wakeDelayMs?: number;
}

/** A gap this much longer than the tick means the tablet was asleep. */
const SLEEP_GAP_MS = 3 * 60_000;
/** After failing to reach Readwise, try again this soon (or at the normal interval, if sooner). */
const OFFLINE_RETRY_MS = 5 * 60_000;
/** Don't sync on every wake if the last sync was this recent. */
const WAKE_MIN_GAP_MS = 5 * 60_000;
/** Progress lines go to the screen at most this often (e-ink redraws are slow). */
const PROGRESS_EVERY_MS = 1000;

export class InkwiseBackend {
  private settings: Settings = DEFAULT_SETTINGS;
  private last: LastSync | null = null;
  private log: string[] = [];
  private connected = false;
  private librarian: LibraryControl | null = null;
  private syncing: Promise<void> | null = null;
  private progress = '';
  private tokenMessage = '';
  private lastTick: number;
  private lastProgressSent = 0;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: BackendDeps) {
    this.now = deps.now ?? Date.now;
    this.lastTick = this.now();
  }

  async start() {
    this.settings = await loadSettings(this.deps.home);
    this.last = await loadLastSync(this.deps.home);
    this.log = await recentLog(this.deps.home);
    this.connected = !!(await readToken(this.deps.home));
    this.librarian = await this.findLibrarian();
  }

  state(): AppState {
    return {
      version: this.deps.version,
      connected: this.connected,
      librarian: !!this.librarian,
      syncing: this.syncing !== null,
      progress: this.progress,
      last: this.last,
      settings: this.settings,
      log: this.log,
      nextSyncAt: this.nextDue() === null ? null : new Date(this.nextDue()!).toISOString(),
      tokenMessage: this.tokenMessage,
    };
  }

  private push() {
    this.deps.send(OUT_STATE, JSON.stringify(this.state()));
  }

  async handle(msg: AppLoadMessage) {
    let body: Record<string, unknown> = {};
    try {
      body = msg.contents ? JSON.parse(msg.contents) : {};
    } catch {
      // Plain text is fine too; nothing below needs it.
    }
    switch (msg.type) {
      case MSG_NEW_COORDINATOR:
      case IN.hello:
        // A screen opened: refresh what might have changed behind our back (a sync from the terminal).
        this.last = await loadLastSync(this.deps.home);
        this.log = await recentLog(this.deps.home);
        this.connected = !!(await readToken(this.deps.home));
        this.push();
        break;
      case IN.sync:
        void this.syncNow('button');
        break;
      case IN.settings: {
        const patch: Partial<Settings> = {};
        if (typeof body.autoSyncMinutes === 'number' && body.autoSyncMinutes >= 0) patch.autoSyncMinutes = body.autoSyncMinutes;
        if (typeof body.location === 'string' && body.location) patch.location = body.location;
        this.settings = await saveSettings(this.deps.home, patch);
        this.push();
        break;
      }
      case IN.token: {
        const token = typeof body.token === 'string' ? body.token.trim() : '';
        if (!token) break;
        this.tokenMessage = 'Checking with Readwise…';
        this.push();
        try {
          const ok = await (this.deps.saveToken ?? saveToken)(this.deps.home, token);
          this.tokenMessage = ok ? 'Connected to Readwise.' : 'Readwise didn’t accept that token. Copy it again from readwise.io/access_token.';
          if (ok) this.connected = true;
        } catch {
          this.tokenMessage = 'Couldn’t reach Readwise. Check Wi-Fi and try again.';
        }
        this.push();
        if (this.connected && !this.last) void this.syncNow('first');
        break;
      }
    }
  }

  /** Called every 30 s or so. Notices the tablet waking up and runs automatic syncs. */
  tick() {
    const now = this.now();
    const woke = now - this.lastTick > SLEEP_GAP_MS;
    this.lastTick = now;
    if (!this.settings.autoSyncMinutes || !this.connected || this.syncing) return;
    if (woke) {
      const lastAt = this.last ? Date.parse(this.last.at) : 0;
      if (now - lastAt >= WAKE_MIN_GAP_MS && !this.wakeTimer) {
        this.wakeTimer = setTimeout(() => {
          this.wakeTimer = null;
          void this.syncNow('wake');
        }, this.deps.wakeDelayMs ?? 15_000);
      }
      return;
    }
    const due = this.nextDue();
    if (due !== null && now >= due) void this.syncNow('timer');
  }

  /** When the next automatic sync should run, or null if none will. */
  private nextDue(): number | null {
    if (!this.settings.autoSyncMinutes || !this.connected) return null;
    if (!this.last) return this.now();
    const interval = this.settings.autoSyncMinutes * 60_000;
    return Date.parse(this.last.at) + (this.last.offline ? Math.min(interval, OFFLINE_RETRY_MS) : interval);
  }

  /** Runs one sync unless one is already going. Resolves when it's done. */
  syncNow(_why: 'button' | 'timer' | 'wake' | 'first'): Promise<void> {
    if (this.syncing) return this.syncing;
    // Claimed before runOne starts, so its first progress update already says "syncing".
    let done!: () => void;
    this.syncing = new Promise<void>((resolve) => (done = resolve));
    void this.runOne().finally(() => {
      this.syncing = null;
      this.push();
      done();
    });
    return this.syncing;
  }

  /** Resolves once no sync is running. */
  async idle() {
    while (this.syncing) await this.syncing;
  }

  private async runOne() {
    this.progress = 'Starting…';
    this.push();
    if (await syncRunning(this.deps.home)) {
      this.progress = 'A sync started from the terminal is still running.';
      return;
    }
    // Librarian can be installed (or the reading app restarted) while we run.
    this.librarian = await this.findLibrarian();
    try {
      const res = await (this.deps.sync ?? runSync)({
        home: this.deps.home,
        library: this.deps.library,
        libraryControl: this.librarian,
        onLine: (line) => {
          this.progress = line;
          const now = this.now();
          if (now - this.lastProgressSent >= PROGRESS_EVERY_MS) {
            this.lastProgressSent = now;
            this.push();
          }
        },
      });
      const { error: _error, changed: _changed, librarian: _librarian, ...last } = res;
      this.last = last;
      if (isAuthError(res.error)) this.connected = false;
      // The app never restarts the reading app: it runs inside it, and could be mid-page.
      this.progress = res.waitingForRestart ? 'New articles will appear after the reading app restarts. Install librarian in reManager to skip that.' : '';
    } catch (err) {
      if (err instanceof NoToken) {
        this.connected = false;
        this.progress = 'Connect to Readwise first.';
      } else if (err instanceof SyncBusy) {
        this.progress = err.message;
      } else {
        this.progress = err instanceof Error ? err.message : String(err);
      }
    }
    this.log = await recentLog(this.deps.home);
  }

  private findLibrarian() {
    return (this.deps.findLibrarian ?? (() => Librarian.connect()))();
  }

  stop() {
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
  }
}

const TICK_MS = 30_000;

/** Runs the backend until AppLoad closes the connection. */
export async function runBackend(opts: { socketPath: string; home: string; library: string; version: string }) {
  const channel: Channel = await connectAppLoad(opts.socketPath);
  const backend = new InkwiseBackend({ ...opts, send: (type, contents) => channel.send(type, contents) });
  await backend.start();
  const ticker = setInterval(() => backend.tick(), TICK_MS);
  try {
    for (;;) {
      const msg = await channel.next();
      if (!msg || msg.type === MSG_TERMINATE) break;
      await backend.handle(msg).catch((err) => console.error('[inkwise]', err));
    }
  } finally {
    clearInterval(ticker);
    backend.stop();
    channel.close();
  }
  // AppLoad doesn't kill the backend, so a sync that's under way gets to finish.
  await backend.idle();
}
