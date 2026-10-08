import type { EpubImage } from './epub.js';
import type { FetchLike } from './types.js';

export type ImageMediaType = EpubImage['mediaType'];

/**
 * Optional image transform (grayscale, downscale, re-encode). The CLI plugs in a
 * pure-JS implementation; the device plugin can skip it. Return null to drop the image.
 */
export type ImageProcessor = (
  data: Uint8Array,
  mediaType: ImageMediaType,
) => Promise<{ data: Uint8Array; mediaType: ImageMediaType } | null>;

export interface CollectImagesOptions {
  fetch: FetchLike;
  process?: ImageProcessor;
  /** Total bytes of images allowed in one EPUB. */
  budgetBytes?: number;
  /** Skip any single image bigger than this (before processing). */
  maxImageBytes?: number;
  maxImages?: number;
  onWarning?: (message: string) => void;
}

/** Media types e-ink EPUB renderers handle reliably. WebP and SVG are dropped unless a processor converts them. */
const SAFE_TYPES = new Set<ImageMediaType>(['image/jpeg', 'image/png', 'image/gif']);

export function sniffImageType(bytes: Uint8Array): ImageMediaType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  )
    return 'image/webp';
  const head = String.fromCharCode(...bytes.slice(0, 256)).trimStart();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';
  return null;
}

const EXT: Record<ImageMediaType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
};

/**
 * Download images for one article. Failures never throw: the image is dropped and
 * the article falls back to its alt text.
 */
export async function collectImages(urls: string[], opts: CollectImagesOptions): Promise<Map<string, EpubImage>> {
  const out = new Map<string, EpubImage>();
  const budget = opts.budgetBytes ?? 8 * 1024 * 1024;
  const maxImage = opts.maxImageBytes ?? 6 * 1024 * 1024;
  const maxImages = opts.maxImages ?? 60;
  let used = 0;
  let n = 0;
  for (const url of urls) {
    if (n >= maxImages) {
      opts.onWarning?.(`Image limit reached; skipped remaining images.`);
      break;
    }
    try {
      const res = await opts.fetch(url, { method: 'GET', headers: { Accept: 'image/*' } });
      if (!res.ok) {
        opts.onWarning?.(`Image ${url} returned HTTP ${res.status}; using alt text.`);
        continue;
      }
      let data: Uint8Array = new Uint8Array(await res.arrayBuffer());
      if (data.length > maxImage) {
        opts.onWarning?.(`Image ${url} is too large (${data.length} bytes); using alt text.`);
        continue;
      }
      let type = sniffImageType(data);
      if (!type) {
        opts.onWarning?.(`Image ${url} is not a recognised format; using alt text.`);
        continue;
      }
      if (opts.process) {
        const processed = await opts.process(data, type);
        if (!processed) continue;
        data = processed.data;
        type = processed.mediaType;
      }
      if (!SAFE_TYPES.has(type)) {
        opts.onWarning?.(`Image ${url} is ${type}, which e-ink readers handle poorly; using alt text.`);
        continue;
      }
      if (used + data.length > budget) {
        opts.onWarning?.(`Image budget reached; skipped ${url}.`);
        continue;
      }
      n++;
      used += data.length;
      out.set(url, { path: `images/img-${n}.${EXT[type]}`, mediaType: type, data });
    } catch (err) {
      opts.onWarning?.(`Image ${url} failed to download (${err instanceof Error ? err.message : String(err)}); using alt text.`);
    }
  }
  return out;
}
