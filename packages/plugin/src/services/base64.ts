/** Base64 without relying on btoa/atob or Buffer, which Hermes doesn't guarantee. */
const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LOOKUP = (() => {
  const t = new Int16Array(256).fill(-1);
  for (let i = 0; i < CHARS.length; i++) t[CHARS.charCodeAt(i)] = i;
  t['-'.charCodeAt(0)] = 62;
  t['_'.charCodeAt(0)] = 63;
  return t;
})();

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  const chunk: string[] = [];
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    chunk.push(CHARS[(n >> 18) & 63]! + CHARS[(n >> 12) & 63]! + CHARS[(n >> 6) & 63]! + CHARS[n & 63]!);
    if (chunk.length >= 4096) {
      out += chunk.join('');
      chunk.length = 0;
    }
  }
  out += chunk.join('');
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += `${CHARS[(n >> 18) & 63]}${CHARS[(n >> 12) & 63]}==`;
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += `${CHARS[(n >> 18) & 63]}${CHARS[(n >> 12) & 63]}${CHARS[(n >> 6) & 63]}=`;
  }
  return out;
}

export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[\s=]+/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < clean.length; i++) {
    const v = LOOKUP[clean.charCodeAt(i)]!;
    if (v < 0) continue;
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buffer >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}
