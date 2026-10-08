import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';

let dir: string;
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('inkwise-rm', () => {
  it('puts the test article on the tablet with --mock, once', async () => {
    dir = mkdtempSync(join(tmpdir(), 'inkwise-cli-'));
    vi.stubEnv('INKWISE_DIR', join(dir, 'inkwise'));
    vi.stubEnv('XOCHITL_DIR', join(dir, 'xochitl'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(await main(['sync', '--mock', '--no-restart'])).toBe(0);
    expect(log.mock.calls.flat().join('\n')).toContain('Synced 1 new');
    expect(readdirSync(join(dir, 'xochitl')).filter((n) => n.endsWith('.epub'))).toHaveLength(1);

    log.mockClear();
    expect(await main(['sync', '--mock', '--no-restart'])).toBe(0);
    expect(log.mock.calls.flat().join('\n')).toContain('Synced 0 new');
  });

  it('asks for a token before a real sync', async () => {
    dir = mkdtempSync(join(tmpdir(), 'inkwise-cli-'));
    vi.stubEnv('INKWISE_DIR', join(dir, 'inkwise'));
    vi.stubEnv('READWISE_TOKEN', '');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await main(['sync'])).toBe(1);
    expect(err.mock.calls.flat().join('\n')).toContain('inkwise-rm connect');
  });
});
