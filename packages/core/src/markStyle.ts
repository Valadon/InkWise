/** How Inkwise shows a highlight inside an EPUB (see marks.ts). No imports, so any module can use it. */

export const HIGHLIGHT_CLASS = 'rw-hl';

/**
 * Underlined as well as shaded: some EPUB renderers (MuPDF before 1.27, for
 * one) don't draw a background behind inline text. Neither changes the layout.
 */
export const HIGHLIGHT_CSS = `span.${HIGHLIGHT_CLASS} { background-color: #d2d2d2; text-decoration: underline; }\n`;

/** Bump whenever HIGHLIGHT_CSS changes, so sync re-shades files written the old way. */
export const MARK_STYLE = 2;
