import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SyncBusy, inkwisePaths, loadLastSync, loadSettings, recentLog, runSync, saveSettings, withSyncLock } from '../src/runner.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'inkwise-run-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('settings', () => {
  it('defaults to syncing every 30 minutes from Later, and keeps what was saved', async () => {
    expect(await loadSettings(dir)).toEqual({ autoSyncMinutes: 30, location: 'later' });
    await saveSettings(dir, { autoSyncMinutes: 0 });
    expect(await loadSettings(dir)).toEqual({ autoSyncMinutes: 0, location: 'later' });
  });
});

describe('withSyncLock', () => {
  it('lets one sync run at a time', async () => {
    let inner: unknown;
    await withSyncLock(dir, async () => {
      inner = await withSyncLock(dir, async () => 'ran').catch((e) => e);
    });
    expect(inner).toBeInstanceOf(SyncBusy);
    expect(await withSyncLock(dir, async () => 'free again')).toBe('free again');
  });

  it('takes over a lock left by a process that is gone', async () => {
    writeFileSync(inkwisePaths(dir).lock, '999999999');
    expect(await withSyncLock(dir, async () => 'ok')).toBe('ok');
  });
});

describe('runSync', () => {
  it('saves the result and a log line for the app', async () => {
    const lines: string[] = [];
    const now = () => new Date('2026-10-08T23:30:00Z');
    const res = await runSync({ home: dir, library: join(dir, 'xochitl'), mock: true, libraryControl: null, onLine: (l) => lines.push(l), now });
    expect(res).toMatchObject({ ok: true, added: 1, waitingForRestart: true, librarian: false });
    expect(res.summary).toBe('Synced 1 new, 0 updated.');
    expect(lines).toContain('Found 1 article.');
    expect(await loadLastSync(dir, true)).toMatchObject({ at: '2026-10-08T23:30:00.000Z', ok: true, added: 1 });
    expect(await recentLog(dir, true)).toEqual(['2026-10-08T23:30:00.000Z Synced 1 new, 0 updated.']);
    expect(readdirSync(join(dir, 'xochitl')).filter((n) => n.endsWith('.epub'))).toHaveLength(1);
    // The lock is gone afterwards.
    expect(readdirSync(dir)).not.toContain('sync.lock');
  });

  it('records a failure instead of throwing it', async () => {
    writeFileSync(join(dir, 'token'), 'x');
    const failing = async () => {
      throw new TypeError('fetch failed');
    };
    const realFetch = globalThis.fetch;
    globalThis.fetch = failing as any;
    const res = await runSync({ home: dir, library: join(dir, 'xochitl'), libraryControl: null }).finally(() => {
      globalThis.fetch = realFetch;
    });
    expect(res.ok).toBe(false);
    expect(res.offline).toBe(true);
    expect((await loadLastSync(dir))?.summary).toBe(res.summary);
  });
});
