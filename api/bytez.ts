import { forwardJson, readJson, sendJson } from './_helpers.js';

export const maxDuration = 60;

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
  try {
    const incoming = await readJson(req);
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
      return sendJson(res, 504, { error: 'Bytez tardó demasiado en responder. Reintenta o cambia de proveedor.' });
    }
    sendJson(res, 500, { error: error?.message || 'Bytez proxy error' });
  }
}
