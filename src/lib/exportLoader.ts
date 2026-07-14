import { importWithChunkRetry } from './lazyWithChunkRetry';

export function loadExportModule() {
  return importWithChunkRetry(() => import('./export'), 'export-module');
}
