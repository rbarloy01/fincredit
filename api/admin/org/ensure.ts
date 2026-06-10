import { readJson, sendJson } from '../../_helpers';

async function restJson(url: string, serviceKey: string, method: string, body?: unknown) {
  const response = await fetch(url, {
    method,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (response.status >= 300) throw new Error(json?.message || json?.error || text || 'Supabase error');
  return json;
}

async function findOrganization(supabaseUrl: string, serviceKey: string, slug: string) {
  const found = await restJson(`${supabaseUrl}/rest/v1/organizations?select=id&slug=eq.${encodeURIComponent(slug)}&limit=1`, serviceKey, 'GET');
  return found?.[0]?.id || null;
}

async function ensureOrganization(supabaseUrl: string, serviceKey: string, name: string, slug: string) {
  const existingId = await findOrganization(supabaseUrl, serviceKey, slug);
  if (existingId) return existingId;
  try {
    const created = await restJson(`${supabaseUrl}/rest/v1/organizations`, serviceKey, 'POST', { name, slug });
    return created?.[0]?.id || await findOrganization(supabaseUrl, serviceKey, slug);
  } catch (error: any) {
    if (/duplicate|unique|organizations_slug/i.test(error?.message || '')) {
      return findOrganization(supabaseUrl, serviceKey, slug);
    }
    throw error;
  }
}

async function ensureProfile(supabaseUrl: string, serviceKey: string, body: any, orgId: string) {
  if (!body.userId) return;
  const name = String(body.userName || body.name || body.userEmail || 'Usuario');
  const email = String(body.userEmail || body.email || '').toLowerCase();
  const role = body.role === 'manager' ? 'manager' : 'analyst';
  await restJson(`${supabaseUrl}/rest/v1/profiles?on_conflict=id`, serviceKey, 'POST', {
    id: body.userId,
    name,
    email,
    role,
    org_id: orgId,
  });
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
  try {
    const body = await readJson(req);
    const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_KEY;
    if (!supabaseUrl || !serviceKey) return sendJson(res, 500, { error: 'Supabase admin env missing' });

    const slug = String(body.slug || 'syscap').toLowerCase();
    const name = String(body.organizationName || 'Syscap');
    const orgId = await ensureOrganization(supabaseUrl, serviceKey, name, slug);
    if (!orgId) throw new Error('No se pudo crear organización');
    await ensureProfile(supabaseUrl, serviceKey, body, orgId);
    sendJson(res, 200, { orgId });
  } catch (error: any) {
    sendJson(res, 500, { error: error?.message || 'Error interno' });
  }
}
