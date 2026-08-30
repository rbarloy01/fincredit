import fs from 'node:fs';

function loadDotEnv(path = '.env') {
  if (!fs.existsSync(path)) return;
  const lines = fs.readFileSync(path, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    const value = match[2].replace(/^['"]|['"]$/g, '');
    process.env[match[1]] = value;
  }
}

loadDotEnv();

const requiredTables = [
  'profiles',
  'organizations',
  'clients',
  'institutional_liabilities',
  'company_default_assessments',
  'documents',
  'document_extraction_runs',
  'document_pages',
  'document_tables',
  'extraction_review_items',
  'financial_line_item_sources',
  'crm_contacts',
  'crm_activities',
];

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_KEY;
const anonKey = process.env.VITE_SUPABASE_ANON_KEY;

if (!url || !serviceKey || !anonKey) {
  console.error('Missing SUPABASE_URL/VITE_SUPABASE_URL, SUPABASE_SERVICE_KEY, or VITE_SUPABASE_ANON_KEY.');
  process.exit(1);
}

async function tableStatus(table, key, bearer = key) {
  const response = await fetch(`${url}/rest/v1/${table}?select=*&limit=1`, {
    headers: { apikey: key, Authorization: `Bearer ${bearer}` },
  });
  const text = await response.text();
  return { table, status: response.status, ok: response.ok, body: text.slice(0, 160).replace(/\s+/g, ' ') };
}

const serviceResults = [];
for (const table of requiredTables) {
  serviceResults.push(await tableStatus(table, serviceKey));
}

const anonProbeTables = ['clients', 'profiles', 'documents', 'financial_statements', 'loan_tapes'];
const anonResults = [];
for (const table of anonProbeTables) {
  anonResults.push(await tableStatus(table, anonKey, anonKey));
}

console.log(JSON.stringify({
  serviceKeySchemaOk: serviceResults.every(item => item.ok),
  serviceResults,
  anonRlsSmoke: anonResults,
}, null, 2));

if (!serviceResults.every(item => item.ok)) process.exit(1);
