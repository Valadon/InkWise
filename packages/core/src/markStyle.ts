/** How Inkwise shows a highlight inside an EPUB (see marks.ts). No imports, so any module can use it. */

/** Wraps the highlighted words. */
export const HIGHLIGHT_CLASS = 'rw-hl';
/** Added to each paragraph (or list item, heading, cell) that holds part of a highlight. */
export const HIGHLIGHT_BLOCK_CLASS = 'rw-hl-block';
/** The blocks that can carry HIGHLIGHT_BLOCK_CLASS: never a wrapper like div or section, which could be the whole article. */
export const MARKABLE_BLOCKS = ['p', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'dt', 'dd', 'figcaption', 'caption', 'td', 'th'];

/**
 * What the Manta's reader can draw (style tests, 2026-10-08 and 10-09): bold,
 * italic, grey text, and a background or left bar on a whole paragraph. It
 * draws no CSS underline and no background behind words, and it lays out
 * inline-block as a block, so a "box behind the words" lands on its own line.
 * It does draw a combining low line (U+0332) from the font, which gives a real
 * underline that wraps with the text. So:
 *   underline: each highlighted character gets a U+0332 (marks.ts adds them)
 *   bold:      bold italic words
 *   paragraph: the whole paragraph shaded grey
 */
export type HighlightStyle = 'underline' | 'bold' | 'paragraph';
export const HIGHLIGHT_STYLES: readonly HighlightStyle[] = ['underline', 'bold', 'paragraph'];
export const DEFAULT_HIGHLIGHT_STYLE: HighlightStyle = 'underline';

/** The combining low line Inkwise puts before each highlighted character. */
export const UNDERLINE_MARK = '\u0332';

export function highlightCss(style: HighlightStyle = DEFAULT_HIGHLIGHT_STYLE): string {
  if (style === 'bold') return `span.${HIGHLIGHT_CLASS} { font-weight: bold; font-style: italic; }\n`;
  // One rule per element: the reader skips a bare `.class` rule and only draws `p.class` ones.
  if (style === 'paragraph') return MARKABLE_BLOCKS.map((tag) => `${tag}.${HIGHLIGHT_BLOCK_CLASS} { background-color: #d2d2d2; }\n`).join('');
  return '';
}

/** Bump whenever the markup or CSS changes, so sync re-marks files written the old way. */
export const MARK_STYLE = 5;
