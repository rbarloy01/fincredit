export async function readJson(req: any) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  return {};
}

export function sendJson(res: any, status: number, data: unknown) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}

export async function forwardJson(url: string, payload: unknown, headers: Record<string, string>) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  return { status: response.status, text };
}

export async function requireManager(req: any, supabaseUrl: string, serviceKey: string) {
  const raw = req.headers?.authorization || req.headers?.Authorization || '';
  const token = String(raw).replace(/^Bearer\s+/i, '').trim();
  if (!token) return { ok: false, status: 401, error: 'No autenticado' };

  const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${token}` },
  });
  const userText = await userResponse.text();
  const user = userText ? JSON.parse(userText) : null;
  if (userResponse.status >= 300 || !user?.id) return { ok: false, status: 401, error: 'Sesión inválida' };

  const profileResponse = await fetch(`${supabaseUrl}/rest/v1/profiles?select=role&id=eq.${encodeURIComponent(user.id)}&limit=1`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  });
  const profileText = await profileResponse.text();
  const profile = profileText ? JSON.parse(profileText) : [];
  if (profileResponse.status >= 300) return { ok: false, status: 500, error: 'No se pudo verificar permisos' };
  if (profile?.[0]?.role !== 'manager') return { ok: false, status: 403, error: 'Solo managers pueden administrar usuarios' };

  return { ok: true, status: 200, error: null, user };
}
