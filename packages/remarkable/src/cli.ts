import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { describeSyncError, textManifestStore } from '@inkwise/core';
import { Librarian } from './librarian.js';
import { highlightColorName } from './rmHighlights.js';
import { NoToken, SyncBusy, inkwisePaths, loadLastSync, loadSettings, readText, runSync, saveToken, writeText } from './runner.js';
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
  --no-restart      Never restart the reading app (only matters without librarian;
                    new articles then show up after the next restart)

With the librarian extension installed (reManager: librarian), new articles
show up straight away. Without it, InkWise restarts the reading app.

Files: settings in ${'$'}INKWISE_DIR (default /home/root/.local/share/inkwise),
library in ${'$'}XOCHITL_DIR (default ${XOCHITL_DIR}).`;

class UserError extends Error {}

const home = () => process.env.INKWISE_DIR ?? '/home/root/.local/share/inkwise';
const library = () => process.env.XOCHITL_DIR ?? XOCHITL_DIR;

const LIBRARIAN_TIP = 'Tip: install "librarian" in reManager and InkWise won\'t need to restart the reading app.';

async function connect(tokenArg?: string) {
  let token = tokenArg?.trim();
  if (!token) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    token = (await rl.question('Paste your Readwise token (readwise.io/access_token): ')).trim();
    rl.close();
  }
  if (!token) throw new UserError('No token given.');
  if (!(await saveToken(home(), token))) throw new UserError('Readwise rejected that token. Copy it again from readwise.io/access_token.');
  console.log('Connected to Readwise.');
}

function restartReader() {
  console.log('Restarting the reading app so it picks up the changes…');
  const r = spawnSync('systemctl', ['restart', 'xochitl'], { stdio: 'inherit' });
  if (r.status !== 0) console.log('Could not restart it automatically. Restart the tablet to see new articles.');
}

async function sync(v: { limit?: string; location?: string; mock?: boolean; 'dry-run'?: boolean; 'no-restart'?: boolean }) {
  const dryRun = !!v['dry-run'];
  const limit = v.limit ? Number(v.limit) : undefined;
  if (limit !== undefined && !(limit > 0)) throw new UserError('--limit needs a number above 0.');
  const res = await runSync({
    home: home(),
    library: library(),
    mock: !!v.mock,
    limit,
    location: v.location,
    dryRun,
    onLine: (line) => console.log(`  ${line}`),
  });
  if (res.ok) console.log(res.summary);
  if (!dryRun) {
    if (res.waitingForRestart) {
      if (v['no-restart']) console.log('New articles will show up after the reading app restarts.');
      else restartReader();
      if (!res.librarian) console.log(LIBRARIAN_TIP);
    } else if (res.changed) {
      console.log('The library is up to date, no restart needed.');
    }
  }
  if (!res.ok) throw res.error;
}

async function showHighlights(mock: boolean) {
  const output = new XochitlOutput({ dir: library(), stateFile: inkwisePaths(home(), mock).library });
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
  const p = inkwisePaths(home(), mock);
  const output = new XochitlOutput({ dir: library(), stateFile: p.library });
  const manifest = textManifestStore({ read: () => readText(p.manifest), write: (t) => writeText(p.manifest, t) });
  const docs = await output.documents();
  const m = await manifest.load();
  const settings = await loadSettings(home());
  const last = await loadLastSync(home(), mock);
  console.log(`InkWise ${VERSION}. ${docs.length} InkWise article(s) on the tablet.`);
  console.log(
    (await Librarian.connect())
      ? 'librarian found: new articles show up without restarting the reading app.'
      : 'librarian not found: new articles need a reading-app restart. Install "librarian" in reManager to skip that.',
  );
  if (last) console.log(`Last sync ${last.at.replace('T', ' ').slice(0, 16)} UTC: ${last.summary}`);
  console.log(`Automatic sync (in the InkWise app): ${settings.autoSyncMinutes ? `every ${settings.autoSyncMinutes} min` : 'off'}, from ${settings.location}.`);
  const waiting = m.pendingHighlights.filter((h) => h.state === 'pending').length;
  const stuck = m.pendingHighlights.filter((h) => h.state === 'needs_attention');
  console.log(`${waiting} highlight(s) waiting to send, ${stuck.length} Readwise couldn't match.`);
  for (const h of stuck) console.log(`  ${h.text.slice(0, 100)}`);
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
    else if (cmd === 'appload' && arg) {
      // Started by AppLoad as the tablet app's backend, with its socket path.
      const { runBackend } = await import('./backend.js');
      await runBackend({ socketPath: arg, home: home(), library: library(), version: VERSION });
    } else console.log(HELP);
    return 0;
  } catch (err) {
    console.error(err instanceof UserError || err instanceof NoToken || err instanceof SyncBusy ? err.message : describeSyncError(err));
    return 1;
  }
}
