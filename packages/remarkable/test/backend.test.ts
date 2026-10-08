import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MSG_NEW_COORDINATOR } from '../src/appload.js';
import { IN, InkwiseBackend, OUT_STATE, type AppState, type BackendDeps } from '../src/backend.js';
import { NoToken, type RunOptions, type RunResult } from '../src/runner.js';

let dir: string;
let clock: number;
let sent: AppState[];
let runs: RunOptions[];
let result: Partial<RunResult>;

function backend(extra: Partial<BackendDeps> = {}) {
  return new InkwiseBackend({
    home: dir,
    library: join(dir, 'xochitl'),
    version: 'test',
    send: (type, contents) => {
      expect(type).toBe(OUT_STATE);
      sent.push(JSON.parse(contents));
    },
    now: () => clock,
    findLibrarian: async () => null,
    wakeDelayMs: 0,
    sync: async (opts) => {
      runs.push(opts);
      opts.onLine?.('Found 1 article.');
      return {
        at: new Date(clock).toISOString(),
        ok: true,
        summary: 'Synced 1 new, 0 updated.',
        added: 1,
        highlightsSent: 0,
        waitingForRestart: false,
        changed: true,
        librarian: false,
        ...result,
      } as RunResult;
    },
    ...extra,
  });
}

const last = () => sent[sent.length - 1]!;
const MIN = 60_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'inkwise-be-'));
  clock = Date.parse('2026-10-08T20:00:00Z');
  sent = [];
  runs = [];
  result = {};
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('InkwiseBackend', () => {
  it('answers a new screen with the whole state', async () => {
    const b = backend();
    await b.start();
    await b.handle({ type: MSG_NEW_COORDINATOR, contents: '1' });
    expect(last()).toMatchObject({ version: 'test', connected: false, librarian: false, syncing: false, last: null, settings: { autoSyncMinutes: 30 } });
    expect(last().nextSyncAt).toBeNull(); // nothing automatic until connected
  });

  it('saves a token Readwise accepts, then syncs for the first time', async () => {
    const b = backend({ saveToken: async (_home, token) => token === 'good' });
    await b.start();
    await b.handle({ type: IN.token, contents: JSON.stringify({ token: 'bad' }) });
    expect(last()).toMatchObject({ connected: false, tokenMessage: expect.stringContaining('didn’t accept') });
    await b.handle({ type: IN.token, contents: JSON.stringify({ token: ' good ' }) });
    await b.syncNow('button'); // waits for the first sync the token started
    expect(runs).toHaveLength(1);
    expect(last()).toMatchObject({ connected: true, syncing: false, last: { summary: 'Synced 1 new, 0 updated.' } });
  });

  it('runs one sync at a time and reports progress', async () => {
    writeFileSync(join(dir, 'token'), 't');
    const b = backend();
    await b.start();
    const a = b.syncNow('button');
    const again = b.syncNow('button');
    expect(again).toBe(a);
    await a;
    expect(runs).toHaveLength(1);
    expect(sent.some((s) => s.syncing && s.progress === 'Found 1 article.')).toBe(true);
    expect(last()).toMatchObject({ syncing: false, progress: '' });
    expect(Object.keys(last().last!)).not.toContain('error');
  });

  it('syncs on the interval while awake', async () => {
    writeFileSync(join(dir, 'token'), 't');
    const b = backend();
    await b.start();
    await b.syncNow('first');
    for (let t = 0; t < 29; t++) {
      clock += MIN;
      b.tick();
    }
    expect(runs).toHaveLength(1);
    clock += MIN;
    b.tick();
    await b.syncNow('timer');
    expect(runs).toHaveLength(2);
  });

  it('retries sooner after failing to reach Readwise', async () => {
    writeFileSync(join(dir, 'token'), 't');
    result = { ok: false, offline: true, summary: 'No connection to Readwise. Check Wi-Fi and try again.' };
    const b = backend();
    await b.start();
    await b.syncNow('first');
    expect(Date.parse(last().nextSyncAt!) - clock).toBe(5 * MIN);
  });

  it('syncs shortly after the tablet wakes up', async () => {
    vi.useFakeTimers();
    writeFileSync(join(dir, 'token'), 't');
    const b = backend();
    await b.start();
    await b.syncNow('first');
    clock += 2 * 60 * MIN; // asleep for two hours: no ticks
    b.tick();
    expect(runs).toHaveLength(1);
    await vi.runOnlyPendingTimersAsync();
    await b.syncNow('wake');
    expect(runs).toHaveLength(2);
  });

  it('stays quiet when automatic sync is off', async () => {
    writeFileSync(join(dir, 'token'), 't');
    const b = backend();
    await b.start();
    await b.handle({ type: IN.settings, contents: JSON.stringify({ autoSyncMinutes: 0 }) });
    expect(last()).toMatchObject({ settings: { autoSyncMinutes: 0 }, nextSyncAt: null });
    clock += 600 * MIN;
    b.tick();
    expect(runs).toHaveLength(0);
  });

  it('notices when the token is gone', async () => {
    writeFileSync(join(dir, 'token'), 't');
    const b = backend({
      sync: async () => {
        throw new NoToken();
      },
    });
    await b.start();
    await b.syncNow('button');
    expect(last()).toMatchObject({ connected: false, progress: 'Connect to Readwise first.' });
  });
});
