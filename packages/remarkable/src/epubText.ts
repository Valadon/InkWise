import { htmlToText } from '@inkwise/core';
import { strFromU8, unzipSync } from 'fflate';

function readPackage(bytes: Uint8Array): { files: Record<string, Uint8Array>; opfPath: string; opf: string } | null {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    return null;
  }
  const container = files['META-INF/container.xml'];
  const opfPath = (container && /full-path="([^"]+)"/.exec(strFromU8(container))?.[1]) || Object.keys(files).find((n) => n.endsWith('.opf'));
  const opf = opfPath ? files[opfPath] : undefined;
  return opfPath && opf ? { files, opfPath, opf: strFromU8(opf) } : null;
}

const decode = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');

/** `dc:title` from the EPUB, for the name shown in the reMarkable library. */
export function epubTitle(bytes: Uint8Array): string | null {
  const pkg = readPackage(bytes);
  const m = pkg && /<dc:title[^>]*>([\s\S]*?)<\/dc:title>/.exec(pkg.opf);
  return m ? decode(m[1]!).trim() || null : null;
}

/** The book's text in reading (spine) order, one chapter after another. */
export function epubText(bytes: Uint8Array): string {
  const pkg = readPackage(bytes);
  if (!pkg) return '';
  const base = pkg.opfPath.includes('/') ? pkg.opfPath.slice(0, pkg.opfPath.lastIndexOf('/') + 1) : '';
  const hrefs = new Map<string, string>();
  for (const item of pkg.opf.matchAll(/<item\b[^>]*>/g)) {
    const id = /\bid="([^"]+)"/.exec(item[0])?.[1];
    const href = /\bhref="([^"]+)"/.exec(item[0])?.[1];
    if (id && href) hrefs.set(id, decodeURIComponent(decode(href)));
  }
  const parts: string[] = [];
  for (const ref of pkg.opf.matchAll(/<itemref\b[^>]*\bidref="([^"]+)"/g)) {
    const href = hrefs.get(ref[1]!);
    const file = href && pkg.files[base + href];
    if (file) parts.push(htmlToText(strFromU8(file)));
  }
  return parts.join('\n');
}
