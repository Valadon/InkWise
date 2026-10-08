import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'smol-toml';

export type Target = 'supernote-cloud' | 'dropbox' | 'gdrive' | 'folder';
export const TARGETS: Target[] = ['supernote-cloud', 'dropbox', 'gdrive', 'folder'];

export interface Config {
  target: Target;
  location: string;
  category: string | null;
  tags: string[];
  limit?: number;
  images: boolean;
  removeMissing: boolean;
  removeMode: 'delete' | 'archive-folder';
  stateDir: string;
  folder: { path?: string };
  dropbox: { mode: 'api' | 'folder'; root: string; path?: string };
  gdrive: { mode: 'api' | 'folder'; folderId?: string; path?: string };
  supernoteCloud: { folder: string };
}

export function configDir(): string {
  return process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, 'inkwise') : join(homedir(), '.config', 'inkwise');
}

export function configPath(): string {
  return process.env.INKWISE_CONFIG ?? join(configDir(), 'config.toml');
}

export const DEFAULT_CONFIG: Config = {
  target: 'supernote-cloud',
  location: 'later',
  category: 'article',
  tags: [],
  images: true,
  removeMissing: false,
  removeMode: 'archive-folder',
  stateDir: join(homedir(), '.inkwise'),
  folder: {},
  dropbox: { mode: 'folder', root: '/Supernote/Document' },
  gdrive: { mode: 'folder' },
  supernoteCloud: { folder: 'Document/Inkwise' },
};

/** Load config.toml (missing file = defaults). Secrets are never read from here. */
export async function loadConfig(path = configPath()): Promise<Config> {
  let raw: any = {};
  try {
    raw = parse(await readFile(path, 'utf8'));
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw new Error(`Could not read ${path}: ${err.message}`);
  }
  const secrets = ['token', 'readwise_token', 'password', 'access_token'];
  const sections = Object.entries(raw).filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v));
  for (const [prefix, table] of [['', raw], ...sections.map(([k, v]) => [`${k}.`, v])] as [string, any][]) {
    for (const secret of secrets) {
      if (secret in table) throw new Error(`${path} contains "${prefix}${secret}". Secrets belong in environment variables, not the config file.`);
    }
  }
  const c: Config = structuredClone(DEFAULT_CONFIG);
  if (raw.target) c.target = assertTarget(raw.target);
  if (raw.location) c.location = String(raw.location);
  if (raw.category !== undefined) c.category = raw.category === 'all' ? null : String(raw.category);
  if (Array.isArray(raw.tags)) c.tags = raw.tags.map(String);
  if (raw.limit) c.limit = Number(raw.limit);
  if (raw.images !== undefined) c.images = !!raw.images;
  if (raw.remove_missing !== undefined) c.removeMissing = !!raw.remove_missing;
  if (raw.remove_mode === 'delete' || raw.remove_mode === 'archive-folder') c.removeMode = raw.remove_mode;
  if (raw.state_dir) c.stateDir = expandHome(String(raw.state_dir));
  if (raw.folder?.path) c.folder.path = expandHome(String(raw.folder.path));
  if (raw.dropbox) {
    if (raw.dropbox.mode === 'api' || raw.dropbox.mode === 'folder') c.dropbox.mode = raw.dropbox.mode;
    if (raw.dropbox.root) c.dropbox.root = String(raw.dropbox.root);
    if (raw.dropbox.path) c.dropbox.path = expandHome(String(raw.dropbox.path));
  }
  if (raw.gdrive) {
    if (raw.gdrive.mode === 'api' || raw.gdrive.mode === 'folder') c.gdrive.mode = raw.gdrive.mode;
    if (raw.gdrive.folder_id) c.gdrive.folderId = String(raw.gdrive.folder_id);
    if (raw.gdrive.path) c.gdrive.path = expandHome(String(raw.gdrive.path));
  }
  if (raw.supernote_cloud?.folder) c.supernoteCloud.folder = String(raw.supernote_cloud.folder);
  return c;
}

export function assertTarget(t: string): Target {
  if (!TARGETS.includes(t as Target)) throw new Error(`Unknown target "${t}". Use one of: ${TARGETS.join(', ')}.`);
  return t as Target;
}

export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return resolve(p);
}

export const SAMPLE_CONFIG = `# Inkwise CLI config. Secrets never go here: use environment variables.
#   READWISE_TOKEN          Readwise access token (https://readwise.io/access_token)
#   SUPERNOTE_CLOUD_TOKEN   optional; otherwise run \`inkwise supernote-login\`
#   DROPBOX_TOKEN           for dropbox.mode = "api"
#   GDRIVE_ACCESS_TOKEN     for gdrive.mode = "api"

target = "supernote-cloud"   # supernote-cloud | dropbox | gdrive | folder
location = "later"           # later | shortlist | new | archive
category = "article"         # or "all"
tags = []                    # only documents with all of these tags (max 5)
images = true
remove_missing = false       # tidy up articles that left the queue
remove_mode = "archive-folder"  # or "delete"
# limit = 20

[folder]
# path = "~/Supernote/Document/Inkwise"

[supernote_cloud]
folder = "Document/Inkwise"

[dropbox]
mode = "folder"              # "folder" = your Dropbox desktop folder, "api" = Dropbox API
# path = "~/Dropbox/Supernote/Document/Inkwise"
root = "/Supernote/Document" # api mode: the Dropbox path your Supernote syncs as Document

[gdrive]
mode = "folder"
# path = "~/Google Drive/My Drive/Supernote/Document/Inkwise"
# folder_id = "..."          # api mode: Drive folder the Supernote syncs as Document
`;

/** Small secrets file for the Supernote Cloud session token (mode 0600). */
export function sessionPath(stateDir: string) {
  return join(stateDir, 'supernote-session.json');
}

export async function readSession(stateDir: string): Promise<string | undefined> {
  if (process.env.SUPERNOTE_CLOUD_TOKEN) return process.env.SUPERNOTE_CLOUD_TOKEN;
  try {
    const j = JSON.parse(await readFile(sessionPath(stateDir), 'utf8'));
    return typeof j.token === 'string' ? j.token : undefined;
  } catch {
    return undefined;
  }
}

export async function writeSession(stateDir: string, token: string): Promise<string> {
  const p = sessionPath(stateDir);
  await mkdir(dirname(p), { recursive: true, mode: 0o700 });
  await writeFile(p, JSON.stringify({ token, savedAt: new Date().toISOString() }), { mode: 0o600 });
  await chmod(p, 0o600);
  return p;
}
