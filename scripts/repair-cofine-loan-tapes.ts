import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import * as XLSX from 'xlsx';
import { importLoanTapeSheets, type SheetInput } from '../src/lib/loanTapeImport';
import { analyzeLoanTapesLocally } from '../src/lib/loanTapeAnalytics';

type LoanTapeRow = {
  id: string;
  client_id: string;
  source_document_id: string | null;
  name: string | null;
  upload_date: string;
  file_name: string;
  tape_type: 'credito' | 'factoraje' | 'otro';
  extracted_data: any;
};

type DocumentRow = {
  id: string;
  file_name: string;
  mime_type: string | null;
  storage_bucket: string | null;
  storage_path: string | null;
};

function loadEnv() {
  const envPath = '.env';
  if (!fs.existsSync(envPath)) return process.env;
  const entries = fs.readFileSync(envPath, 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#') && line.includes('='))
    .map(line => {
      const idx = line.indexOf('=');
      const key = line.slice(0, idx);
      const value = line.slice(idx + 1).replace(/^['"]|['"]$/g, '');
      return [key, value];
    });
  return { ...process.env, ...Object.fromEntries(entries) };
}

function toCamelTape(row: LoanTapeRow, extractedData = row.extracted_data) {
  return {
    id: row.id,
    clientId: row.client_id,
    sourceDocumentId: row.source_document_id || undefined,
    name: row.name || row.file_name,
    uploadDate: row.upload_date,
    fileName: row.file_name,
    tapeType: row.tape_type,
    extractedData,
  };
}

function workbookSheets(buffer: Buffer): SheetInput[] {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  return wb.SheetNames.map(name => ({
    name,
    rows: XLSX.utils.sheet_to_json(wb.Sheets[name], {
      header: 1,
      blankrows: false,
      defval: null,
    }) as any[][],
  }));
}

const env = loadEnv();
const supabaseUrl = env.SUPABASE_URL || env.VITE_SUPABASE_URL;
const serviceKey = env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !serviceKey) {
  throw new Error('Missing SUPABASE_URL/VITE_SUPABASE_URL or SUPABASE_SERVICE_KEY in .env');
}

const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

const { data: tapes, error: tapesError } = await supabase
  .from('loan_tapes')
  .select('id,client_id,source_document_id,name,upload_date,file_name,tape_type,extracted_data')
  .ilike('file_name', '%COFINE%')
  .order('file_name', { ascending: true });

if (tapesError) throw tapesError;

const sourceIds = Array.from(new Set((tapes as LoanTapeRow[])
  .map(tape => tape.source_document_id)
  .filter((id): id is string => Boolean(id))));

const { data: documents, error: docsError } = await supabase
  .from('documents')
  .select('id,file_name,mime_type,storage_bucket,storage_path')
  .in('id', sourceIds);

if (docsError) throw docsError;

const docById = new Map((documents as DocumentRow[]).map(doc => [doc.id, doc]));
const updatedById = new Map<string, any>();
const repaired: string[] = [];
const skipped: string[] = [];

for (const tape of tapes as LoanTapeRow[]) {
  const doc = tape.source_document_id ? docById.get(tape.source_document_id) : null;
  const fileName = tape.file_name || doc?.file_name || '';
  if (!doc || !doc.storage_bucket || !doc.storage_path || !/\.xlsx$/i.test(fileName)) {
    skipped.push(`${fileName || tape.id}: no xlsx source document`);
    continue;
  }

  const beforeRows = Array.isArray(tape.extracted_data?._standardized)
    ? tape.extracted_data._standardized
    : tape.extracted_data?.rows || [];
  const beforeTotal = beforeRows.reduce((sum: number, row: any) => sum + (Number(row?.outstanding_balance) || 0), 0);

  const downloaded = await supabase.storage.from(doc.storage_bucket).download(doc.storage_path);
  if (downloaded.error) throw downloaded.error;
  const buffer = Buffer.from(await downloaded.data.arrayBuffer());
  const result = importLoanTapeSheets(workbookSheets(buffer), fileName);

  if (!result.standardized.length || result.reconciliation.severity === 'blocker') {
    skipped.push(`${fileName}: import ${result.reconciliation.severity}, rows=${result.standardized.length}`);
    continue;
  }

  const nextExtractedData = {
    ...(tape.extracted_data && typeof tape.extracted_data === 'object' ? tape.extracted_data : {}),
    _standardized: result.standardized,
    _mappingReport: result.mappingReport,
    _import: result.reconciliation,
    _summary: result.summary || null,
  };
  delete nextExtractedData._analysis;

  const update = await supabase
    .from('loan_tapes')
    .update({ extracted_data: nextExtractedData })
    .eq('id', tape.id);
  if (update.error) throw update.error;

  updatedById.set(tape.id, nextExtractedData);
  const afterTotal = result.reconciliation.totalBalance;
  repaired.push(`${fileName}: rows ${beforeRows.length}->${result.standardized.length}, total ${Math.round(beforeTotal)}->${Math.round(afterTotal)}`);
}

const affectedClientIds = Array.from(new Set((tapes as LoanTapeRow[])
  .filter(tape => updatedById.has(tape.id))
  .map(tape => tape.client_id)));

for (const clientId of affectedClientIds) {
  const { data: clientTapes, error } = await supabase
    .from('loan_tapes')
    .select('id,client_id,source_document_id,name,upload_date,file_name,tape_type,extracted_data')
    .eq('client_id', clientId);
  if (error) throw error;

  const localTapes = (clientTapes as LoanTapeRow[]).map(row => toCamelTape(row, updatedById.get(row.id)));
  for (const row of clientTapes as LoanTapeRow[]) {
    const extractedData = updatedById.get(row.id) || row.extracted_data || {};
    const analysis = analyzeLoanTapesLocally(localTapes as any, row.id);
    const { error: updateError } = await supabase
      .from('loan_tapes')
      .update({ extracted_data: { ...extractedData, _analysis: analysis } })
      .eq('id', row.id);
    if (updateError) throw updateError;
  }
}

console.log(`Repaired ${repaired.length} COFINE loan tape(s).`);
for (const line of repaired) console.log(`OK ${line}`);
console.log(`Skipped ${skipped.length} file(s).`);
for (const line of skipped) console.log(`SKIP ${line}`);
