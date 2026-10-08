import { supabase } from '../lib/supabase';

// Browser client for Syntage. Calls go through /api/syntage, which holds the org's API key
// server-side; the browser never sees it. Sandbox unless the server is explicitly set to production.

export interface SyntageCollection<T = any> {
  'hydra:member': T[];
  'hydra:totalItems'?: number;
  'hydra:view'?: { 'hydra:next'?: string };
  [key: string]: unknown;
}

export interface SyntageEntity {
  '@id': string;
  id: string;
  type?: string;
  taxpayer?: { id?: string; name?: string; personType?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export class SyntageError extends Error {
  constructor(message: string, public status: number, public requestId: string | null, public rateLimitReset: string | null) {
    super(message);
  }
}

export async function syntageGet<T = any>(
  path: string,
  query?: Record<string, string | number | boolean | Array<string | number>>,
  options: { cursor?: boolean } = {},
): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error('No autenticado. Por favor inicia sesión nuevamente.');

  const response = await fetch('/api/syntage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({ path, query, cursor: options.cursor }),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = json.error || json.data?.['hydra:description'] || json.data?.detail || `Syntage respondió ${response.status}`;
    throw new SyntageError(detail, response.status, json.requestId ?? null, json.rateLimitReset ?? null);
  }
  return json.data as T;
}

export function nextPagePath(collection: SyntageCollection): string | null {
  return collection['hydra:view']?.['hydra:next'] || null;
}

// Syntage's taxpayer.id filter is a partial match, so confirm the exact RFC before trusting a hit.
export async function findEntityByRfc(rfc: string): Promise<SyntageEntity | null> {
  const normalized = rfc.trim().toUpperCase();
  const page = await syntageGet<SyntageCollection<SyntageEntity>>('/entities', { 'taxpayer.id': normalized });
  return page['hydra:member'].find(entity => entity.taxpayer?.id?.toUpperCase() === normalized) || null;
}

export function listEntities(query?: Record<string, string | number | boolean>) {
  return syntageGet<SyntageCollection<SyntageEntity>>('/entities', query);
}

export function getEntity(entityId: string) {
  return syntageGet<SyntageEntity>(`/entities/${encodeURIComponent(entityId)}`);
}

// Invoices support cursor pagination; pass the previous page's hydra:next as `path` to continue.
export function listEntityInvoices(entityId: string, query?: Record<string, string | number | boolean>) {
  return syntageGet<SyntageCollection>(`/entities/${encodeURIComponent(entityId)}/invoices`, query, { cursor: true });
}
