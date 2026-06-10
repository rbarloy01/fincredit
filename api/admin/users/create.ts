import { forwardJson, readJson, sendJson } from '../../_helpers';

async function restJson(url: string, serviceKey: string, method: string, body?: unknown) {
  const response = await fetch(url, {
    method,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (response.status >= 300) throw new Error(json?.message || json?.error || text || 'Supabase error');
  return json;
}

async function ensureOrganization(supabaseUrl: string, serviceKey: string, userId: string) {
  const found = await restJson(`${supabaseUrl}/rest/v1/organizations?select=id&slug=eq.syscap&limit=1`, serviceKey, 'GET');
  let orgId = found?.[0]?.id;
  if (!orgId) {
    const created = await restJson(`${supabaseUrl}/rest/v1/organizations`, serviceKey, 'POST', { name: 'Syscap', slug: 'syscap' });
    orgId = created?.[0]?.id;
  }
  if (orgId) await restJson(`${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`, serviceKey, 'PATCH', { org_id: orgId });
  return orgId;
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
  try {
    const body = await readJson(req);
    const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_KEY;
    if (!supabaseUrl || !serviceKey) return sendJson(res, 500, { error: 'Supabase admin env missing' });

    const authRes = await forwardJson(`${supabaseUrl}/auth/v1/admin/users`, {
      email: body.email,
      password: body.password,
      email_confirm: true,
    }, { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` });

    if (authRes.status >= 300) return sendJson(res, 400, { error: JSON.parse(authRes.text || '{}').msg || 'Error al crear usuario' });
    const user = JSON.parse(authRes.text);
    const orgId = await ensureOrganization(supabaseUrl, serviceKey, user.id);

    await forwardJson(`${supabaseUrl}/rest/v1/profiles`, {
      id: user.id,
      name: body.name,
      email: String(body.email || '').toLowerCase(),
      role: body.role,
      org_id: orgId,
    }, { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, Prefer: 'return=minimal' });

    sendJson(res, 200, { id: user.id, name: body.name, email: body.email, role: body.role, createdAt: user.created_at });
  } catch (error: any) {
    sendJson(res, 500, { error: error?.message || 'Error interno' });
  }
}
