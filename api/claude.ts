import { forwardJson, readJson, sendJson } from './_helpers';

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
    sendJson(res, 500, { error: error?.message || 'Claude proxy error' });
  }
}
