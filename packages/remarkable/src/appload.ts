import { closeSync, read, writeSync } from 'node:fs';

/**
 * The connection between an AppLoad app's screen (QML, inside the reading app)
 * and its backend process (us). AppLoad starts `backend/entry` with the path of
 * a SOCK_SEQPACKET Unix socket; every message is two packets, an 8-byte header
 * (int32 type, int32 length, little-endian) and then the UTF-8 contents.
 * See https://github.com/asivery/rm-appload.
 */

export interface AppLoadMessage {
  type: number;
  contents: string;
}

/** Sent by AppLoad: the app is shutting down and the socket is about to close. */
export const MSG_TERMINATE = -1;
/** Sent by AppLoad: a screen opened; contents is how many are open. */
export const MSG_NEW_COORDINATOR = -2;
/** Sent by AppLoad: a screen closed; contents is how many are still open. */
export const MSG_LOST_COORDINATOR = -3;

export interface Channel {
  send(type: number, contents: string): void;
  /** The next message, or null once AppLoad has closed the connection. */
  next(): Promise<AppLoadMessage | null>;
  close(): void;
}

const MAX_MESSAGE = 10 * 1024 * 1024;
const AF_UNIX = 1;
const SOCK_SEQPACKET = 5;
const SOCKADDR_UN_SIZE = 110; // sa_family_t + char sun_path[108]

/**
 * Opens the socket. Node and Bun only speak stream sockets, so the socket
 * itself comes from libc through Bun's FFI; reading and writing then go
 * through ordinary file calls, where each read or write is one packet.
 */
export async function connectAppLoad(socketPath: string): Promise<Channel> {
  const ffiModule = 'bun:ffi';
  const { dlopen, FFIType, ptr } = await import(ffiModule);
  const libc = dlopen('libc.so.6', {
    socket: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    connect: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  });
  const fd: number = libc.symbols.socket(AF_UNIX, SOCK_SEQPACKET, 0);
  if (fd < 0) throw new Error('could not create the AppLoad socket');
  const path = new TextEncoder().encode(socketPath);
  if (path.length > 107) throw new Error('AppLoad socket path is too long');
  const addr = new Uint8Array(SOCKADDR_UN_SIZE);
  new DataView(addr.buffer).setUint16(0, AF_UNIX, true);
  addr.set(path, 2);
  if (libc.symbols.connect(fd, ptr(addr), SOCKADDR_UN_SIZE) !== 0) {
    closeSync(fd);
    throw new Error(`could not connect to AppLoad at ${socketPath}`);
  }
  return fdChannel(fd);
}

const readPacket = (fd: number, buf: Buffer) =>
  new Promise<number>((resolve, reject) => read(fd, buf, 0, buf.length, null, (err, n) => (err ? reject(err) : resolve(n))));

/** A channel over an already-connected SOCK_SEQPACKET socket. */
export function fdChannel(fd: number): Channel {
  let closed = false;
  return {
    send(type, contents) {
      if (closed) return;
      const body = Buffer.from(contents, 'utf8');
      const header = Buffer.alloc(8);
      header.writeInt32LE(type, 0);
      header.writeInt32LE(body.length, 4);
      writeSync(fd, header);
      // AppLoad reads a contents packet only when the length isn't zero.
      if (body.length) writeSync(fd, body);
    },
    async next() {
      if (closed) return null;
      const header = Buffer.alloc(8);
      if ((await readPacket(fd, header)) < 8) return null;
      const type = header.readInt32LE(0);
      const length = header.readInt32LE(4);
      if (length < 0 || length > MAX_MESSAGE) throw new Error(`AppLoad message too long (${length} bytes)`);
      // AppLoad always sends the contents packet, even an empty one. A one-byte
      // buffer still takes the empty packet off the socket.
      const body = Buffer.alloc(Math.max(1, length));
      const n = await readPacket(fd, body);
      return { type, contents: body.subarray(0, Math.min(n, length)).toString('utf8') };
    },
    close() {
      if (closed) return;
      closed = true;
      closeSync(fd);
    },
  };
}
