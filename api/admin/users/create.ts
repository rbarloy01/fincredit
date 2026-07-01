import { forwardJson, readJson, requireManager, sendJson } from '../../_helpers.js';

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
  try {
    const body = await readJson(req);
    const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_KEY;
    if (!supabaseUrl || !serviceKey) return sendJson(res, 500, { error: 'Supabase admin env missing' });
    const access = await requireManager(req, supabaseUrl, serviceKey);
    if (!access.ok) return sendJson(res, access.status, { error: access.error });
    const orgId = access.profile?.org_id;
    if (!orgId) return sendJson(res, 400, { error: 'El manager actual no tiene organización asignada.' });

    const authRes = await forwardJson(`${supabaseUrl}/auth/v1/admin/users`, {
      email: body.email,
      password: body.password,
      email_confirm: true,
    }, { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` });

    if (authRes.status >= 300) return sendJson(res, 400, { error: JSON.parse(authRes.text || '{}').msg || 'Error al crear usuario' });
    const user = JSON.parse(authRes.text);

    await forwardJson(`${supabaseUrl}/rest/v1/profiles`, {
      id: user.id,
      name: body.name,
      email: String(body.email || '').toLowerCase(),
      role: body.role === 'manager' ? 'manager' : 'analyst',
      org_id: orgId,
    }, { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, Prefer: 'return=minimal' });

    sendJson(res, 200, { id: user.id, name: body.name, email: body.email, role: body.role === 'manager' ? 'manager' : 'analyst', createdAt: user.created_at });
  } catch (error: any) {
    sendJson(res, 500, { error: error?.message || 'Error interno' });
  }
}
