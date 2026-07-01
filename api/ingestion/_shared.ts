import { google } from 'googleapis';
import { requireManager } from '../_helpers.js';

export type SupabaseAdmin = {
  url: string;
  serviceKey: string;
};

export type AdminAccess = {
  orgId: string;
  user: any;
  supabase: SupabaseAdmin;
};

export type DriveDownload = {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
};

export function env(name: string, fallback = '') {
  return process.env[name] || fallback;
}

export async function readResponseJson(response: Response, fallback: any = null) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
}

export async function supabaseFetch(
  admin: SupabaseAdmin,
  path: string,
  init: RequestInit = {},
) {
  const headers = {
    apikey: admin.serviceKey,
    Authorization: `Bearer ${admin.serviceKey}`,
    ...(init.headers || {}),
  } as Record<string, string>;
  const response = await fetch(`${admin.url}/rest/v1/${path}`, { ...init, headers });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Supabase ${response.status}: ${detail}`);
  }
  return response;
}

export async function supabaseJson<T = any>(
  admin: SupabaseAdmin,
  path: string,
  init: RequestInit = {},
  fallback: T,
): Promise<T> {
  const response = await supabaseFetch(admin, path, init);
  return readResponseJson(response, fallback);
}

export async function requireIngestionManager(req: any): Promise<AdminAccess> {
  const supabaseUrl = env('SUPABASE_URL') || env('VITE_SUPABASE_URL');
  const serviceKey = env('SUPABASE_SERVICE_KEY');
  if (!supabaseUrl || !serviceKey) throw new Error('Supabase admin env missing');

  const access = await requireManager(req, supabaseUrl, serviceKey);
  if (!access.ok) {
    const error: any = new Error(access.error || 'No autorizado');
    error.status = access.status;
    throw error;
  }

  const profile = await supabaseJson<any[]>(
    { url: supabaseUrl, serviceKey },
    `profiles?select=org_id&id=eq.${encodeURIComponent(access.user.id)}&limit=1`,
    {},
    [],
  );
  const orgId = profile?.[0]?.org_id;
  if (!orgId) {
    const error: any = new Error('El usuario no tiene organización asignada.');
    error.status = 400;
    throw error;
  }

  return { orgId, user: access.user, supabase: { url: supabaseUrl, serviceKey } };
}

function parseServiceAccountCredentials() {
  const raw = env('GOOGLE_SERVICE_ACCOUNT_JSON');
  if (!raw) return undefined;
  const json = raw.trim().startsWith('{')
    ? raw
    : Buffer.from(raw, 'base64').toString('utf8');
  const parsed = JSON.parse(json);
  if (parsed.private_key) parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
  return parsed;
}

export async function getGoogleAuth(scopes: string[]) {
  const credentials = parseServiceAccountCredentials();
  return new google.auth.GoogleAuth({
    credentials,
    scopes,
  });
}

export async function getDriveClient() {
  const auth = await getGoogleAuth(['https://www.googleapis.com/auth/drive.readonly']);
  return google.drive({ version: 'v3', auth });
}

export function normalizeToken(value?: string) {
  return (value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function compactKey(value?: string) {
  return normalizeToken(value).replace(/\s+/g, '');
}

export function classifyDocument(fileName: string, mimeType = '', path = '') {
  const haystack = normalizeToken(`${path} ${fileName}`);
  if (/loan tape|cartera|cobranza|cedula|cr[eé]ditos?|saldos?|vencid/.test(haystack)) return 'loan_tape';
  if (/contrato|convenio|pagare|pagar[eé]|fideicomiso|garant[ií]a|credito|cr[eé]dito/.test(haystack)) return 'contract';
  if (/estado financiero|eeff|balance|resultado|balanza|mayor|situacion financiera|flujo|contable|estados financieros/.test(haystack)) return 'financial_statement';
  if (/acta|asamblea|poder|constitutiva|rfc|opinion cumplimiento|legal|corporativo/.test(haystack)) return 'corporate_document';
  if (/reporte|visita|comite|comit[eé]|memo|presentacion|perfil|cualitativo|management|negocio/.test(haystack)) return 'qualitative_report';
  if (mimeType.includes('spreadsheet') || /\.(xlsx|xls|csv)$/i.test(fileName)) return 'spreadsheet_unknown';
  if (mimeType.includes('pdf')) return 'pdf_unknown';
  return 'unknown';
}

export function inferPeriod(value: string) {
  const text = normalizeToken(value);
  const ymd = text.match(/\b(20\d{2})[-_\s.]?([01]?\d)[-_\s.]?([0-3]?\d)\b/);
  if (ymd) {
    const [, year, month, day] = ymd;
    return {
      period: `${year}-${month.padStart(2, '0')}`,
      periodDate: `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`,
    };
  }
  const ym = text.match(/\b(20\d{2})[-_\s.]?([01]?\d)\b/);
  if (ym) {
    const [, year, month] = ym;
    const m = month.padStart(2, '0');
    return { period: `${year}-${m}`, periodDate: lastDayOfMonth(Number(year), Number(m)) };
  }
  const quarter = text.match(/\b([1-4])\s?t\s?(20\d{2})\b/) || text.match(/\bq([1-4])\s?(20\d{2})\b/);
  if (quarter) {
    const q = Number(quarter[1]);
    const year = Number(quarter[2]);
    const month = q * 3;
    return { period: `${q}T${year}`, periodDate: lastDayOfMonth(year, month) };
  }
  const year = text.match(/\b(20\d{2})\b/);
  if (year) return { period: year[1], periodDate: `${year[1]}-12-31` };
  return { period: '', periodDate: null };
}

function lastDayOfMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

export function matchClientId(path: string, fileName: string, clients: any[]) {
  const haystack = compactKey(`${path} ${fileName}`);
  let best: { id: string; score: number } | null = null;
  for (const client of clients) {
    const names = [client.name, client.tax_id].filter(Boolean).map(compactKey);
    for (const name of names) {
      if (!name || name.length < 4) continue;
      const score = haystack.includes(name) ? name.length : 0;
      if (score && (!best || score > best.score)) best = { id: client.id, score };
    }
  }
  return best?.id || null;
}

export async function downloadDriveFile(file: { id: string; name: string; mimeType?: string }): Promise<DriveDownload> {
  const drive = await getDriveClient();
  const mime = file.mimeType || '';
  const googleDocPrefix = 'application/vnd.google-apps.';

  if (mime === 'application/vnd.google-apps.spreadsheet') {
    const result = await drive.files.export(
      { fileId: file.id, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
      { responseType: 'arraybuffer' },
    );
    return {
      buffer: Buffer.from(result.data as ArrayBuffer),
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      fileName: `${file.name}.xlsx`,
    };
  }

  if (mime === 'application/vnd.google-apps.document') {
    const result = await drive.files.export(
      { fileId: file.id, mimeType: 'text/plain' },
      { responseType: 'arraybuffer' },
    );
    return {
      buffer: Buffer.from(result.data as ArrayBuffer),
      mimeType: 'text/plain',
      fileName: `${file.name}.txt`,
    };
  }

  if (mime.startsWith(googleDocPrefix)) {
    const result = await drive.files.export(
      { fileId: file.id, mimeType: 'application/pdf' },
      { responseType: 'arraybuffer' },
    );
    return {
      buffer: Buffer.from(result.data as ArrayBuffer),
      mimeType: 'application/pdf',
      fileName: `${file.name}.pdf`,
    };
  }

  const result = await drive.files.get({ fileId: file.id, alt: 'media' }, { responseType: 'arraybuffer' });
  return { buffer: Buffer.from(result.data as ArrayBuffer), mimeType: mime, fileName: file.name };
}

export function isExcelLike(fileName: string, mimeType: string) {
  return /\.(xlsx|xls|csv)$/i.test(fileName)
    || mimeType.includes('spreadsheet')
    || mimeType.includes('csv')
    || mimeType.includes('excel');
}

export function isDocAiCandidate(mimeType: string) {
  return mimeType === 'application/pdf'
    || mimeType.startsWith('image/')
    || mimeType === 'image/tiff';
}

export async function createExtractionRun(admin: SupabaseAdmin, documentId: string, processor: string) {
  const rows = await supabaseJson<any[]>(
    admin,
    'document_extraction_runs',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({ document_id: documentId, processor, status: 'running' }),
    },
    [],
  );
  return rows[0];
}

export async function finishExtractionRun(
  admin: SupabaseAdmin,
  runId: string,
  status: string,
  patch: Record<string, any> = {},
) {
  await supabaseFetch(admin, `document_extraction_runs?id=eq.${encodeURIComponent(runId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ ...patch, status, finished_at: new Date().toISOString() }),
  });
}
