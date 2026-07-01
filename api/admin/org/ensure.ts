import { sendJson } from '../../_helpers.js';

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

async function authenticatedUser(req: any, supabaseUrl: string, serviceKey: string) {
  const raw = req.headers?.authorization || req.headers?.Authorization || '';
  const token = String(raw).replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;

  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${token}` },
  });
  const text = await response.text();
  const user = text ? JSON.parse(text) : null;
  return response.ok && user?.id ? user : null;
}

function profileName(user: any) {
  return String(user?.user_metadata?.full_name || user?.user_metadata?.name || user?.email || 'Usuario');
}

function profileEmail(user: any) {
  return String(user?.email || '').toLowerCase();
}

function bootstrapOrgConfig() {
  const name = process.env.DEFAULT_ORGANIZATION_NAME || process.env.ORGANIZATION_NAME || '';
  const slug = (process.env.DEFAULT_ORGANIZATION_SLUG || process.env.ORGANIZATION_SLUG || name)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return name && slug ? { name, slug } : null;
}

async function ensureProfile(supabaseUrl: string, serviceKey: string, user: any) {
  const existing = await restJson(`${supabaseUrl}/rest/v1/profiles?select=id,role,org_id&id=eq.${encodeURIComponent(user.id)}&limit=1`, serviceKey, 'GET');
  let orgId = existing?.[0]?.org_id || null;

  if (!orgId && existing?.[0]?.role === 'manager') {
    const config = bootstrapOrgConfig();
    if (config) orgId = await ensureOrganization(supabaseUrl, serviceKey, config.name, config.slug);
  }

  const row = {
    name: profileName(user),
    email: profileEmail(user),
    ...(orgId ? { org_id: orgId } : {}),
  };

  if (existing?.[0]?.id) {
    await restJson(`${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}`, serviceKey, 'PATCH', row);
    return orgId;
  }

  await restJson(`${supabaseUrl}/rest/v1/profiles`, serviceKey, 'POST', {
    id: user.id,
    role: 'pending',
    ...row,
  });
  return orgId;
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
  try {
    const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_KEY;
    if (!supabaseUrl || !serviceKey) return sendJson(res, 500, { error: 'Supabase admin env missing' });

    const user = await authenticatedUser(req, supabaseUrl, serviceKey);
    if (!user) return sendJson(res, 401, { error: 'No autenticado' });

    const orgId = await ensureProfile(supabaseUrl, serviceKey, user);
    sendJson(res, 200, { orgId });
  } catch (error: any) {
    sendJson(res, 500, { error: error?.message || 'Error interno' });
  }
}
