import { spawnSync } from 'node:child_process';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { ReadwiseClient, describeSyncError, summarize, syncReader, textManifestStore, type FetchLike } from '@inkwise/core';
import { FakeReadwise } from '@inkwise/core/testing';
import { sendDeviceHighlights } from './highlightSync.js';
import { highlightColorName } from './rmHighlights.js';
import { SAMPLE_DOCUMENT } from './sample.js';
import { XOCHITL_DIR, XochitlOutput } from './xochitl.js';

const VERSION = process.env.INKWISE_VERSION ?? 'dev';

const HELP = `inkwise-rm ${VERSION}: Readwise Reader on a reMarkable

Usage:
  inkwise-rm connect [token]   Save your Readwise token (from readwise.io/access_token)
  inkwise-rm sync [options]    Put Reader articles on the tablet, send highlights back
  inkwise-rm highlights        Show the highlights InkWise sees, without sending them
  inkwise-rm status            What's on the tablet and what's waiting to send

Sync options:
  --limit <n>       At most n articles (try 1 the first time)
  --location <loc>  Reader location: later (default), shortlist, new
  --mock            Use a built-in test article and a pretend Readwise (no token needed)
  --dry-run         Show what would happen; change nothing
  --no-restart      Don't restart the reading app afterwards (new articles show up after the next restart)

Files: settings in ${'$'}INKWISE_DIR (default /home/root/.local/share/inkwise),
library in ${'$'}XOCHITL_DIR (default ${XOCHITL_DIR}).`;

class UserError extends Error {}

const home = () => process.env.INKWISE_DIR ?? '/home/root/.local/share/inkwise';
const library = () => process.env.XOCHITL_DIR ?? XOCHITL_DIR;

/** Mock runs keep their own state so the test article never mixes with real ones. */
function paths(mock: boolean) {
  const base = mock ? join(home(), 'mock') : home();
  return { token: join(home(), 'token'), manifest: join(base, 'manifest.json'), library: join(base, 'library.json') };
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

async function writeText(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, text);
  await rename(`${path}.tmp`, path);
}

const realFetch: FetchLike = (url, init) => fetch(url, init as RequestInit) as any;

async function setup(mock: boolean) {
  const p = paths(mock);
  let client: ReadwiseClient;
  let imageFetch: FetchLike | undefined = realFetch;
  if (mock) {
    const fake = new FakeReadwise({ documents: [SAMPLE_DOCUMENT] });
    client = new ReadwiseClient({ token: fake.token, fetch: fake.fetch, sleep: async () => {} });
    imageFetch = undefined;
  } else {
    const token = (process.env.READWISE_TOKEN ?? (await readText(p.token)) ?? '').trim();
    if (!token) throw new UserError('No Readwise token yet. Run: inkwise-rm connect');
    client = new ReadwiseClient({ token, fetch: realFetch, onRateLimit: (s) => console.log(`Readwise asked us to wait ${s}s…`) });
  }
  const manifest = textManifestStore({ read: () => readText(p.manifest), write: (t) => writeText(p.manifest, t) });
  const output = new XochitlOutput({ dir: library(), stateFile: p.library });
  return { client, manifest, output, imageFetch };
}

async function connect(tokenArg?: string) {
  let token = tokenArg?.trim();
  if (!token) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    token = (await rl.question('Paste your Readwise token (readwise.io/access_token): ')).trim();
    rl.close();
  }
  if (!token) throw new UserError('No token given.');
  const ok = await new ReadwiseClient({ token, fetch: realFetch }).validateToken();
  if (!ok) throw new UserError('Readwise rejected that token. Copy it again from readwise.io/access_token.');
  const p = paths(false).token;
  await writeText(p, token);
  await chmod(p, 0o600);
  console.log('Connected to Readwise.');
}

function restartReader() {
  console.log('Restarting the reading app so new articles show up…');
  const r = spawnSync('systemctl', ['restart', 'xochitl'], { stdio: 'inherit' });
  if (r.status !== 0) console.log('Could not restart it automatically. Restart the tablet to see new articles.');
}

async function sync(v: { limit?: string; location?: string; mock?: boolean; 'dry-run'?: boolean; 'no-restart'?: boolean }) {
  const mock = !!v.mock;
  const dryRun = !!v['dry-run'];
  const { client, manifest, output, imageFetch } = await setup(mock);

  if (!dryRun) {
    const sent = await sendDeviceHighlights({
      client,
      manifest,
      output,
      onHighlight: (_file, h, status) => {
        if (status !== 'duplicate') console.log(`  [${status}] (${highlightColorName(h)}) ${h.text.replace(/\s+/g, ' ')}`);
      },
    });
    const c = sent.counts;
    console.log(`Highlights: ${c.sent ?? 0} sent, ${c.duplicate ?? 0} already in Readwise, ${(c.queued_offline ?? 0) + (c.needs_attention ?? 0)} waiting.`);
  }

  const limit = v.limit ? Number(v.limit) : undefined;
  if (limit !== undefined && !(limit > 0)) throw new UserError('--limit needs a number above 0.');
  const result = await syncReader(
    { client, output, manifest, fetchImages: imageFetch, onProgress: (m) => console.log(`  ${m}`) },
    { location: v.location ?? 'later', limit, dryRun, showHighlights: false, includeImages: !!imageFetch },
  );
  for (const w of result.warnings) console.log(`  warning: ${w}`);
  // Reader bumps an article whenever it gets a highlight, so core asks to rebuild it;
  // books with highlights on the tablet are left as they are (see XochitlOutput.put).
  const kept = result.items.filter((i) => i.action === 'updated' && output.kept.has(i.filename)).length;
  let line = summarize({ ...result, updated: result.updated - kept }, dryRun);
  if (kept) line += ` Left ${kept} marked-up ${kept === 1 ? 'article' : 'articles'} as ${kept === 1 ? 'it is' : 'they are'}.`;
  console.log(line);

  if (output.changed && !dryRun) {
    if (v['no-restart']) console.log('New articles will show up after the reading app restarts.');
    else restartReader();
  }
}

async function showHighlights(mock: boolean) {
  const { output } = await setup(mock);
  const docs = await output.documents();
  if (!docs.length) console.log('No InkWise articles on the tablet yet.');
  for (const { filename, uuid } of docs) {
    const hs = await output.highlights(uuid);
    console.log(`${filename}: ${hs.length} highlight(s)`);
    for (const h of hs) {
      console.log(`  (${highlightColorName(h)}${h.located ? '' : ', not found in the text'}; ${h.pieces.length} piece(s)) ${h.text.replace(/\s+/g, ' ')}`);
    }
  }
}

async function status(mock: boolean) {
  const { manifest, output } = await setup(mock);
  const docs = await output.documents();
  const m = await manifest.load();
  console.log(`${docs.length} InkWise article(s) on the tablet.`);
  const waiting = m.pendingHighlights.filter((p) => p.state === 'pending').length;
  const stuck = m.pendingHighlights.filter((p) => p.state === 'needs_attention');
  console.log(`${waiting} highlight(s) waiting to send, ${stuck.length} Readwise couldn't match.`);
  for (const p of stuck) console.log(`  ${p.text.slice(0, 100)}`);
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { values: v, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      limit: { type: 'string' },
      location: { type: 'string' },
      mock: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      'no-restart': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean' },
    },
  });
  const [cmd, arg] = positionals;
  try {
    if (v.version) console.log(VERSION);
    else if (cmd === 'connect') await connect(arg);
    else if (cmd === 'sync') await sync(v);
    else if (cmd === 'highlights') await showHighlights(!!v.mock);
    else if (cmd === 'status') await status(!!v.mock);
    else console.log(HELP);
    return 0;
  } catch (err) {
    console.error(err instanceof UserError ? err.message : describeSyncError(err));
    return 1;
  }
}
