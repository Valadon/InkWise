import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'smol-toml';
import {
  DEFAULT_CONFIG,
  SAMPLE_CONFIG,
  assertTarget,
  configDir,
  configPath,
  expandHome,
  loadConfig,
  readSession,
  sessionPath,
  writeSession,
} from '../src/config.js';

let dir: string;
const savedEnv = { ...process.env };
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'inkwise-config-'));
  delete process.env.SUPERNOTE_CLOUD_TOKEN;
  delete process.env.INKWISE_CONFIG;
  delete process.env.XDG_CONFIG_HOME;
});
afterEach(async () => {
  process.env = { ...savedEnv };
  await rm(dir, { recursive: true, force: true });
});

async function configFrom(toml: string) {
  const p = join(dir, 'config.toml');
  await writeFile(p, toml);
  return loadConfig(p);
}

describe('loadConfig', () => {
  it('returns the defaults when the file is missing', async () => {
    expect(await loadConfig(join(dir, 'missing.toml'))).toEqual(DEFAULT_CONFIG);
  });

  it('returns a copy, not the shared defaults object', async () => {
    const c = await loadConfig(join(dir, 'missing.toml'));
    c.tags.push('x');
    c.dropbox.root = '/changed';
    expect(DEFAULT_CONFIG.tags).toEqual([]);
    expect(DEFAULT_CONFIG.dropbox.root).toBe('/Supernote/Document');
  });

  it('parses every key', async () => {
    const c = await configFrom(`
target = "dropbox"
location = "shortlist"
category = "pdf"
tags = ["supernote", "long-read"]
limit = 7
images = false
remove_missing = true
remove_mode = "delete"
state_dir = "${join(dir, 'state')}"

[folder]
path = "${join(dir, 'out')}"

[dropbox]
mode = "api"
root = "/Apps/Supernote/Document"
path = "${join(dir, 'Dropbox')}"

[gdrive]
mode = "api"
folder_id = "fakeFolderId123"
path = "${join(dir, 'Drive')}"

[supernote_cloud]
folder = "Document/Reading"
`);
    expect(c).toEqual({
      target: 'dropbox',
      location: 'shortlist',
      category: 'pdf',
      tags: ['supernote', 'long-read'],
      limit: 7,
      images: false,
      removeMissing: true,
      removeMode: 'delete',
      stateDir: join(dir, 'state'),
      folder: { path: join(dir, 'out') },
      dropbox: { mode: 'api', root: '/Apps/Supernote/Document', path: join(dir, 'Dropbox') },
      gdrive: { mode: 'api', folderId: 'fakeFolderId123', path: join(dir, 'Drive') },
      supernoteCloud: { folder: 'Document/Reading' },
    });
  });

  it('maps category "all" to null and expands ~ in paths', async () => {
    const c = await configFrom(`category = "all"\nstate_dir = "~/inkwise-state"\n[folder]\npath = "~"\n`);
    expect(c.category).toBeNull();
    expect(c.stateDir).toBe(join(homedir(), 'inkwise-state'));
    expect(c.folder.path).toBe(homedir());
  });

  it('ignores invalid enum values and keeps defaults', async () => {
    const c = await configFrom(`remove_mode = "shred"\n[dropbox]\nmode = "ftp"\n[gdrive]\nmode = "carrier-pigeon"\n`);
    expect(c.removeMode).toBe('archive-folder');
    expect(c.dropbox.mode).toBe('folder');
    expect(c.gdrive.mode).toBe('folder');
  });

  it('rejects an unknown target', async () => {
    await expect(configFrom(`target = "floppy"`)).rejects.toThrow(/Unknown target "floppy"/);
  });

  it('rejects malformed TOML with the path in the message', async () => {
    await expect(configFrom(`target = `)).rejects.toThrow(/Could not read .*config\.toml/);
  });

  for (const key of ['token', 'readwise_token', 'password', 'access_token']) {
    it(`rejects a top-level secret: ${key}`, async () => {
      await expect(configFrom(`${key} = "x"`)).rejects.toThrow(new RegExp(`contains "${key}".*environment variables`));
    });
  }

  it('rejects secrets inside a section too', async () => {
    await expect(configFrom(`[dropbox]\nmode = "api"\naccess_token = "x"\n`)).rejects.toThrow(/"dropbox\.access_token"/);
    await expect(configFrom(`[supernote_cloud]\npassword = "x"\n`)).rejects.toThrow(/environment variables/);
  });

  it('the sample config parses and contains no secrets', async () => {
    const c = await configFrom(SAMPLE_CONFIG);
    expect(c.target).toBe('supernote-cloud');
    expect(c.dropbox.root).toBe('/Supernote/Document');
    expect(parse(SAMPLE_CONFIG)).not.toHaveProperty('token');
  });
});

describe('config paths', () => {
  it('uses XDG_CONFIG_HOME when set, else ~/.config', () => {
    expect(configDir()).toBe(join(homedir(), '.config', 'inkwise'));
    process.env.XDG_CONFIG_HOME = join(dir, 'xdg');
    expect(configDir()).toBe(join(dir, 'xdg', 'inkwise'));
    expect(configPath()).toBe(join(dir, 'xdg', 'inkwise', 'config.toml'));
  });

  it('INKWISE_CONFIG overrides the config path', () => {
    process.env.INKWISE_CONFIG = join(dir, 'custom.toml');
    expect(configPath()).toBe(join(dir, 'custom.toml'));
  });

  it('expandHome handles ~, ~/x and relative paths', () => {
    expect(expandHome('~')).toBe(homedir());
    expect(expandHome('~/a/b')).toBe(join(homedir(), 'a', 'b'));
    expect(expandHome('rel/dir')).toBe(resolve('rel/dir'));
    expect(expandHome('/abs')).toBe('/abs');
  });

  it('assertTarget accepts the four targets', () => {
    for (const t of ['supernote-cloud', 'dropbox', 'gdrive', 'folder']) expect(assertTarget(t)).toBe(t);
    expect(() => assertTarget('usb')).toThrow(/Unknown target/);
  });
});

describe('session file', () => {
  it('writeSession creates a 0600 file in a new folder and readSession reads it back', async () => {
    const stateDir = join(dir, 'state');
    const p = await writeSession(stateDir, 'fake.session.token');
    expect(p).toBe(sessionPath(stateDir));
    expect((await stat(p)).mode & 0o777).toBe(0o600);
    const j = JSON.parse(await readFile(p, 'utf8'));
    expect(j.token).toBe('fake.session.token');
    expect(Number.isNaN(Date.parse(j.savedAt))).toBe(false);
    expect(await readSession(stateDir)).toBe('fake.session.token');
  });

  it('writeSession tightens an existing file to 0600', async () => {
    const stateDir = join(dir, 'state');
    await writeSession(stateDir, 'one');
    const { chmod } = await import('node:fs/promises');
    await chmod(sessionPath(stateDir), 0o644);
    await writeSession(stateDir, 'two');
    expect((await stat(sessionPath(stateDir))).mode & 0o777).toBe(0o600);
    expect(await readSession(stateDir)).toBe('two');
  });

  it('readSession prefers SUPERNOTE_CLOUD_TOKEN', async () => {
    const stateDir = join(dir, 'state');
    await writeSession(stateDir, 'from-file');
    process.env.SUPERNOTE_CLOUD_TOKEN = 'from-env';
    expect(await readSession(stateDir)).toBe('from-env');
  });

  it('readSession returns undefined for a missing or broken file', async () => {
    expect(await readSession(join(dir, 'none'))).toBeUndefined();
    const stateDir = join(dir, 'broken');
    await writeSession(stateDir, 'x');
    await writeFile(sessionPath(stateDir), '{not json');
    expect(await readSession(stateDir)).toBeUndefined();
    await writeFile(sessionPath(stateDir), '{"token": 42}');
    expect(await readSession(stateDir)).toBeUndefined();
  });
});
