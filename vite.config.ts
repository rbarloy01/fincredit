import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import https from 'node:https';

function readBody(req: any): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function postJson(url: string, apiKey: string, payload: unknown, extraHeaders?: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = https.request({
      hostname: target.hostname,
      path: target.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        ...(extraHeaders || {}),
      },
    }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk.toString(); });
      response.on('end', () => resolve({ status: response.statusCode || 500, body }));
    });
    request.on('error', reject);
    request.write(JSON.stringify(payload));
    request.end();
  });
}

function postJsonAnthropicStyle(url: string, apiKey: string, payload: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const bodyStr = JSON.stringify(payload);
    const request = https.request({
      hostname: target.hostname,
      path: target.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk.toString(); });
      response.on('end', () => resolve({ status: response.statusCode || 500, body }));
    });
    request.on('error', reject);
    request.write(bodyStr);
    request.end();
  });
}

function restJson(url: string, serviceKey: string, method: string, payload?: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const bodyStr = payload === undefined ? '' : JSON.stringify(payload);
    const request = https.request({
      hostname: target.hostname,
      path: target.pathname + target.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        Prefer: 'resolution=merge-duplicates,return=representation',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk.toString(); });
      response.on('end', () => resolve({ status: response.statusCode || 500, body }));
    });
    request.on('error', reject);
    if (bodyStr) request.write(bodyStr);
    request.end();
  });
}

function parseJson(body: string, fallback: any) {
  try { return JSON.parse(body || JSON.stringify(fallback)); } catch { return fallback; }
}

async function findOrganization(supabaseUrl: string, serviceKey: string, slug: string): Promise<string | null> {
  const foundRes = await restJson(`${supabaseUrl}/rest/v1/organizations?select=id&slug=eq.${encodeURIComponent(slug)}&limit=1`, serviceKey, 'GET');
  if (foundRes.status >= 300) throw new Error(parseJson(foundRes.body, {}).message || 'Error al buscar organización');
  return parseJson(foundRes.body, [])?.[0]?.id || null;
}

async function ensureOrganization(supabaseUrl: string, serviceKey: string, organizationName = 'Syscap', slug = 'syscap'): Promise<string> {
  const safeSlug = slug.toLowerCase();
  let orgId = await findOrganization(supabaseUrl, serviceKey, safeSlug);
  if (!orgId) {
    const createdRes = await restJson(`${supabaseUrl}/rest/v1/organizations`, serviceKey, 'POST', { name: organizationName, slug: safeSlug });
    if (createdRes.status >= 300 && !/duplicate|unique|organizations_slug/i.test(createdRes.body || '')) {
      throw new Error(parseJson(createdRes.body, {}).message || 'Error al crear organización');
    }
    orgId = parseJson(createdRes.body, [])?.[0]?.id || await findOrganization(supabaseUrl, serviceKey, safeSlug);
  }
  if (!orgId) throw new Error('No se pudo crear organización');
  return orgId;
}

async function ensureProfile(supabaseUrl: string, serviceKey: string, body: any, orgId: string): Promise<void> {
  if (!body.userId) return;
  const foundRes = await restJson(`${supabaseUrl}/rest/v1/profiles?select=id,role&id=eq.${encodeURIComponent(body.userId)}&limit=1`, serviceKey, 'GET');
  if (foundRes.status >= 300) throw new Error(parseJson(foundRes.body, {}).message || 'Error al buscar perfil');
  if (parseJson(foundRes.body, [])?.[0]?.id) {
    const updateRes = await restJson(`${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(body.userId)}`, serviceKey, 'PATCH', {
      name: String(body.userName || body.name || body.userEmail || 'Usuario'),
      email: String(body.userEmail || body.email || '').toLowerCase(),
      org_id: orgId,
    });
    if (updateRes.status >= 300) throw new Error(parseJson(updateRes.body, {}).message || 'Error al actualizar perfil');
    return;
  }
  const profileRes = await restJson(`${supabaseUrl}/rest/v1/profiles`, serviceKey, 'POST', {
    id: body.userId,
    name: String(body.userName || body.name || body.userEmail || 'Usuario'),
    email: String(body.userEmail || body.email || '').toLowerCase(),
    role: 'pending',
    org_id: orgId,
  });
  if (profileRes.status >= 300) throw new Error(parseJson(profileRes.body, {}).message || 'Error al preparar perfil');
}

async function requireManager(req: any, supabaseUrl: string, serviceKey: string): Promise<{ ok: boolean; status: number; error?: string }> {
  const raw = req.headers?.authorization || req.headers?.Authorization || '';
  const token = String(raw).replace(/^Bearer\s+/i, '').trim();
  if (!token) return { ok: false, status: 401, error: 'No autenticado' };

  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${token}` },
  });
  const user = parseJson(await userRes.text(), null);
  if (userRes.status >= 300 || !user?.id) return { ok: false, status: 401, error: 'Sesión inválida' };

  const profileRes = await fetch(`${supabaseUrl}/rest/v1/profiles?select=role&id=eq.${encodeURIComponent(user.id)}&limit=1`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  });
  const profile = parseJson(await profileRes.text(), []);
  if (profileRes.status >= 300) return { ok: false, status: 500, error: 'No se pudo verificar permisos' };
  if (profile?.[0]?.role !== 'manager') return { ok: false, status: 403, error: 'Solo managers pueden administrar usuarios' };

  return { ok: true, status: 200 };
}

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    return {
      root: path.resolve(__dirname),
      server: {
        port: 4175,
        host: '0.0.0.0',
      },
      plugins: [react(), {
        name: 'local-openai-proxy',
        configureServer(server) {
          server.middlewares.use('/api/openai/responses', async (req, res) => {
            if (req.method !== 'POST') {
              res.statusCode = 405;
              res.end('Method not allowed');
              return;
            }
            try {
              const incoming = JSON.parse(await readBody(req));
              const apiKey = incoming.apiKey || env.OPENAI_API_KEY;
              if (!apiKey) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: 'OPENAI_API_KEY missing' }));
                return;
              }
              const result = await postJson('https://api.openai.com/v1/responses', apiKey, incoming.payload);
              res.statusCode = result.status;
              res.setHeader('Content-Type', 'application/json');
              res.end(result.body);
            } catch (error: any) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: error?.message || 'OpenAI proxy error' }));
            }
          });

          server.middlewares.use('/api/gemini', async (req, res) => {
            if (req.method !== 'POST') { res.statusCode = 405; res.end('Method not allowed'); return; }
            try {
              const incoming = JSON.parse(await readBody(req));
              const apiKey = incoming.apiKey || env.GEMINI_API_KEY;
              if (!apiKey) { res.statusCode = 400; res.end(JSON.stringify({ error: 'GEMINI_API_KEY missing' })); return; }
              const model = incoming.model || 'gemini-flash-latest';
              const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
              const target = new URL(url);
              const bodyStr = JSON.stringify(incoming.payload);
              const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
                const request = https.request({
                  hostname: target.hostname,
                  path: target.pathname + target.search,
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
                }, response => {
                  let body = ''; response.on('data', c => { body += c; }); response.on('end', () => resolve({ status: response.statusCode || 500, body }));
                });
                request.on('error', reject); request.write(bodyStr); request.end();
              });
              res.statusCode = result.status; res.setHeader('Content-Type', 'application/json'); res.end(result.body);
            } catch (error: any) { res.statusCode = 500; res.end(JSON.stringify({ error: error?.message || 'Gemini proxy error' })); }
          });

          server.middlewares.use('/api/admin/org/ensure', async (req, res) => {
            if (req.method !== 'POST') { res.statusCode = 405; res.end('Method not allowed'); return; }
            try {
              const body = JSON.parse(await readBody(req));
              const supabaseUrl = env.SUPABASE_URL || env.VITE_SUPABASE_URL;
              const serviceKey = env.SUPABASE_SERVICE_KEY;
              if (!supabaseUrl || !serviceKey) { res.statusCode = 500; res.end(JSON.stringify({ error: 'Supabase admin env missing' })); return; }
              const orgId = await ensureOrganization(supabaseUrl, serviceKey, body.organizationName, body.slug);
              await ensureProfile(supabaseUrl, serviceKey, body, orgId);
              res.statusCode = 200;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ orgId }));
            } catch (error: any) { res.statusCode = 500; res.end(JSON.stringify({ error: error?.message || 'Error interno' })); }
          });

          server.middlewares.use('/api/admin/users/create', async (req, res) => {
            if (req.method !== 'POST') { res.statusCode = 405; res.end('Method not allowed'); return; }
            try {
              const body = JSON.parse(await readBody(req));
              const supabaseUrl = env.SUPABASE_URL;
              const serviceKey = env.SUPABASE_SERVICE_KEY;
              const access = await requireManager(req, supabaseUrl, serviceKey);
              if (!access.ok) { res.statusCode = access.status; res.end(JSON.stringify({ error: access.error })); return; }
              // 1. Create auth user
              const authRes = await postJson(
                `${supabaseUrl}/auth/v1/admin/users`,
                serviceKey,
                { email: body.email, password: body.password, email_confirm: true },
                { apikey: serviceKey }
              );
              if (authRes.status !== 200) { res.statusCode = 400; res.end(JSON.stringify({ error: JSON.parse(authRes.body).msg || 'Error al crear usuario' })); return; }
              const user = JSON.parse(authRes.body);
              const orgId = await ensureOrganization(supabaseUrl, serviceKey);
              // 2. Insert profile
              await postJson(
                `${supabaseUrl}/rest/v1/profiles`,
                serviceKey,
                { id: user.id, name: body.name, email: body.email.toLowerCase(), role: body.role === 'manager' ? 'manager' : 'analyst', org_id: orgId },
                { apikey: serviceKey, 'Content-Type': 'application/json', Prefer: 'return=minimal' }
              );
              res.statusCode = 200;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ id: user.id, name: body.name, email: body.email, role: body.role === 'manager' ? 'manager' : 'analyst', createdAt: user.created_at }));
            } catch (error: any) { res.statusCode = 500; res.end(JSON.stringify({ error: error?.message || 'Error interno' })); }
          });

          server.middlewares.use('/api/admin/users/delete', async (req, res) => {
            if (req.method !== 'POST') { res.statusCode = 405; res.end('Method not allowed'); return; }
            try {
              const body = JSON.parse(await readBody(req));
              const supabaseUrl = env.SUPABASE_URL;
              const serviceKey = env.SUPABASE_SERVICE_KEY;
              const access = await requireManager(req, supabaseUrl, serviceKey);
              if (!access.ok) { res.statusCode = access.status; res.end(JSON.stringify({ error: access.error })); return; }
              const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
                const target = new URL(`${supabaseUrl}/auth/v1/admin/users/${body.userId}`);
                const request = https.request({
                  hostname: target.hostname, path: target.pathname, method: 'DELETE',
                  headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
                }, response => {
                  let b = ''; response.on('data', c => { b += c; }); response.on('end', () => resolve({ status: response.statusCode || 500, body: b }));
                });
                request.on('error', reject); request.end();
              });
              res.statusCode = result.status < 300 ? 200 : result.status;
              res.end(result.status < 300 ? '{}' : result.body);
            } catch (error: any) { res.statusCode = 500; res.end(JSON.stringify({ error: error?.message || 'Error interno' })); }
          });

          server.middlewares.use('/api/claude', async (req, res) => {
            if (req.method !== 'POST') {
              res.statusCode = 405;
              res.end('Method not allowed');
              return;
            }
            try {
              const incoming = JSON.parse(await readBody(req));
              const apiKey = incoming.apiKey || env.ANTHROPIC_API_KEY;
              if (!apiKey) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: 'ANTHROPIC_API_KEY missing — configure it in Settings' }));
                return;
              }
              const result = await postJsonAnthropicStyle('https://api.anthropic.com/v1/messages', apiKey, incoming.payload);
              res.statusCode = result.status;
              res.setHeader('Content-Type', 'application/json');
              res.end(result.body);
            } catch (error: any) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: error?.message || 'Claude proxy error' }));
            }
          });
        }
      }],
      define: {
        'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
        'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY)
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
