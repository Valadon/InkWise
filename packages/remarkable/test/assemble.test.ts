import { describe, expect, it } from 'vitest';
import { assembleHighlights, type PagePiece } from '../src/assemble.js';
import type { RmHighlight } from '../src/rmHighlights.js';

// Pride and Prejudice (public domain). The pieces below copy what a Paper Pro
// actually writes: one piece per line or stroke, line breaks dropped, and
// ligatures turned into junk ("ff" -> "2") or left out ("fi").
const SOURCE = `<h1>Chapter 1</h1>

It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife.

However little known the feelings or views of such a man may be on his first entering a neighbourhood, this truth is so well fixed in the minds of the surrounding families, that he is considered the rightful property of some one or other of their daughters.

“My dear Mr. Bennet,” said his lady to him one day, “have you heard that Netherfield Park is let at last?”

Mr. Bennet replied that he had not. “But it is,” returned she; “for Mrs. Long has just been here, and she told me all about it.” Mr. Bennet made no answer, and his wife was quite at last in a huff about the different offers.`;

let next = 10;
function piece(pageIndex: number, text: string, color = 3): PagePiece {
  const highlight: RmHighlight = { id: `1:${next++}`, text, color, rgba: null, rects: [] };
  return { pageIndex, highlight };
}

describe('assembleHighlights', () => {
  it('joins a highlight dragged over two lines into one', () => {
    const out = assembleHighlights(
      [piece(0, 'It is a truth universally acknowledged, that a single man in'), piece(0, 'possession of a good fortune,')],
      SOURCE,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe('It is a truth universally acknowledged, that a single man in possession of a good fortune,');
    expect(out[0]!.pieces).toHaveLength(2);
  });

  it('recovers text with lost line breaks and broken ligatures', () => {
    const out = assembleHighlights(
      [piece(0, 'on hisrst entering a neighbourhood, this truth is so wellxed in the minds of the surrounding families')],
      SOURCE,
    );
    expect(out[0]!.located).toBe(true);
    expect(out[0]!.text).toBe('on his first entering a neighbourhood, this truth is so well fixed in the minds of the surrounding families');

    const huff = assembleHighlights([piece(0, 'in a hu2 about the di2erent o2ers.')], SOURCE);
    expect(huff[0]!.text).toBe('in a huff about the different offers.');

    // A ligature at the very start of the highlight.
    const fixed = assembleHighlights([piece(0, 'xed in the minds of the surrounding')], SOURCE);
    expect(fixed[0]!.text).toBe('fixed in the minds of the surrounding');
  });

  it('joins a highlight that runs across a page turn', () => {
    const out = assembleHighlights(
      [piece(1, 'Netherfield Park is let at last?”', 4), piece(2, 'Mr. Bennet replied', 4), piece(2, 'that he had not.', 4)],
      SOURCE,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.color).toBe(4);
    expect(out[0]!.text).toBe('Netherfield Park is let at last?”\n\nMr. Bennet replied that he had not.');
  });

  it('keeps touching highlights of different colours apart', () => {
    const out = assembleHighlights([piece(0, 'It is a truth', 3), piece(0, 'universally acknowledged,', 5)], SOURCE);
    expect(out.map((h) => [h.text, h.color])).toEqual([
      ['It is a truth', 3],
      ['universally acknowledged,', 5],
    ]);
  });

  it('picks the copy of a repeated phrase nearest the page’s other highlights', () => {
    const out = assembleHighlights([piece(3, 'at last', 5), piece(3, 'his wife was quite', 5)], SOURCE);
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe('his wife was quite at last');
  });

  it('returns pieces it cannot place, unlocated, after the rest', () => {
    const out = assembleHighlights([piece(0, 'a truth universally'), piece(0, 'Something that is not in the book at all')], SOURCE);
    expect(out.map((h) => h.located)).toEqual([true, false]);
    expect(out[1]!.text).toBe('Something that is not in the book at all');
  });
});
