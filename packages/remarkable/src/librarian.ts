import { randomUUID } from 'node:crypto';
import { closeSync, constants, openSync, readSync, writeSync } from 'node:fs';

/**
 * Talks to the running reading app through the librarian xovi extension
 * (https://github.com/rmitchellscott/rm-librarian, `librarian` in reManager),
 * so new documents, moves and deletions show up without restarting it.
 *
 * Librarian listens on xovi-message-broker's pipes: a request is one line,
 * `>e<signal>:<params>`, written to /run/xovi-mb, and the reply is everything
 * the broker then writes to /run/xovi-mb-out before closing it. Failures come
 * back as `ERROR: <message>` or `FAILED`.
 */

/** Sends one request line (without the newline) and resolves with the reply. */
export type Transport = (request: string) => Promise<string>;

/** What XochitlOutput needs from the reading app. */
export interface LibraryControl {
  /** Create a folder the app knows about straight away; returns its UUID. */
  createFolder(name: string, parent: string): Promise<string>;
  move(id: string, parent: string): Promise<void>;
  trash(id: string): Promise<void>;
  /** Load documents written to disk since the app started. */
  rescan(): Promise<void>;
}

export class LibrarianError extends Error {}
/** The broker isn't there, or nothing answered: librarian isn't installed or the app isn't running. */
export class LibrarianUnavailable extends LibrarianError {}

export const BROKER_IN = '/run/xovi-mb';
export const BROKER_OUT = '/run/xovi-mb-out';
/** The broker reads requests into a buffer of this size. */
const MAX_REQUEST = 1024;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errCode = (e: unknown) => (e as NodeJS.ErrnoException)?.code;

export interface FifoOptions {
  inPath?: string;
  outPath?: string;
  timeoutMs?: number;
}

/**
 * The broker's pipes, opened non-blocking so a missing extension or a stopped
 * app turns into an error instead of a hang. The reply pipe is opened before
 * the request is sent; the broker waits for a reader before it replies.
 */
export function fifoTransport(opts: FifoOptions = {}): Transport {
  const inPath = opts.inPath ?? BROKER_IN;
  const outPath = opts.outPath ?? BROKER_OUT;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  return async (request) => {
    const line = Buffer.from(`${request}\n`);
    if (line.length > MAX_REQUEST) throw new LibrarianError('request too long for xovi-message-broker');

    let w = -1;
    // The broker reopens its end between requests; give it a moment before deciding it's gone.
    for (let attempt = 0; w === -1; attempt++) {
      try {
        w = openSync(inPath, constants.O_WRONLY | constants.O_NONBLOCK);
      } catch (e) {
        if (errCode(e) === 'ENXIO' && attempt < 10) await sleep(100);
        else throw new LibrarianUnavailable(errCode(e) === 'ENOENT' ? 'xovi-message-broker is not installed' : 'the reading app is not running');
      }
    }
    let r: number;
    try {
      r = openSync(outPath, constants.O_RDONLY | constants.O_NONBLOCK);
    } catch {
      closeSync(w);
      throw new LibrarianUnavailable('xovi-message-broker has no reply pipe');
    }
    try {
      writeSync(w, line);
      closeSync(w);
      w = -1;
      const chunks: Buffer[] = [];
      const buf = Buffer.alloc(4096);
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        let n = -1;
        try {
          n = readSync(r, buf, 0, buf.length, null);
        } catch (e) {
          if (errCode(e) !== 'EAGAIN') throw e;
        }
        if (n > 0) {
          chunks.push(Buffer.from(buf.subarray(0, n)));
          continue;
        }
        // 0 means no writer: either the broker hasn't opened its end yet, or it
        // replied and closed. Librarian never replies with nothing, so data tells them apart.
        if (n === 0 && chunks.length) return Buffer.concat(chunks).toString('utf8');
        if (Date.now() > deadline) throw new LibrarianUnavailable('no answer from librarian');
        await sleep(20);
      }
    } finally {
      if (w !== -1) closeSync(w);
      closeSync(r);
    }
  };
}

export class Librarian implements LibraryControl {
  constructor(private readonly send: Transport) {}

  /**
   * Librarian, if it's installed and answering; otherwise null. The probe is a
   * lookup of a made-up UUID, which librarian echoes without touching anything.
   * A reply meant for an earlier, abandoned request can still be waiting in the
   * pipe, so a mismatched answer is retried.
   */
  static async connect(send: Transport = fifoTransport({ timeoutMs: 3000 })): Promise<Librarian | null> {
    const asked = new Set<string>();
    try {
      for (let i = 0; i < 3; i++) {
        const probe = randomUUID();
        asked.add(probe);
        if (asked.has((await send(`>elookupEntry:${probe}`)).trim())) return new Librarian(send);
      }
    } catch (e) {
      if (e instanceof LibrarianError) return null;
      throw e;
    }
    return null;
  }

  async call(signal: string, params = ''): Promise<string> {
    const reply = (await this.send(`>e${signal}:${params}`)).trim();
    if (!reply || reply === 'FAILED' || reply.startsWith('ERROR:')) {
      throw new LibrarianError(`librarian ${signal}: ${reply || 'no reply'}`);
    }
    return reply;
  }

  async createFolder(name: string, parent: string): Promise<string> {
    // Two-part requests split on the last comma, so a comma in the name is fine.
    const id = await this.call('createFolder', `${name},${parent}`);
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new LibrarianError(`librarian createFolder: unexpected reply ${id}`);
    return id;
  }

  async move(id: string, parent: string): Promise<void> {
    await this.call('moveEntry', `${id},${parent}`);
  }

  async trash(id: string): Promise<void> {
    await this.call('trashEntry', id);
  }

  async rescan(): Promise<void> {
    await this.call('rescanLibrary');
  }
}
