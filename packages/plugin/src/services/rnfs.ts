import RNFS from 'react-native-fs';
import type { FetchLike, FetchResponseLike } from '@inkwise/core';
import { base64ToBytes, bytesToBase64 } from './base64';
import { joinPath, type DeviceFs } from './fs';

/**
 * DeviceFs on top of react-native-fs. Shared folders (Document, MyStyle, ...)
 * only work after the matching FILE permission is granted; the private plugin
 * folder works without any.
 */
export const rnfs: DeviceFs = {
  exists: (path) => RNFS.exists(path),
  async mkdir(path) {
    await RNFS.mkdir(path);
  },
  async listFiles(dir) {
    const items = await RNFS.readDir(dir);
    return items.filter((i) => i.isFile()).map((i) => ({ name: i.name, size: Number(i.size) }));
  },
  readText: (path) => RNFS.readFile(path, 'utf8'),
  writeText: (path, text) => RNFS.writeFile(path, text, 'utf8'),
  async readBytes(path) {
    return base64ToBytes(await RNFS.readFile(path, 'base64'));
  },
  async writeBytes(path, bytes) {
    await RNFS.writeFile(path, bytesToBase64(bytes), 'base64');
  },
  async move(from, to) {
    // A rename replaces the target in one step on Android, so the old file is
    // never missing. Only if that fails do we clear the target and try again.
    try {
      await RNFS.moveFile(from, to);
    } catch (err) {
      if (!(await RNFS.exists(to))) throw err;
      await RNFS.unlink(to);
      await RNFS.moveFile(from, to);
    }
  },
  async unlink(path) {
    if (await RNFS.exists(path)) await RNFS.unlink(path);
  },
  async download(url, to) {
    const job = RNFS.downloadFile({ fromUrl: url, toFile: to, connectionTimeout: 15000, readTimeout: 30000 });
    const res = await job.promise;
    return res.statusCode;
  },
};

/**
 * A fetch for images that streams to disk instead of through JS, then reads the
 * bytes back. React Native's fetch can't reliably hand back an ArrayBuffer.
 */
export function makeImageFetch(fs: DeviceFs, tmpDir: () => Promise<string>): FetchLike {
  let n = 0;
  return async (url) => {
    const dir = await tmpDir();
    await fs.mkdir(dir);
    const file = joinPath(dir, `img-${Date.now()}-${n++}`);
    const status = fs.download ? await fs.download(url, file) : 0;
    const ok = status >= 200 && status < 300;
    let bytes: Uint8Array | null = null;
    const res: FetchResponseLike = {
      status,
      ok,
      headers: { get: () => null },
      json: async () => ({}),
      text: async () => '',
      async arrayBuffer() {
        if (!bytes) {
          bytes = ok ? await fs.readBytes(file) : new Uint8Array();
          await fs.unlink(file).catch(() => {});
        }
        return bytes.slice().buffer as ArrayBuffer;
      },
    };
    if (!ok) await fs.unlink(file).catch(() => {});
    return res;
  };
}
