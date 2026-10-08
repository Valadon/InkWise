import type { ImageProcessor } from '@inkwise/core';
import { Jimp } from 'jimp';

const MAX_SIDE = 1400;

/**
 * Grayscale, cap the longest side at 1400px and re-encode. Photos become JPEG;
 * PNGs stay PNG (they are usually diagrams and compress better that way).
 * Anything Jimp can't decode is dropped and falls back to alt text.
 */
export const processImage: ImageProcessor = async (data, mediaType) => {
  try {
    const img = await Jimp.read(Buffer.from(data));
    img.greyscale();
    if (img.width > MAX_SIDE || img.height > MAX_SIDE) img.scaleToFit({ w: MAX_SIDE, h: MAX_SIDE });
    if (mediaType === 'image/png') {
      return { data: new Uint8Array(await img.getBuffer('image/png')), mediaType: 'image/png' };
    }
    // JPEG has no alpha; flatten onto white so transparent GIF/WebP areas don't go black.
    const flat = new Jimp({ width: img.width, height: img.height, color: 0xffffffff });
    flat.composite(img, 0, 0);
    return { data: new Uint8Array(await flat.getBuffer('image/jpeg', { quality: 78 })), mediaType: 'image/jpeg' };
  } catch {
    return null;
  }
};
