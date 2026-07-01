import { forwardJson, readJson, sendJson } from '../_helpers';

export const maxDuration = 60;

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
  try {
    const incoming = await readJson(req);
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
