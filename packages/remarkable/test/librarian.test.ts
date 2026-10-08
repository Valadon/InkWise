import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Librarian, LibrarianError, LibrarianUnavailable, fifoTransport, type Transport } from '../src/librarian.js';

describe('Librarian', () => {
  const echo: Transport = async (req) => req.slice(req.indexOf(':') + 1);

  it('connects when the probe comes back', async () => {
    expect(await Librarian.connect(echo)).toBeInstanceOf(Librarian);
  });

  it('skips a reply left over from an abandoned request', async () => {
    const replies = ['3'];
    const send: Transport = async (req) => replies.shift() ?? echo(req);
    expect(await Librarian.connect(send)).toBeInstanceOf(Librarian);
  });

  it('is null when nothing answers', async () => {
    const send: Transport = async () => {
      throw new LibrarianUnavailable('no answer');
    };
    expect(await Librarian.connect(send)).toBeNull();
    expect(await Librarian.connect(async () => 'something else')).toBeNull();
  });

  it('sends requests in the shape librarian expects and treats errors as failures', async () => {
    const sent: string[] = [];
    const lib = new Librarian(async (req) => {
      sent.push(req);
      if (req.startsWith('>etrashEntry')) return 'ERROR: not found: x';
      if (req.startsWith('>emoveEntry')) return 'FAILED';
      if (req.startsWith('>ecreateFolder')) return '9155cd95-147f-4bb5-93f1-a1519dac1021';
      return '0';
    });
    expect(await lib.createFolder('Archive, old', '')).toBe('9155cd95-147f-4bb5-93f1-a1519dac1021');
    await lib.rescan();
    await expect(lib.trash('x')).rejects.toThrow(LibrarianError);
    await expect(lib.move('a', 'b')).rejects.toThrow('FAILED');
    expect(sent).toEqual(['>ecreateFolder:Archive, old,', '>erescanLibrary:', '>etrashEntry:x', '>emoveEntry:a,b']);
  });
});

// A stand-in for xovi-message-broker with librarian: same pipes, a reader
// always open on the request pipe (the real broker never closes its old ones),
// a reply only once someone reads it, and no reply for a signal nobody handles.
const BROKER = `
exec 3<>"$1"
i=0
while [ $i -lt "$3" ]; do
  IFS= read -r line <&3
  case "$line" in
    '>elookupEntry:'*) printf '%s' "\${line#>elookupEntry:}" > "$2" ;;
    '>erescanLibrary:') printf '2' > "$2" ;;
    '>etrashEntry:'*) printf 'ERROR: not found: %s' "\${line#>etrashEntry:}" > "$2" ;;
  esac
  i=$((i+1))
done
`;

const hasMkfifo = process.platform !== 'win32' && spawnSync('sh', ['-c', 'command -v mkfifo']).status === 0;

describe.skipIf(!hasMkfifo)('fifoTransport', () => {
  let dir: string;
  let broker: ChildProcess | undefined;

  function startBroker(requests: number) {
    dir = mkdtempSync(join(tmpdir(), 'inkwise-mb-'));
    const inPath = join(dir, 'xovi-mb');
    const outPath = join(dir, 'xovi-mb-out');
    spawnSync('mkfifo', [inPath, outPath]);
    broker = spawn('sh', ['-c', BROKER, 'broker', inPath, outPath, String(requests)], { stdio: 'ignore' });
    return { inPath, outPath };
  }

  afterEach(() => {
    broker?.kill('SIGKILL');
    broker = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips requests through the pipes', async () => {
    const send = fifoTransport({ ...startBroker(3), timeoutMs: 5000 });
    const lib = await Librarian.connect(send);
    expect(lib).toBeInstanceOf(Librarian);
    await lib!.rescan();
    await expect(lib!.trash('nope')).rejects.toThrow('ERROR: not found: nope');
  });

  it('gives up on a signal nobody answers', async () => {
    const send = fifoTransport({ ...startBroker(1), timeoutMs: 300 });
    await expect(send('>esomethingElse:x')).rejects.toThrow(LibrarianUnavailable);
  });

  it('reports the broker missing without waiting', async () => {
    const send = fifoTransport({ inPath: join(tmpdir(), 'no-such-xovi-mb'), outPath: join(tmpdir(), 'no-such-xovi-mb-out') });
    await expect(send('>elookupEntry:x')).rejects.toThrow('not installed');
    expect(await Librarian.connect(send)).toBeNull();
  });
});
