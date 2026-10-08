import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { curl, highlightHash, highlightVariants, normalizeSelection, sha1, straighten } from '../src/index.js';

describe('normalizeSelection', () => {
  it('trims and collapses whitespace, including newlines from multi-paragraph selections', () => {
    expect(normalizeSelection('  one\n\n  two\tthree  ')).toBe('one two three');
  });
  it('turns NBSP and friends into spaces', () => {
    expect(normalizeSelection('a b c d')).toBe('a b c d');
  });
  it('strips soft hyphens and zero-width characters', () => {
    expect(normalizeSelection('hy­phen​ated﻿')).toBe('hyphenated');
  });
  it('expands ligatures', () => {
    expect(normalizeSelection('ﬁne ﬂow ﬃce')).toBe('fine flow ffice');
  });
  it('leaves curly quotes and dashes alone', () => {
    expect(normalizeSelection('“Hi” — it’s')).toBe('“Hi” — it’s');
  });
});

describe('quote and dash variants', () => {
  it('straightens', () => {
    expect(straighten('“Hi,” she said — it’s… fine')).toBe('"Hi," she said - it\'s... fine');
  });
  it('curls', () => {
    expect(curl('"Hi," she said -- it\'s fine')).toBe('“Hi,” she said — it’s fine');
  });
  it('variants start with the normalized selection and are unique', () => {
    const v = highlightVariants(' “Read slowly,” my teacher said ');
    expect(v[0]).toBe('“Read slowly,” my teacher said');
    expect(v).toContain('"Read slowly," my teacher said');
    expect(new Set(v).size).toBe(v.length);
  });
});

describe('sha1', () => {
  it('matches node crypto for ASCII, unicode and long input', () => {
    for (const s of ['', 'abc', '“curly” — é 漢字 😀', 'x'.repeat(1000)]) {
      expect(sha1(s)).toBe(createHash('sha1').update(s, 'utf8').digest('hex'));
    }
  });
  it('highlightHash ignores whitespace and quote style', () => {
    expect(highlightHash('doc', ' “a”  b ')).toBe(highlightHash('doc', '"a" b'));
    expect(highlightHash('doc', 'a')).not.toBe(highlightHash('other', 'a'));
  });
});
