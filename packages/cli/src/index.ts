#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  ReadwiseClient,
  archiveDocument,
  describeSyncError,
  epubIdentifier,
  sendHighlight,
  syncReader,
  type FetchLike,
  type OutputAdapter,
  type ReaderDocument,
} from '@inkwise/core';
import { FakeReadwise, TINY_GIF, TINY_PNG } from '@inkwise/core/testing';
import { DropboxOutput } from './adapters/dropbox.js';
import { FolderOutput } from './adapters/folder.js';
import { GoogleDriveOutput } from './adapters/gdrive.js';
import { SupernoteCloudClient, SupernoteCloudOutput, jwtExpiresIn } from './adapters/supernote-cloud.js';
import {
  SAMPLE_CONFIG,
  assertTarget,
  configPath,
  expandHome,
  loadConfig,
  readSession,
  writeSession,
  type Config,
} from './config.js';
import { processImage } from './images.js';
import { fileManifestStore, manifestPath } from './state.js';

const HELP = `inkwise: Readwise Reader queue to EPUBs for Supernote

Usage:
  inkwise sync [options]              Fetch the Reader queue and deliver EPUBs
  inkwise auth                        Check READWISE_TOKEN
  inkwise status                      Show what's synced and what's queued
  inkwise highlight <file|id> <text>  Send a highlight (handy for testing text matching)
  inkwise archive <file|id>           Archive a document in Reader
  inkwise supernote-login             Sign in to Supernote Cloud (stores a session token only)
  inkwise init                        Write a sample config file

Sync options:
  --target <t>        supernote-cloud | dropbox | gdrive | folder   (default from config)
  --out <dir>         Folder for --target folder (or dropbox/gdrive desktop folders)
  --location <loc>    later | shortlist | new | archive             (default later)
  --tag <tag>         Only documents with this tag (repeatable, max 5)
  --category <c>      article (default) or "all"
  --limit <n>         At most n documents
  --images / --no-images
  --remove-missing    Tidy up EPUBs whose documents left the queue
  --force             Rebuild every EPUB
  --dry-run           Show what would happen; write nothing
  --mock              Use built-in sample articles and a fake Readwise (no token needed)

Highlight options:
  --note <text>       Attach a note

Environment:
  READWISE_TOKEN, SUPERNOTE_CLOUD_TOKEN, DROPBOX_TOKEN, GDRIVE_ACCESS_TOKEN, INKWISE_CONFIG
Config: ${configPath()}
`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      target: { type: 'string' },
      out: { type: 'string' },
      location: { type: 'string' },
      tag: { type: 'string', multiple: true },
      category: { type: 'string' },
      limit: { type: 'string' },
      images: { type: 'boolean' },
      'no-images': { type: 'boolean' },
      'remove-missing': { type: 'boolean' },
      force: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      mock: { type: 'boolean' },
      note: { type: 'string' },
      email: { type: 'string' },
      token: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  const [command, ...rest] = positionals;
  if (values.version) {
    console.log(readVersion());
    return 0;
  }
  if (values.help || !command) {
    console.log(HELP);
    return command || values.help ? 0 : 1;
  }

  const config = await loadConfig();
  if (values.target) config.target = assertTarget(values.target);

  switch (command) {
    case 'init':
      return init();
    case 'auth':
      return auth(values.mock);
    case 'sync':
      return sync(config, values);
    case 'status':
      return status(config);
    case 'highlight':
      return highlight(config, rest, values);
    case 'archive':
      return archive(config, rest, values);
    case 'supernote-login':
      return supernoteLogin(config, values);
    default:
      console.error(`Unknown command "${command}".\n`);
      console.log(HELP);
      return 1;
  }
}

// ---------------------------------------------------------------------------

function readwiseFor(mock?: boolean, onRateLimit = true): { client: ReadwiseClient; fetch: FetchLike; fake?: FakeReadwise } {
  if (mock) {
    const fake = mockReadwise();
    return { client: new ReadwiseClient({ token: fake.token, fetch: fake.fetch, sleep: async () => {} }), fetch: fake.fetch, fake };
  }
  const token = process.env.READWISE_TOKEN?.trim();
  if (!token) {
    throw new UserError('READWISE_TOKEN is not set. Get yours at https://readwise.io/access_token and export it.');
  }
  const f: FetchLike = (url, init) => fetch(url, init as RequestInit) as any;
  const client = new ReadwiseClient({
    token,
    fetch: f,
    onRateLimit: onRateLimit ? (s) => console.log(`Readwise rate limit hit; waiting ${s}s…`) : undefined,
  });
  return { client, fetch: f };
}

async function init() {
  const p = configPath();
  if (existsSync(p)) {
    console.log(`Config already exists at ${p}.`);
    return 0;
  }
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, SAMPLE_CONFIG);
  console.log(`Wrote ${p}. Edit it, then run \`inkwise sync --dry-run\`.`);
  return 0;
}

async function auth(mock?: boolean) {
  const { client } = readwiseFor(mock);
  const ok = await client.validateToken();
  console.log(ok ? 'Readwise token works.' : 'Readwise token rejected. Check READWISE_TOKEN.');
  return ok ? 0 : 1;
}

async function buildOutput(config: Config, out?: string, dryRunMock = false): Promise<OutputAdapter> {
  switch (config.target) {
    case 'folder': {
      const dir = out ? expandHome(out) : config.folder.path;
      if (!dir) throw new UserError('Pick a folder: --out <dir> or [folder] path in the config.');
      return new FolderOutput(dir);
    }
    case 'dropbox': {
      if (config.dropbox.mode === 'folder' || out) {
        const dir = out ? expandHome(out) : config.dropbox.path;
        if (!dir) throw new UserError('Set [dropbox] path (your local Dropbox folder) or use mode = "api".');
        return new FolderOutput(dir, 'dropbox');
      }
      const token = process.env.DROPBOX_TOKEN;
      if (!token) throw new UserError('DROPBOX_TOKEN is not set (needed for dropbox mode = "api").');
      return new DropboxOutput(token, config.dropbox.root);
    }
    case 'gdrive': {
      if (config.gdrive.mode === 'folder' || out) {
        const dir = out ? expandHome(out) : config.gdrive.path;
        if (!dir) throw new UserError('Set [gdrive] path (your Google Drive for desktop folder) or use mode = "api".');
        return new FolderOutput(dir, 'gdrive');
      }
      const token = process.env.GDRIVE_ACCESS_TOKEN;
      if (!token) throw new UserError('GDRIVE_ACCESS_TOKEN is not set (needed for gdrive mode = "api").');
      if (!config.gdrive.folderId) throw new UserError('Set [gdrive] folder_id to the Drive folder your Supernote syncs as Document.');
      return new GoogleDriveOutput(token, config.gdrive.folderId);
    }
    case 'supernote-cloud': {
      if (out) return new FolderOutput(expandHome(out), 'folder');
      const token = await readSession(config.stateDir);
      if (!token && dryRunMock) throw new UserError('--mock with supernote-cloud needs --out <dir> (mock runs never touch your cloud).');
      if (!token) throw new UserError('Not signed in to Supernote Cloud. Run `inkwise supernote-login` (or use --target folder).');
      const left = jwtExpiresIn(token);
      if (left !== null && left <= 0) throw new UserError('Supernote Cloud session expired. Run `inkwise supernote-login` again.');
      return new SupernoteCloudOutput(new SupernoteCloudClient(token), config.supernoteCloud.folder.split('/').filter(Boolean));
    }
  }
}

async function sync(config: Config, v: Record<string, any>) {
  const { client, fetch: f } = readwiseFor(v.mock);
  if (v.mock && config.target !== 'folder' && !v.out) {
    throw new UserError('--mock writes sample EPUBs to a local folder. Add --out <dir>.');
  }
  const output = await buildOutput(config, v.out, v.mock);
  const manifest = fileManifestStore(manifestPath(config.stateDir, v.mock ? 'mock' : output.name));
  const includeImages = v['no-images'] ? false : v.images ?? config.images;
  const limit = v.limit ? Number(v.limit) : config.limit;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new UserError('--limit must be a positive whole number.');
  const category = v.category ? (v.category === 'all' ? null : v.category) : config.category;
  const imageFetch: FetchLike = v.mock
    ? f
    : (url, init) => fetch(url, { ...(init as RequestInit), headers: { 'User-Agent': 'Mozilla/5.0 (Inkwise EPUB builder)', ...(init?.headers ?? {}) } }) as any;

  console.log(`Target: ${output.name}${output instanceof FolderOutput ? ` (${output.dir})` : ''}${v['dry-run'] ? ' [dry run]' : ''}`);
  const result = await syncReader(
    {
      client,
      output,
      manifest,
      fetchImages: includeImages ? imageFetch : undefined,
      processImage,
      onProgress: (m) => console.log(m),
    },
    {
      location: v.location ?? config.location,
      category,
      tags: v.tag ?? config.tags,
      limit,
      includeImages,
      removeMissing: v['remove-missing'] ?? config.removeMissing,
      removeMode: config.removeMode,
      dryRun: v['dry-run'],
      force: v.force,
    },
  );
  for (const item of result.items) {
    if (item.action === 'skipped') continue;
    console.log(`  ${item.action.padEnd(8)} ${item.filename}${item.error ? `  (${item.error})` : ''}`);
  }
  for (const w of result.warnings) console.log(`  note: ${w}`);
  console.log(result.summary);
  return result.failed ? 2 : 0;
}

async function status(config: Config) {
  const targets = ['supernote-cloud', 'dropbox', 'gdrive', 'folder', 'mock'];
  let any = false;
  for (const t of targets) {
    const p = manifestPath(config.stateDir, t);
    if (!existsSync(p)) continue;
    any = true;
    const m = await fileManifestStore(p).load();
    const docs = Object.values(m.documents);
    const pending = m.pendingHighlights.filter((h) => h.state === 'pending').length;
    const attention = m.pendingHighlights.filter((h) => h.state === 'needs_attention');
    console.log(`${t}: ${docs.filter((d) => d.status === 'synced').length} synced, ${docs.filter((d) => d.status === 'archived').length} archived, last sync ${m.lastSyncAt ?? 'never'}`);
    if (pending) console.log(`  ${pending} highlight(s) waiting to send`);
    for (const a of attention) console.log(`  needs attention: "${a.text.slice(0, 70)}${a.text.length > 70 ? '…' : ''}" (${a.lastError})`);
    if (m.pendingArchives?.length) console.log(`  ${m.pendingArchives.length} archive request(s) waiting`);
  }
  if (!any) console.log('Nothing synced yet. Run `inkwise sync`.');
  return 0;
}

/** Accept a path to an Inkwise EPUB or a bare Reader id. */
function asFilePath(arg: string): string {
  if (/\.epub$/i.test(arg)) return expandHome(arg);
  if (/^[A-Za-z0-9]+$/.test(arg)) return `__${arg}.epub`;
  throw new UserError(`"${arg}" is neither an .epub file nor a Reader document id.`);
}

async function readIdentifier(path: string) {
  try {
    return epubIdentifier(new Uint8Array(await readFile(path)));
  } catch {
    return null;
  }
}

async function highlight(config: Config, args: string[], v: Record<string, any>) {
  const [target, ...words] = args;
  if (!target || !words.length) throw new UserError('Usage: inkwise highlight <file.epub|id> "<text>" [--note "..."]');
  const { client } = readwiseFor(v.mock);
  const manifest = fileManifestStore(manifestPath(config.stateDir, v.mock ? 'mock' : config.target));
  const r = await sendHighlight({ client, manifest, filePath: asFilePath(target), text: words.join(' '), note: v.note, readIdentifier });
  console.log(r.message);
  if (r.sentText) console.log(`Matched Reader's text as: ${r.sentText}`);
  return r.status === 'sent' || r.status === 'duplicate' || r.status === 'queued_offline' ? 0 : 1;
}

async function archive(config: Config, args: string[], v: Record<string, any>) {
  const [target] = args;
  if (!target) throw new UserError('Usage: inkwise archive <file.epub|id>');
  const { client } = readwiseFor(v.mock);
  const manifest = fileManifestStore(manifestPath(config.stateDir, v.mock ? 'mock' : config.target));
  const r = await archiveDocument({ client, manifest, filePath: asFilePath(target), readIdentifier });
  console.log(r.message);
  return r.status === 'archived' || r.status === 'queued_offline' ? 0 : 1;
}

async function supernoteLogin(config: Config, v: Record<string, any>) {
  if (v.token) {
    const p = await writeSession(config.stateDir, String(v.token).trim());
    console.log(`Saved the Supernote Cloud session token to ${p}.`);
    return 0;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const ask = (q: string) => new Promise<string>((res) => rl.question(q, res));
  const email = v.email ?? (await ask('Supernote account email: '));
  const password = await askHidden(rl, 'Password (not stored): ');
  const client = new SupernoteCloudClient(undefined);
  const start = await client.startLogin(email.trim(), password);
  let token: string;
  if (start.kind === 'token') token = start.token;
  else {
    const code = await ask('Supernote emailed you a verification code. Enter it: ');
    token = await client.finishLogin(email.trim(), code, start);
  }
  rl.close();
  const p = await writeSession(config.stateDir, token);
  const left = jwtExpiresIn(token);
  console.log(`Signed in. Session token saved to ${p}${left ? ` (valid for about ${Math.round(left / 86400)} days)` : ''}.`);
  return 0;
}

function askHidden(rl: ReturnType<typeof createInterface>, q: string): Promise<string> {
  return new Promise((res) => {
    const anyRl = rl as any;
    const orig = anyRl._writeToOutput;
    anyRl._writeToOutput = (s: string) => {
      if (s.includes(q)) orig.call(rl, s);
      else if (s === '\r\n' || s === '\n') orig.call(rl, s);
    };
    rl.question(q, (answer) => {
      anyRl._writeToOutput = orig;
      process.stdout.write('\n');
      res(answer);
    });
  });
}

// ---------------------------------------------------------------------------

class UserError extends Error {}

function here() {
  return dirname(fileURLToPath(import.meta.url));
}

function readVersion(): string {
  try {
    return JSON.parse(readFileSync(join(here(), '..', 'package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

/** Fake Readwise loaded with the repo's sample articles, for `--mock`. */
function mockReadwise(): FakeReadwise {
  const dir = join(here(), '..', '..', '..', 'fixtures', 'documents');
  const documents: ReaderDocument[] = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
    : [];
  return new FakeReadwise({
    token: 'mock',
    documents,
    images: {
      'https://example.com/img/fog-1.png': TINY_PNG,
      'https://example.com/photo/field-notes/img/fog-2.gif': TINY_GIF,
    },
  });
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    if (err instanceof UserError) console.error(err.message);
    else console.error(describeSyncError(err));
    if (process.env.INKWISE_DEBUG) console.error(err);
    process.exit(1);
  },
);
