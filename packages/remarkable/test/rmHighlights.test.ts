import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RmFormatError, readRmHighlights } from '../src/rmHighlights.js';

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

describe('readRmHighlights', () => {
  it('reads yellow highlights from a 3.1 page', () => {
    const hs = readRmHighlights(fixture('Wikipedia_highlighted_p1.rm'));
    expect(hs.map((h) => h.text)).toEqual([
      'The reMarkable uses electronic paper',
      'ReMarkable uses its own operating system, named Codex.',
      'Codex is based on Linux and optimized for electronic paper',
      'display technology.[13]',
    ]);
    expect(hs.every((h) => h.color === 3 && h.rgba === null)).toBe(true);
    expect(hs[0]!.id).toBe('1:14');
    expect(hs[3]!.rects).toHaveLength(2);
  });

  it('keeps non-ASCII text and per-highlight colours', () => {
    const hs = readRmHighlights(fixture('Wikipedia_highlighted_p2.rm'));
    expect(hs.map((h) => [h.text, h.color])).toEqual([
      ['177 mm \u00d7\u00a0256 mm\u00d7\u00a06.7 mm', 4],
      ['also', 5],
    ]);
  });

  it('reads exact colours from 3.14 firmware', () => {
    const hs = readRmHighlights(fixture('Color_and_tool_v3.14.4.rm'));
    expect(hs.map((h) => h.rgba)).toEqual(['#ffed75', '#beeafe', '#f29eff', '#ffc38c', '#acff85', '#c7c7c6']);
    expect(hs.every((h) => h.text === 'This is a test sentence.' && h.color === 9)).toBe(true);
  });

  it('returns nothing for a page with only handwriting or typed text', () => {
    expect(readRmHighlights(fixture('Normal_AB.rm'))).toEqual([]);
  });

  it('rejects files that are not v6', () => {
    expect(() => readRmHighlights(new TextEncoder().encode('reMarkable .lines file, version=5          '))).toThrow(RmFormatError);
  });
});

describe('highlightColorName', () => {
  it('names the Paper Pro highlighter colours', async () => {
    const { highlightColorName } = await import('../src/rmHighlights.js');
    expect([3, 4, 5].map((color) => highlightColorName({ color, rgba: null }))).toEqual(['yellow', 'green', 'pink']);
    expect(highlightColorName({ color: 9, rgba: '#ffed75' })).toBe('#ffed75');
  });
});
