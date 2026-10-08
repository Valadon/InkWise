import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const cli = join(repo, 'packages', 'cli', 'dist', 'index.js');

let tmp: string;
let env: NodeJS.ProcessEnv;

beforeAll(async () => {
  // Make sure dist matches src before spawning it.
  await run('npx', ['tsc', '-b', 'packages/cli'], { cwd: repo });
  tmp = await mkdtemp(join(tmpdir(), 'inkwise-e2e-'));
  // A clean environment so the run can't see the real home, config or tokens.
  env = {
    PATH: process.env.PATH,
    HOME: join(tmp, 'home'),
    XDG_CONFIG_HOME: join(tmp, 'xdg'),
  };
}, 120_000);

afterAll(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

const sync = (out: string) => run('node', [cli, 'sync', '--mock', '--target', 'folder', '--out', out], { cwd: tmp, env });

describe('inkwise CLI (built)', () => {
  it('sync --mock writes 4 EPUBs, then a second run has nothing to do', async () => {
    expect(existsSync(cli)).toBe(true);
    const out = join(tmp, 'out');

    const first = await sync(out);
    expect(first.stdout).toContain(`Target: folder (${out})`);
    expect(first.stdout).toContain('Synced 4 new, 0 updated.');
    const files = (await readdir(out)).sort();
    expect(files).toHaveLength(4);
    for (const f of files) {
      expect(f).toMatch(/^[A-Za-z0-9-]+__[A-Za-z0-9]+\.epub$/);
      const b = await readFile(join(out, f));
      expect(b.subarray(0, 4).toString('latin1')).toBe('PK\u0003\u0004');
      expect(b.subarray(30, 38).toString('latin1')).toBe('mimetype');
    }

    // State goes under the fake HOME, never the real one.
    expect(await readdir(join(tmp, 'home', '.inkwise'))).toEqual(['manifest.mock.json']);

    const second = await sync(out);
    expect(second.stdout).toContain('Synced 0 new, 0 updated.');
    expect((await readdir(out)).sort()).toEqual(files);
  }, 60_000);

  it('prints help and the version', async () => {
    const help = await run('node', [cli, '--help'], { cwd: tmp, env });
    expect(help.stdout).toContain('inkwise sync [options]');
    expect(help.stdout).toContain(join(tmp, 'xdg', 'inkwise', 'config.toml'));
    const v = await run('node', [cli, '--version'], { cwd: tmp, env });
    expect(v.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('refuses --mock with a cloud target unless --out is given', async () => {
    const err: any = await run('node', [cli, 'sync', '--mock', '--target', 'supernote-cloud'], { cwd: tmp, env }).catch((e) => e);
    expect(err.code).toBe(1);
    expect(err.stderr).toContain('--out');
  });
});
