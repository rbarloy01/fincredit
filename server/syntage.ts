// Shared Syntage helpers for the /api/syntage proxy. The API key lives only in server env
// (SYNTAGE_API_KEY); every org user goes through this proxy with their Supabase session.

export const SYNTAGE_SANDBOX_URL = 'https://api.sandbox.syntage.com';
export const SYNTAGE_PRODUCTION_URL = 'https://api.syntage.com';

// Production is opt-in: SYNTAGE_BASE_URL must point to it AND SYNTAGE_ALLOW_PRODUCTION=1,
// so a copied env var can never silently hit live SAT data.
export function resolveSyntageBaseUrl(env: Record<string, string | undefined>) {
  const configured = (env.SYNTAGE_BASE_URL || SYNTAGE_SANDBOX_URL).replace(/\/+$/, '');
  if (configured === SYNTAGE_SANDBOX_URL) return { ok: true as const, baseUrl: configured, environment: 'sandbox' as const };
  if (configured === SYNTAGE_PRODUCTION_URL) {
    if (env.SYNTAGE_ALLOW_PRODUCTION === '1') return { ok: true as const, baseUrl: configured, environment: 'production' as const };
    return { ok: false as const, error: 'Syntage producción no habilitado (falta SYNTAGE_ALLOW_PRODUCTION=1)' };
  }
  return { ok: false as const, error: 'SYNTAGE_BASE_URL no es un host de Syntage válido' };
}

// Accepts an API path ("/entities/abc/invoices") or a hydra:next IRI, which Syntage returns as a
// relative path with its own query string. Rejects anything that could escape the Syntage host.
export function sanitizeSyntagePath(rawPath: unknown) {
  if (typeof rawPath !== 'string') return null;
  const path = rawPath.trim();
  if (!path.startsWith('/') || path.startsWith('//')) return null;
  if (path.includes('://') || path.includes('\\') || /(^|\/)\.\.(\/|$|\?)/.test(path)) return null;
  if (/[\s\u0000-\u001f]/.test(path)) return null;
  return path;
}

export function buildSyntageUrl(baseUrl: string, path: string, query?: Record<string, unknown>) {
  const url = new URL(baseUrl + path);
  if (url.origin !== new URL(baseUrl).origin) return null;
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === '') continue;
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) url.searchParams.append(key, String(v));
  }
  return url.toString();
}
