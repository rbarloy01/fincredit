/* eslint-disable no-console */
// Scans every client's real financial statements (via the Supabase service
// role, read-only, bypasses RLS) and flags ratios that are implausibly
// negative or out of scale — the same class of bug caught in FRONT CAPITAL,
// SOLVENKA, and LIQUIDEZ CORPORATIVA. Requires SUPABASE_URL and
// SUPABASE_SERVICE_KEY in the environment (they're in .env but not
// auto-loaded — run with `set -a && source .env && set +a && npm run
// audit:calculations`).
import type { FinancialStatement_DB } from '../src/db';
import { getMetric, standardRatios } from '../src/lib/financialMetrics';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY must be set in the environment.');
}

async function fetchAll(table: string, select: string): Promise<any[]> {
  const rows: any[] = [];
  const pageSize = 1000;
  let offset = 0;
  for (;;) {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=${encodeURIComponent(select)}&order=id.asc`, {
      headers: {
        apikey: SERVICE_KEY as string,
        Authorization: `Bearer ${SERVICE_KEY}`,
        Range: `${offset}-${offset + pageSize - 1}`,
        Prefer: 'count=exact',
      },
    });
    if (!response.ok) throw new Error(`${table} fetch failed: ${response.status} ${await response.text()}`);
    const page = await response.json();
    rows.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return rows;
}

function jsonArray(value: any) {
  if (Array.isArray(value)) return value;
  return [];
}

function jsonObject(value: any) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  return {};
}

function toStatement(r: any): FinancialStatement_DB {
  return {
    id: r.id,
    clientId: r.client_id,
    sourceDocumentId: r.source_document_id || undefined,
    sourceCompanyName: r.source_company_name,
    documentType: r.document_type,
    period: r.period,
    periodDate: r.period_date,
    uploadDate: r.upload_date,
    fileName: r.file_name || '',
    rawLineItems: jsonArray(r.raw_line_items),
    mappedData: jsonObject(r.mapped_data) as FinancialStatement_DB['mappedData'],
    extraAccounts: jsonArray(r.extra_accounts),
  };
}

const ABSOLUTE_KEYS = new Set(['revenue', 'ebitda']);
const MARGIN_KEYS = new Set([
  'ifnb_financial_margin', 'ifnb_operating_profitability', 'ifnb_net_margin', 'ifnb_operating_efficiency',
  'past_due_portfolio', 'net_past_due_portfolio', 'funding_cost', 'portfolio_yield',
]);
const NON_NEGATIVE_KEYS = new Set([
  'capitalization', 'adjusted_capitalization', 'current_ratio', 'leverage',
  'past_due_portfolio', 'net_past_due_portfolio', 'past_due_coverage',
  'debt_coverage_productive_assets', 'funding_cost', 'portfolio_yield',
  'immediate_liquidity', 'past_due_to_equity',
]);

const CORE_FIELDS = [
  'revenue', 'ebitda', 'totalDebt', 'equity', 'totalAssets', 'coreBusinessIncome',
  'adjustedFinancialMargin', 'adjustedOperatingIncome', 'adminSellingOperatingExpenses',
  'netIncome', 'interestExpense', 'interestIncome', 'feeIncome',
] as const;

function relevantRawItems(stmt: FinancialStatement_DB) {
  return (stmt.rawLineItems || [])
    .filter(item => /ingres|interes|comision|margen|utilidad|gasto|ebitda|deuda|prestamo|pr[eé]stamo|bancos|fondos|capital|activo|pasivo|venta/i.test(item.name))
    .map(item => ({ name: item.name, value: item.value, type: item.statementType, section: item.sectionPath }));
}

async function main() {
  console.log('Fetching clients and financial statements from Supabase (service role, bypasses RLS)...');
  const [clients, statements] = await Promise.all([
    fetchAll('clients', 'id,name'),
    fetchAll('financial_statements', 'id,client_id,period,period_date,raw_line_items,mapped_data,extra_accounts,file_name'),
  ]);
  console.log(`Loaded ${clients.length} clients, ${statements.length} financial statement rows.\n`);

  const statementsByClient = new Map<string, any[]>();
  for (const row of statements) {
    (statementsByClient.get(row.client_id) || statementsByClient.set(row.client_id, []).get(row.client_id)!).push(row);
  }

  type Finding = {
    client: string;
    clientId: string;
    period: string;
    periodDate: string;
    completeness: number;
    scaleFlags: Array<{ key: string; value: number }>;
    negativeFlags: Array<{ key: string; value: number }>;
    coreFields: Record<string, number | null>;
    rawContext: Array<{ name: string; value: number; type?: string; section?: string | null }>;
  };

  const findings: Finding[] = [];
  const noStatementClients: string[] = [];
  let totalStatementsScanned = 0;

  for (const client of clients) {
    const rows = statementsByClient.get(client.id) || [];
    if (!rows.length) { noStatementClients.push(client.name); continue; }
    const stmts = rows.map(toStatement).sort((a, b) => a.periodDate.localeCompare(b.periodDate));

    for (const stmt of stmts) {
      totalStatementsScanned++;
      const ratios = standardRatios(stmt);
      const nonNull = ratios.filter(r => r.value !== null);
      const completeness = ratios.length ? Math.round((nonNull.length / ratios.length) * 100) : 0;

      const scaleFlags = ratios.filter(r => {
        if (r.value === null || ABSOLUTE_KEYS.has(r.key)) return false;
        const bound = MARGIN_KEYS.has(r.key) ? 3 : 30;
        return Math.abs(r.value) > bound;
      }).map(r => ({ key: r.key, value: Number(r.value!.toFixed(2)) }));

      const negativeFlags = ratios.filter(r => r.value !== null && NON_NEGATIVE_KEYS.has(r.key) && r.value < -0.02)
        .map(r => ({ key: r.key, value: Number(r.value!.toFixed(4)) }));

      if (!scaleFlags.length && !negativeFlags.length) continue;

      const coreFields = Object.fromEntries(CORE_FIELDS.map(f => [f, getMetric(stmt, f)])) as Record<string, number | null>;

      findings.push({
        client: client.name,
        clientId: client.id,
        period: stmt.period,
        periodDate: stmt.periodDate,
        completeness,
        scaleFlags,
        negativeFlags,
        coreFields,
        rawContext: relevantRawItems(stmt),
      });
    }
  }

  console.log(`Scanned ${totalStatementsScanned} statement-periods across ${clients.length - noStatementClients.length} clients with data.`);
  console.log(`${noStatementClients.length} clients have zero statements: ${noStatementClients.join(', ')}\n`);
  console.log(`${findings.length} statement-periods flagged (scale or sign anomaly) across ${new Set(findings.map(f => f.client)).size} distinct clients.\n`);

  console.log(JSON.stringify(findings, null, 1));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
