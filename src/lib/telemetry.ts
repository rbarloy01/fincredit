// Lightweight client-side telemetry: a ring buffer in localStorage that captures crashes,
// failed queries and slow operations so we can diagnose "se traba / me manda a la vrga"
// with real data instead of guessing. No backend/table required — viewable in Settings →
// Diagnóstico, and exportable to share.

export type DiagKind = 'error' | 'query' | 'slow' | 'chunk';
export interface DiagEntry {
  t: string;        // ISO timestamp
  kind: DiagKind;
  msg: string;
  detail?: string;  // stack / extra
  ctx?: string;     // route / operation label
  build?: string;
}

const KEY = 'finmonitor_diag_log';
const MAX = 50;
const BUILD = String((globalThis as any).__APP_BUILD_ID__ ?? '');

function read(): DiagEntry[] {
  try { const v = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
function write(list: DiagEntry[]) {
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(-MAX))); } catch { /* quota */ }
}

export function logDiag(kind: DiagKind, msg: unknown, detail?: unknown, ctx?: string) {
  try {
    const list = read();
    list.push({
      t: new Date().toISOString(), kind,
      msg: String(msg ?? '').slice(0, 300),
      detail: detail != null ? String(detail).slice(0, 1800) : undefined,
      ctx, build: BUILD || undefined,
    });
    write(list);
  } catch { /* never throw from logging */ }
}

export function getDiag(): DiagEntry[] { return read().slice().reverse(); } // newest first
export function clearDiag() { write([]); }

let installed = false;
export function installTelemetry() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', (e: ErrorEvent) => {
    logDiag('error', e.message || 'window.error', (e.error && (e.error as any).stack) || `${e.filename}:${e.lineno}:${e.colno}`, location?.hash || undefined);
  });
  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    const r: any = e.reason;
    logDiag('error', (r && (r.message || String(r))) || 'unhandledrejection', r && r.stack, location?.hash || undefined);
  });
}

// Wrap an async operation; logs a 'slow' entry if it exceeds the threshold. Never alters
// the result or swallows errors (errors still propagate and are caught elsewhere).
export async function timed<T>(label: string, fn: () => Promise<T>, thresholdMs = 1500): Promise<T> {
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const start = now();
  try {
    return await fn();
  } finally {
    const ms = now() - start;
    if (ms > thresholdMs) logDiag('slow', `${label}: ${Math.round(ms)}ms`, undefined, label);
  }
}
