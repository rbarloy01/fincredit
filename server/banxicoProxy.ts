import { readJson, requireActiveUser, sendJson } from './apiHelpers.js';

// Tasas de referencia de Banxico (SIE API). El token (BANXICO_TOKEN) vive solo en el servidor.
// Servido en /api/banxico vía rewrite a api/gemini.ts (el plan Hobby limita a 12 funciones).
//   POST { series: 'tiie28' | 'tiie_fondeo' | 'tiie91', from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }
//   → { series, points: [{ month: 'YYYY-MM', endOfMonth, average, lastDate }] }  (tasas en % anual)
//   GET ?check=1 → { ok, latest } para verificar que el token funciona (datos públicos, sin sesión).
export const BANXICO_SERIES: Record<string, { id: string; label: string }> = {
  tiie28: { id: 'SF43783', label: 'TIIE 28 días' },
  tiie91: { id: 'SF43878', label: 'TIIE 91 días' },
  tiie_fondeo: { id: 'SF331451', label: 'TIIE de fondeo' },
};

const BASE = 'https://www.banxico.org.mx/SieAPIRest/service/v1/series';
const isDate = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

// "dd/mm/yyyy" → "yyyy-mm-dd"; "N/E" (no existe) se descarta.
function parseObservations(json: any): Array<{ date: string; value: number }> {
  const datos = json?.bmx?.series?.[0]?.datos || [];
  return datos.flatMap((d: any) => {
    const m = String(d.fecha || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    const v = Number(String(d.dato || '').replace(/,/g, ''));
    return m && Number.isFinite(v) ? [{ date: `${m[3]}-${m[2]}-${m[1]}`, value: v }] : [];
  });
}

export function monthlyPoints(obs: Array<{ date: string; value: number }>) {
  const byMonth = new Map<string, Array<{ date: string; value: number }>>();
  obs.forEach(o => byMonth.set(o.date.slice(0, 7), [...(byMonth.get(o.date.slice(0, 7)) || []), o]));
  return [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([month, list]) => {
    const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date));
    return { month, endOfMonth: sorted.at(-1)!.value, lastDate: sorted.at(-1)!.date, average: sorted.reduce((s, o) => s + o.value, 0) / sorted.length };
  });
}

async function fetchSeries(seriesId: string, from: string, to: string, token: string) {
  const r = await fetch(`${BASE}/${seriesId}/datos/${from}/${to}`, { headers: { 'Bmx-Token': token, Accept: 'application/json' } });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* respuesta no JSON */ }
  if (!r.ok) throw Object.assign(new Error(json?.error?.mensaje || json?.error?.detalle || `Banxico respondió ${r.status}`), { status: r.status });
  return parseObservations(json);
}

export async function banxicoProxyHandler(req: any, res: any) {
  const token = process.env.BANXICO_TOKEN;
  if (!token) return sendJson(res, 500, { error: 'BANXICO_TOKEN no está configurado en el servidor' });
  try {
    if (req.method === 'GET' && req.query?.check) {
      const to = new Date().toISOString().slice(0, 10);
      const from = new Date(Date.now() - 20 * 86400000).toISOString().slice(0, 10);
      const obs = await fetchSeries(BANXICO_SERIES.tiie28.id, from, to, token);
      return sendJson(res, 200, { ok: obs.length > 0, latest: obs.at(-1) || null });
    }
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
    const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_KEY;
    if (!supabaseUrl || !serviceKey) return sendJson(res, 500, { error: 'Supabase admin env missing' });
    const access = await requireActiveUser(req, supabaseUrl, serviceKey);
    if (!access.ok) return sendJson(res, access.status, { error: access.error });
    const incoming = await readJson(req);
    const s = BANXICO_SERIES[String(incoming.series || 'tiie28')];
    if (!s) return sendJson(res, 400, { error: 'Serie no soportada' });
    if (!isDate(incoming.from) || !isDate(incoming.to)) return sendJson(res, 400, { error: 'Fechas inválidas (YYYY-MM-DD)' });
    const obs = await fetchSeries(s.id, incoming.from, incoming.to, token);
    return sendJson(res, 200, { series: incoming.series || 'tiie28', label: s.label, points: monthlyPoints(obs) });
  } catch (error: any) {
    return sendJson(res, error?.status && error.status < 500 ? error.status : 502, { error: error?.message || 'Error al consultar Banxico' });
  }
}
