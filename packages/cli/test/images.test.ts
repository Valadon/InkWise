import { describe, expect, it } from 'vitest';
import { Jimp } from 'jimp';
import { TINY_GIF, TINY_PNG } from '@inkwise/core/testing';
import { processImage } from '../src/images.js';

async function colourImage(width: number, height: number) {
  const img = new Jimp({ width, height, color: 0xff0000ff });
  // A second colour block so greyscale has more than one input colour to flatten.
  for (let x = 0; x < width / 2; x++) for (let y = 0; y < Math.min(height, 50); y++) img.setPixelColor(0x2080e0ff, x, y);
  return img;
}

function isGrey(img: { width: number; height: number; bitmap: { data: Buffer | Uint8Array } }, tolerance = 0) {
  const d = img.bitmap.data;
  for (let i = 0; i < d.length; i += 4) {
    if (Math.abs(d[i]! - d[i + 1]!) > tolerance || Math.abs(d[i + 1]! - d[i + 2]!) > tolerance) return false;
  }
  return true;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

describe('processImage', () => {
  it('downscales a large colour PNG to 1400px on the long side, greyscale, still PNG', async () => {
    const src = await colourImage(2800, 1000);
    const input = new Uint8Array(await src.getBuffer('image/png'));
    const r = await processImage(input, 'image/png');
    expect(r).not.toBeNull();
    expect(r!.mediaType).toBe('image/png');
    expect([...r!.data.slice(0, 4)]).toEqual(PNG_MAGIC);
    const out = await Jimp.read(Buffer.from(r!.data));
    expect(out.width).toBe(1400);
    expect(out.height).toBe(500);
    expect(isGrey(out)).toBe(true);
  });

  it('downscales a tall image by height', async () => {
    const src = await colourImage(600, 3000);
    const r = await processImage(new Uint8Array(await src.getBuffer('image/png')), 'image/png');
    const out = await Jimp.read(Buffer.from(r!.data));
    expect(out.height).toBe(1400);
    expect(out.width).toBe(280);
  });

  it('does not upscale small images', async () => {
    const src = await colourImage(300, 200);
    const r = await processImage(new Uint8Array(await src.getBuffer('image/png')), 'image/png');
    const out = await Jimp.read(Buffer.from(r!.data));
    expect([out.width, out.height]).toEqual([300, 200]);
    expect(isGrey(out)).toBe(true);
  });

  it('re-encodes a JPEG photo as greyscale JPEG', async () => {
    const src = await colourImage(1800, 1800);
    const r = await processImage(new Uint8Array(await src.getBuffer('image/jpeg')), 'image/jpeg');
    expect(r!.mediaType).toBe('image/jpeg');
    expect([...r!.data.slice(0, 3)]).toEqual(JPEG_MAGIC);
    const out = await Jimp.read(Buffer.from(r!.data));
    expect([out.width, out.height]).toEqual([1400, 1400]);
    expect(isGrey(out, 6)).toBe(true); // JPEG chroma noise
  });

  it('turns a GIF into a JPEG', async () => {
    const r = await processImage(TINY_GIF, 'image/gif');
    expect(r).not.toBeNull();
    expect(r!.mediaType).toBe('image/jpeg');
    expect([...r!.data.slice(0, 3)]).toEqual(JPEG_MAGIC);
  });

  it('turns a Jimp-made GIF into a JPEG', async () => {
    const src = await colourImage(40, 30);
    const gif = new Uint8Array(await src.getBuffer('image/gif'));
    const r = await processImage(gif, 'image/gif');
    expect(r!.mediaType).toBe('image/jpeg');
    const out = await Jimp.read(Buffer.from(r!.data));
    expect([out.width, out.height]).toEqual([40, 30]);
  });

  it('flattens transparency onto white when converting to JPEG', async () => {
    const src = new Jimp({ width: 20, height: 20, color: 0x00000000 });
    const png = new Uint8Array(await src.getBuffer('image/png'));
    // Declared as WebP (anything but PNG goes to JPEG); the bytes are a transparent PNG.
    const r = await processImage(png, 'image/webp');
    expect(r!.mediaType).toBe('image/jpeg');
    const out = await Jimp.read(Buffer.from(r!.data));
    const d = out.bitmap.data;
    expect(Math.min(d[0]!, d[1]!, d[2]!)).toBeGreaterThan(245);
  });

  it('keeps the core TINY_PNG fixture as PNG', async () => {
    const r = await processImage(TINY_PNG, 'image/png');
    expect(r!.mediaType).toBe('image/png');
  });

  it('returns null for bytes it cannot decode', async () => {
    expect(await processImage(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), 'image/png')).toBeNull();
    expect(await processImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml')).toBeNull();
    expect(await processImage(new Uint8Array(0), 'image/jpeg')).toBeNull();
  });
});
