import { sendJson } from './_helpers.js';

type SupabaseProfile = {
  id: string;
  role: 'manager' | 'analyst' | 'pending';
  org_id?: string | null;
};

async function readJsonResponse(response: Response, fallback: any) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
}

async function authenticatedUser(req: any, supabaseUrl: string, serviceKey: string) {
  const raw = req.headers?.authorization || req.headers?.Authorization || '';
  const token = String(raw).replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;

  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${token}` },
  });
  const user = await readJsonResponse(response, null);
  return response.ok && user?.id ? user : null;
}

async function restJson(supabaseUrl: string, serviceKey: string, path: string) {
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
    },
  });
  const json = await readJsonResponse(response, []);
  if (!response.ok) throw new Error(json?.message || json?.error || 'Supabase query failed');
  return json;
}

function chunk<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function inFilter(ids: string[]) {
  return `in.(${ids.map(id => `"${id.replace(/"/g, '')}"`).join(',')})`;
}

async function getProfile(supabaseUrl: string, serviceKey: string, userId: string): Promise<SupabaseProfile | null> {
  const profiles = await restJson(
    supabaseUrl,
    serviceKey,
    `profiles?select=id,role,org_id&id=eq.${encodeURIComponent(userId)}&limit=1`,
  );
  return profiles?.[0] || null;
}

async function getByClientIds(supabaseUrl: string, serviceKey: string, table: string, clientIds: string[], order?: string) {
  const batches = await Promise.all(chunk(clientIds, 75).map(ids => {
    const params = new URLSearchParams({
      select: '*',
      client_id: inFilter(ids),
    });
    if (order) params.set('order', order);
    return restJson(supabaseUrl, serviceKey, `${table}?${params.toString()}`);
  }));
  return batches.flat();
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });

  try {
    const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_KEY;
    if (!supabaseUrl || !serviceKey) return sendJson(res, 500, { error: 'Supabase admin env missing' });

    const user = await authenticatedUser(req, supabaseUrl, serviceKey);
    if (!user) return sendJson(res, 401, { error: 'No autenticado' });

    const profile = await getProfile(supabaseUrl, serviceKey, user.id);
    if (!profile || !['manager', 'analyst'].includes(profile.role)) {
      return sendJson(res, 403, { error: 'Usuario sin acceso aprobado' });
    }
    if (!profile.org_id) return sendJson(res, 403, { error: 'Usuario sin organización asignada' });

    const clientParams = new URLSearchParams({
      select: '*',
      org_id: `eq.${profile.org_id}`,
      order: 'created_at.desc',
    });
    const clients = await restJson(supabaseUrl, serviceKey, `clients?${clientParams.toString()}`);
    const clientIds = clients.map((client: any) => client.id).filter(Boolean);

    const [customFields, financialStatements, transactions] = clientIds.length
      ? await Promise.all([
          getByClientIds(supabaseUrl, serviceKey, 'custom_fields', clientIds),
          getByClientIds(supabaseUrl, serviceKey, 'financial_statements', clientIds, 'period_date.asc'),
          getByClientIds(supabaseUrl, serviceKey, 'transactions', clientIds, 'created_at.desc'),
        ])
      : [[], [], []];

    return sendJson(res, 200, {
      clients,
      customFields,
      financialStatements,
      transactions,
    });
  } catch (error: any) {
    return sendJson(res, 500, { error: error?.message || 'Benchmarking API error' });
  }
}
