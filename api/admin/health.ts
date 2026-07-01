import { requireManager, sendJson } from '../_helpers.js';

async function readResponseJson(response: Response, fallback: any) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });

  try {
    const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_KEY;
    if (!supabaseUrl || !serviceKey) return sendJson(res, 500, { error: 'Supabase admin env missing' });

    const access = await requireManager(req, supabaseUrl, serviceKey);
    if (!access.ok) return sendJson(res, access.status, { error: access.error });

    const [settingsResponse, profileResponse] = await Promise.all([
      fetch(`${supabaseUrl}/auth/v1/settings`, {
        headers: { apikey: serviceKey },
      }),
      fetch(`${supabaseUrl}/rest/v1/profiles?select=id,role,org_id&id=eq.${encodeURIComponent(access.user.id)}&limit=1`, {
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      }),
    ]);

    const settings = await readResponseJson(settingsResponse, {});
    const profiles = await readResponseJson(profileResponse, []);
    const profile = profiles?.[0] || null;

    sendJson(res, 200, {
      googleProviderEnabled: settingsResponse.ok && settings?.external?.google === true,
      googleProviderCheckError: settingsResponse.ok ? null : 'No se pudo consultar la configuración de Supabase Auth',
      aiKeys: {
        gemini: Boolean(process.env.GEMINI_API_KEY),
        claude: Boolean(process.env.ANTHROPIC_API_KEY),
        openai: Boolean(process.env.OPENAI_API_KEY),
      },
      ingestion: {
        googleServiceAccount: Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS),
        driveRootFolder: Boolean(process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID),
        documentAiProcessor: Boolean(process.env.GOOGLE_DOCUMENT_AI_PROCESSOR_NAME),
      },
      profile: {
        found: profileResponse.ok && Boolean(profile?.id),
        role: profile?.role || null,
        orgId: profile?.org_id || null,
        checkError: profileResponse.ok ? null : 'No se pudo consultar el perfil actual',
      },
    });
  } catch (error: any) {
    sendJson(res, 500, { error: error?.message || 'Health check error' });
  }
}
