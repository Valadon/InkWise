import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ReaderDocument } from '../src/index.js';

const FIXTURES = join(__dirname, '..', '..', '..', 'fixtures', 'documents');

export function loadFixtures(): ReaderDocument[] {
  return readdirSync(FIXTURES)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(FIXTURES, f), 'utf8')) as ReaderDocument);
}

export function fixture(name: string): ReaderDocument {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as ReaderDocument;
}

export const noSleep = async () => {};
