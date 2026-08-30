import { forwardJson, readJson, requireActiveUser, sendJson } from '../server/apiHelpers.js';

export const maxDuration = 60;

function openRouterRefererUrl() {
  const raw = process.env.OPENROUTER_SITE_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL || 'https://finmonitor-base.vercel.app';
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
  try {
    const incoming = await readJson(req);
    const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_KEY;
    if (!supabaseUrl || !serviceKey) return sendJson(res, 500, { error: 'Supabase admin env missing' });
    const access = await requireActiveUser(req, supabaseUrl, serviceKey);
    if (!access.ok) return sendJson(res, access.status, { error: access.error });

    const provider = incoming.provider || req.query?.provider || (String(req.url || '').includes('nvidia') ? 'nvidia_nim' : 'bytez');
    if (provider === 'openrouter') {
      const apiKey = incoming.apiKey || process.env.OPENROUTER_API_KEY;
      if (!apiKey) return sendJson(res, 400, { error: 'OPENROUTER_API_KEY missing' });
      const result = await forwardJson('https://openrouter.ai/api/v1/chat/completions', incoming.payload, {
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': openRouterRefererUrl(),
        'X-Title': process.env.OPENROUTER_APP_TITLE || 'FinMonitor',
      });
      res.status(result.status).setHeader('Content-Type', 'application/json');
      res.end(result.text);
      return;
    }

    if (provider === 'nvidia_nim') {
      const apiKey = incoming.apiKey || process.env.NVIDIA_NIM_API_KEY;
      if (!apiKey) return sendJson(res, 400, { error: 'NVIDIA_NIM_API_KEY missing' });
      const baseUrl = (incoming.baseUrl || process.env.NVIDIA_NIM_BASE_URL || 'https://integrate.api.nvidia.com/v1').replace(/\/$/, '');
      const result = await forwardJson(`${baseUrl}/chat/completions`, incoming.payload, {
        Authorization: `Bearer ${apiKey}`,
      });
      res.status(result.status).setHeader('Content-Type', 'application/json');
      res.end(result.text);
      return;
    }

    const apiKey = incoming.apiKey || process.env.BYTEZ_API_KEY;
    if (!apiKey) return sendJson(res, 400, { error: 'BYTEZ_API_KEY missing' });
    const headers: Record<string, string> = { Authorization: apiKey };
    const providerKey = incoming.providerKey || process.env.BYTEZ_PROVIDER_KEY;
    if (providerKey) headers['provider-key'] = providerKey;
    const result = await forwardJson('https://api.bytez.com/models/v2/openai/v1/chat/completions', incoming.payload, headers);
    res.status(result.status).setHeader('Content-Type', 'application/json');
    res.end(result.text);
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      return sendJson(res, 504, { error: 'El proveedor AI tardó demasiado en responder. Reintenta o cambia de proveedor.' });
    }
    sendJson(res, 500, { error: error?.message || 'AI proxy error' });
  }
}
