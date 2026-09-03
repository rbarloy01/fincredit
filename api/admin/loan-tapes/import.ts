import { readJson, requireManager, sendJson } from '../../_helpers.js';

async function readResponseJson(response: Response, fallback: any = null) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
}

async function supabaseFetch(supabaseUrl: string, serviceKey: string, path: string, init: RequestInit = {}) {
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      ...(init.headers || {}),
    } as Record<string, string>,
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Supabase ${response.status}: ${detail}`);
  }
  return response;
}

function periodFromRows(rows: any[]) {
  const dates = rows
    .map(row => String(row?.file_date || '').slice(0, 10))
    .filter(Boolean)
    .sort();
  return dates[dates.length - 1] || null;
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });

  try {
    const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_KEY;
    if (!supabaseUrl || !serviceKey) return sendJson(res, 500, { error: 'Supabase admin env missing' });

    const access = await requireManager(req, supabaseUrl, serviceKey);
    if (!access.ok) return sendJson(res, access.status, { error: access.error });
    const orgId = access.profile?.org_id;
    if (!orgId) return sendJson(res, 400, { error: 'El manager actual no tiene organización asignada.' });

    const body = await readJson(req);
    const fileName = String(body.fileName || '').trim();
    const name = String(body.name || fileName.replace(/\.[^.]+$/, '') || '').trim();
    const clientName = String(body.clientName || '').trim();
    const clientId = String(body.clientId || '').trim();
    const extractedData = body.extractedData;
    const standardized = Array.isArray(extractedData?._standardized) ? extractedData._standardized : [];
    if (!fileName || !name) return sendJson(res, 400, { error: 'Falta fileName/name.' });
    if (!clientId && !clientName) return sendJson(res, 400, { error: 'Falta clientId o clientName.' });
    if (!standardized.length) return sendJson(res, 400, { error: 'El loan tape no trae filas _standardized.' });

    const clientFilter = clientId
      ? `id=eq.${encodeURIComponent(clientId)}`
      : `name=ilike.*${encodeURIComponent(clientName)}*`;
    const clients = await readResponseJson(await supabaseFetch(
      supabaseUrl,
      serviceKey,
      `clients?select=id,name,org_id&org_id=eq.${encodeURIComponent(orgId)}&${clientFilter}&limit=5`,
    ), []);
    if (!clients?.length) return sendJson(res, 404, { error: `No encontré cliente para ${clientId || clientName}.` });
    if (clients.length > 1 && !clientId) return sendJson(res, 409, { error: `Más de un cliente coincide con ${clientName}.`, clients });
    const client = clients[0];

    const existing = await readResponseJson(await supabaseFetch(
      supabaseUrl,
      serviceKey,
      `loan_tapes?select=id,name,file_name&client_id=eq.${encodeURIComponent(client.id)}&file_name=eq.${encodeURIComponent(fileName)}&limit=1`,
    ), []);

    const tapeType = /factoraje|factor|cedente/i.test(String(body.tapeType || '')) ? 'factoraje' : (body.tapeType || 'credito');
    const payload = {
      client_id: client.id,
      source_document_id: null,
      name,
      file_name: fileName,
      tape_type: tapeType,
      extracted_data: extractedData,
      analyst_state: body.analystState || {},
    };

    let action = 'inserted';
    let rows: any[];
    if (existing?.[0]?.id) {
      action = 'updated';
      rows = await readResponseJson(await supabaseFetch(
        supabaseUrl,
        serviceKey,
        `loan_tapes?id=eq.${encodeURIComponent(existing[0].id)}&select=id,name,file_name,tape_type,upload_date`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
          body: JSON.stringify(payload),
        },
      ), []);
    } else {
      rows = await readResponseJson(await supabaseFetch(
        supabaseUrl,
        serviceKey,
        'loan_tapes?select=id,name,file_name,tape_type,upload_date',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
          body: JSON.stringify(payload),
        },
      ), []);
    }

    sendJson(res, 200, {
      action,
      client: { id: client.id, name: client.name },
      tape: rows?.[0] || null,
      rows: standardized.length,
      totalBalance: standardized.reduce((sum: number, row: any) => sum + (Number(row?.outstanding_balance) || 0), 0),
      fileDate: periodFromRows(standardized),
    });
  } catch (error: any) {
    sendJson(res, 500, { error: error?.message || 'Error importando loan tape' });
  }
}
