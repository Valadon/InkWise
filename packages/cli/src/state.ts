import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { textManifestStore, type ManifestStore } from '@inkwise/core';

/** One manifest per target, so the CLI can feed several sync services independently. */
export function manifestPath(stateDir: string, target: string) {
  return join(stateDir, `manifest.${target}.json`);
}

export function fileManifestStore(path: string): ManifestStore {
  return textManifestStore({
    async read() {
      try {
        return await readFile(path, 'utf8');
      } catch (err: any) {
        if (err?.code === 'ENOENT') return null;
        throw err;
      }
    },
    async write(text) {
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      await writeFile(tmp, text);
      await rename(tmp, path);
    },
  });
}
