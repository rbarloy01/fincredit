import { readJson, requireActiveUser, sendJson } from './apiHelpers.js';
import { buildSyntageUrl, resolveSyntageBaseUrl, sanitizeSyntagePath } from './syntage.js';

// Read-only proxy: any approved org user (manager/analyst) can GET Syntage resources with the
// org's shared key. Served at /api/syntage via a vercel.json rewrite into api/gemini.ts (Hobby plan
// caps deployments at 12 functions).
// Writes (creating entities, starting extractions) are intentionally not exposed yet.
export async function syntageProxyHandler(req: any, res: any) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
  try {
    const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_KEY;
    if (!supabaseUrl || !serviceKey) return sendJson(res, 500, { error: 'Supabase admin env missing' });
    const access = await requireActiveUser(req, supabaseUrl, serviceKey);
    if (!access.ok) return sendJson(res, access.status, { error: access.error });

    const apiKey = process.env.SYNTAGE_API_KEY;
    if (!apiKey) return sendJson(res, 500, { error: 'SYNTAGE_API_KEY missing' });
    const env = resolveSyntageBaseUrl(process.env);
    if (!env.ok) return sendJson(res, 500, { error: env.error });

    const incoming = await readJson(req);
    const path = sanitizeSyntagePath(incoming.path);
    if (!path) return sendJson(res, 400, { error: 'Ruta de Syntage inválida' });
    const url = buildSyntageUrl(env.baseUrl, path, incoming.query);
    if (!url) return sendJson(res, 400, { error: 'Ruta de Syntage inválida' });

    const headers: Record<string, string> = { Accept: 'application/ld+json', 'X-API-Key': apiKey };
    if (incoming.cursor) headers['X-Pagination-Style'] = 'cursor';

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 55000);
    let response: Response;
    try {
      response = await fetch(url, { method: 'GET', headers, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }

    const text = await response.text();
    let data: unknown = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 2000) }; }
    const requestId = response.headers.get('x-request-id');
    // Log only the trace, never the key or response body (taxpayer data).
    console.log(`[syntage] ${env.environment} GET ${path.split('?')[0]} -> ${response.status} user=${access.user.id} reqId=${requestId}`);

    return sendJson(res, response.status, {
      environment: env.environment,
      requestId,
      rateLimitReset: response.headers.get('x-ratelimit-reset'),
      data,
    });
  } catch (error: any) {
    if (error?.name === 'AbortError') return sendJson(res, 504, { error: 'Syntage tardó demasiado en responder.' });
    sendJson(res, 500, { error: error?.message || 'Syntage proxy error' });
  }
}
