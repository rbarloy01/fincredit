import { forwardJson, readJson, sendJson } from './_helpers.js';

export const maxDuration = 60;

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
  try {
    const incoming = await readJson(req);
    const apiKey = incoming.apiKey || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return sendJson(res, 400, { error: 'ANTHROPIC_API_KEY missing' });
    const result = await forwardJson('https://api.anthropic.com/v1/messages', incoming.payload, {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    });
    res.status(result.status).setHeader('Content-Type', 'application/json');
    res.end(result.text);
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      return sendJson(res, 504, { error: 'Claude tardó demasiado en responder. Reintenta o cambia de proveedor.' });
    }
    sendJson(res, 500, { error: error?.message || 'Claude proxy error' });
  }
}
