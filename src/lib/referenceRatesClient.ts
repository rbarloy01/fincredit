// Cliente de Banxico vía /api/banxico (el token vive en el servidor). Separado de referenceRates.ts para que las reglas
// de tasas sigan siendo funciones puras.
import { supabase } from './supabase';
import type { MonthlySeries, ReferenceSeries } from './referenceRates';

const cache = new Map<string, MonthlySeries>();

export async function fetchReferenceSeries(series: ReferenceSeries, from: string, to: string): Promise<MonthlySeries> {
  const key = `${series}|${from}|${to}`;
  if (cache.has(key)) return cache.get(key)!;
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error('No autenticado');
  const r = await fetch('/api/banxico', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({ series, from, to }),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(json.error || `Banxico respondió ${r.status}`);
  const out: MonthlySeries = {};
  (json.points || []).forEach((p: any) => { out[p.month] = p.endOfMonth; });
  cache.set(key, out);
  return out;
}
