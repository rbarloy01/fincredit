import { forwardJson, readJson, requireActiveUser, sendJson } from '../../server/apiHelpers.js';

export const maxDuration = 60;

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
  try {
    const incoming = await readJson(req);
    const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_KEY;
    if (!supabaseUrl || !serviceKey) return sendJson(res, 500, { error: 'Supabase admin env missing' });
    const access = await requireActiveUser(req, supabaseUrl, serviceKey);
    if (!access.ok) return sendJson(res, access.status, { error: access.error });

    const apiKey = incoming.apiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) return sendJson(res, 400, { error: 'OPENAI_API_KEY missing' });
    const result = await forwardJson('https://api.openai.com/v1/responses', incoming.payload, {
      Authorization: `Bearer ${apiKey}`,
    });
    res.status(result.status).setHeader('Content-Type', 'application/json');
    res.end(result.text);
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      return sendJson(res, 504, { error: 'OpenAI tardó demasiado en responder. Reintenta o cambia de proveedor.' });
    }
    sendJson(res, 500, { error: error?.message || 'OpenAI proxy error' });
  }
}
