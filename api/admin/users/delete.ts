import { readJson, sendJson } from '../../_helpers';

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
  try {
    const body = await readJson(req);
    const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_KEY;
    if (!supabaseUrl || !serviceKey) return sendJson(res, 500, { error: 'Supabase admin env missing' });

    const response = await fetch(`${supabaseUrl}/auth/v1/admin/users/${body.userId}`, {
      method: 'DELETE',
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    });
    const text = await response.text();
    res.status(response.status < 300 ? 200 : response.status).setHeader('Content-Type', 'application/json');
    res.end(response.status < 300 ? '{}' : text);
  } catch (error: any) {
    sendJson(res, 500, { error: error?.message || 'Error interno' });
  }
}
