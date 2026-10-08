import { strFromU8 } from 'fflate';

/**
 * Reads text highlights out of a reMarkable v6 `.rm` page file (software 3.x,
 * including the Paper Pro and Paper Pro Move).
 *
 * The format is a stream of tagged blocks. We only need the "glyph" scene
 * items: each one is a highlight and carries the highlighted text itself, so
 * no layout or PDF lookup is needed to know what was selected. Every other
 * block is skipped by its length. Ported from the relevant slice of rmscene
 * (https://github.com/ricklupton/rmscene, MIT).
 */

export interface RmHighlight {
  /** CRDT item id, stable for the life of the highlight ("1:14"). */
  id: string;
  text: string;
  /** Pen colour index (3 yellow, 4 green, 5 pink, 9 = see rgba). */
  color: number;
  /** Exact colour on firmware that stores one (3.14+), as #rrggbb. */
  rgba: string | null;
  /** Bounding rectangles in page coordinates, in reading order. */
  rects: { x: number; y: number; w: number; h: number }[];
}

const HEADER = 'reMarkable .lines file, version=6          ';
const GLYPH_BLOCK = 0x03;
const GLYPH_ITEM = 0x01;

const TAG_ID = 0xf;
const TAG_LEN4 = 0xc;
const TAG_BYTE4 = 0x4;

export class RmFormatError extends Error {}

class Reader {
  pos = 0;
  private view: DataView;
  constructor(private buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  need(n: number) {
    if (this.pos + n > this.buf.length) throw new RmFormatError(`unexpected end of file at ${this.pos}`);
  }
  bytes(n: number): Uint8Array {
    this.need(n);
    const b = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }
  u8(): number {
    this.need(1);
    return this.buf[this.pos++]!;
  }
  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  f64(): number {
    this.need(8);
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }
  varuint(): number {
    let result = 0;
    let mul = 1;
    for (;;) {
      const b = this.u8();
      result += (b & 0x7f) * mul;
      mul *= 128;
      if (!(b & 0x80)) return result;
    }
  }
  /** Peek the next tag without moving. */
  peekTag(): { index: number; type: number } | null {
    const save = this.pos;
    try {
      const x = this.varuint();
      return { index: Math.floor(x / 16), type: x & 0xf };
    } catch {
      return null;
    } finally {
      this.pos = save;
    }
  }
  isTag(index: number, type: number, end: number): boolean {
    if (this.pos >= end) return false;
    const t = this.peekTag();
    return !!t && t.index === index && t.type === type;
  }
  tag(index: number, type: number) {
    const at = this.pos;
    const x = this.varuint();
    if (Math.floor(x / 16) !== index || (x & 0xf) !== type) {
      throw new RmFormatError(`expected tag ${index}/${type.toString(16)} at ${at}, got ${Math.floor(x / 16)}/${(x & 0xf).toString(16)}`);
    }
  }
  id(index: number): string {
    this.tag(index, TAG_ID);
    const a = this.u8();
    const b = this.varuint();
    return `${a}:${b}`;
  }
  int(index: number): number {
    this.tag(index, TAG_BYTE4);
    return this.u32();
  }
  /** Read a length-prefixed subblock header; returns its end offset. */
  subblock(index: number): number {
    this.tag(index, TAG_LEN4);
    const len = this.u32();
    return this.pos + len;
  }
}

function readGlyph(r: Reader, end: number, id: string): RmHighlight {
  // start/length were dropped in software 3.6; we only need the text.
  if (r.isTag(2, TAG_BYTE4, end)) r.int(2);
  if (r.isTag(3, TAG_BYTE4, end)) r.int(3);
  const color = r.int(4);

  const strEnd = r.subblock(5);
  const n = r.varuint();
  r.u8(); // "is ascii" flag, always 1 in practice
  const text = strFromU8(r.bytes(n));
  r.pos = strEnd;

  const rectEnd = r.subblock(6);
  const count = r.varuint();
  const rects = [];
  for (let i = 0; i < count; i++) rects.push({ x: r.f64(), y: r.f64(), w: r.f64(), h: r.f64() });
  r.pos = rectEnd;

  let rgba: string | null = null;
  if (r.isTag(10, TAG_BYTE4, end)) {
    // Stored as little-endian BGRA.
    const packed = r.int(10);
    const hex = (v: number) => v.toString(16).padStart(2, '0');
    rgba = `#${hex((packed >>> 16) & 0xff)}${hex((packed >>> 8) & 0xff)}${hex(packed & 0xff)}`;
  }
  return { id, text, color, rgba, rects };
}

/**
 * All live highlights on one page, in the order they appear in the file.
 * Deleted highlights are left out. Throws RmFormatError for files that are
 * not v6 or are cut short; a single unreadable block is skipped.
 */
export function readRmHighlights(data: Uint8Array): RmHighlight[] {
  const r = new Reader(data);
  if (strFromU8(r.bytes(HEADER.length)) !== HEADER) throw new RmFormatError('not a v6 .rm file');

  const byId = new Map<string, RmHighlight | null>();
  while (r.pos < data.length) {
    const len = r.u32();
    r.u8(); // unknown, always 0
    r.u8(); // min version
    r.u8(); // current version
    const type = r.u8();
    const start = r.pos;
    const end = start + len;
    if (end > data.length) throw new RmFormatError(`block at ${start} runs past end of file`);

    if (type === GLYPH_BLOCK) {
      try {
        r.id(1); // parent
        const id = r.id(2);
        r.id(3); // left
        r.id(4); // right
        const deleted = r.int(5);
        let value: RmHighlight | null = null;
        if (r.isTag(6, TAG_LEN4, end)) {
          const valEnd = r.subblock(6);
          if (r.u8() === GLYPH_ITEM) value = readGlyph(r, valEnd, id);
        }
        // A later block for the same item wins (that's how deletes land).
        byId.set(id, deleted > 0 ? null : value);
      } catch (e) {
        if (!(e instanceof RmFormatError)) throw e;
      }
    }
    r.pos = end;
  }
  return [...byId.values()].filter((h): h is RmHighlight => h !== null);
}
