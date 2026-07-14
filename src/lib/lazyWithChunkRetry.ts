import { lazy, type ComponentType } from 'react';

declare const __APP_BUILD_ID__: string;

export const APP_BUILD_ID = typeof __APP_BUILD_ID__ === 'string' ? __APP_BUILD_ID__ : 'dev';

const CHUNK_RETRY_PREFIX = 'finmonitor_chunk_retry_';
const BUILD_KEY = 'finmonitor_build_id';

export function resetChunkRetryStateForCurrentBuild() {
  try {
    if (sessionStorage.getItem(BUILD_KEY) === APP_BUILD_ID) return;

    Object.keys(sessionStorage)
      .filter(key => key.startsWith(CHUNK_RETRY_PREFIX))
      .forEach(key => sessionStorage.removeItem(key));
    sessionStorage.setItem(BUILD_KEY, APP_BUILD_ID);
  } catch {}
}

function isMissingChunkError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /Failed to fetch dynamically imported module|Importing a module script failed|Loading chunk|ChunkLoadError/i.test(message);
}

export function lazyWithChunkRetry<T extends { default: ComponentType<any> }>(
  load: () => Promise<T>,
  chunkKey: string,
) {
  return lazy(async () => {
    return importWithChunkRetry(load, chunkKey);
  });
}

export async function importWithChunkRetry<T>(
  load: () => Promise<T>,
  chunkKey: string,
): Promise<T> {
  const retryKey = `${CHUNK_RETRY_PREFIX}${chunkKey}`;

  try {
    const module = await load();
    sessionStorage.removeItem(retryKey);
    return module;
  } catch (error) {
    if (isMissingChunkError(error) && sessionStorage.getItem(retryKey) !== '1') {
      sessionStorage.setItem(retryKey, '1');
      window.location.reload();
      return new Promise<T>(() => {});
    }

    throw error;
  }
}
