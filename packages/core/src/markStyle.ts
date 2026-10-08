/** How Inkwise shows a highlight inside an EPUB (see marks.ts). No imports, so any module can use it. */

/** Wraps the highlighted words. */
export const HIGHLIGHT_CLASS = 'rw-hl';
/** Added to each paragraph (or list item, heading, cell) that holds part of a highlight. */
export const HIGHLIGHT_BLOCK_CLASS = 'rw-hl-block';

/**
 * The Manta's reader draws bold words and a grey background on a whole
 * paragraph, but no underline and no background behind words (tested on
 * device 2026-10-08). So a highlight bolds its words, shades its paragraph,
 * or both. Shading never moves text; bold makes the words a little wider.
 */
export type HighlightStyle = 'both' | 'bold' | 'paragraph';
export const DEFAULT_HIGHLIGHT_STYLE: HighlightStyle = 'both';

export function highlightCss(style: HighlightStyle = DEFAULT_HIGHLIGHT_STYLE): string {
  let css = '';
  if (style !== 'paragraph') css += `span.${HIGHLIGHT_CLASS} { font-weight: bold; }\n`;
  if (style !== 'bold') css += `.${HIGHLIGHT_BLOCK_CLASS} { background-color: #d2d2d2; }\n`;
  return css;
}

/** Bump whenever the markup or CSS changes, so sync re-marks files written the old way. */
export const MARK_STYLE = 3;
