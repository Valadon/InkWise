import type { FetchLike } from '@inkwise/core';
import { supernoteHost } from './host';
import { InkwiseApp } from './services/app';
import { joinPath } from './services/fs';
import { makeImageFetch, rnfs } from './services/rnfs';

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * fetch with a timeout. A stalled connection would otherwise leave "Sending…" on
 * screen forever. Timing out throws a TypeError, the same as a dropped
 * connection, so the highlight gets queued for later.
 */
const jsonFetch: FetchLike = (url, init) => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new TypeError('Network request timed out'));
    }, REQUEST_TIMEOUT_MS);
  });
  const request = fetch(url, { ...init, signal: controller.signal }).catch((err: unknown) => {
    throw err instanceof TypeError ? err : new TypeError(String(err));
  });
  return Promise.race([request, timeout]).finally(() => timer !== undefined && clearTimeout(timer)) as unknown as ReturnType<FetchLike>;
};

function createApp() {
  const app: InkwiseApp = new InkwiseApp(
    supernoteHost,
    rnfs,
    jsonFetch,
    makeImageFetch(rnfs, async () => joinPath(await app.privateDir(), 'tmp')),
  );
  return app;
}

/**
 * One app for the whole plugin. Button presses (index.js) and the React views
 * share it, so a quick send and the settings page see the same state.
 */
export const app = createApp();
