/* eslint-disable no-console */
// Read-only audit (Supabase service role, bypasses RLS) that quantifies the
// systemic EBITDA-gap bug plus balance-sheet imbalance and missing core
// fields, across every client's real financial statements.
//
// The gap: mappedData.ebitda is stored as 0 for IFNBs (the ingestion prompt
// computes EBITDA = revenue - cogs - operatingExpenses, none of which the
// bank-style P&L populates), even though raw_line_items carries an explicit
// "Utilidad/Resultado de Operación" line. getMetric('ebitda') then short-
// circuits on that literal 0 (firstValue treats 0 as present), so Deuda/EBITDA
// and DSCR break everywhere.
//
// Run:
//   set -a && source .env && set +a && npm run audit:ebitda
//
// Requires SUPABASE_URL and SUPABASE_SERVICE_KEY in the environment.
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FinancialStatement_DB } from '../src/db';
import { getMetric } from '../src/lib/financialMetrics';

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

function jsonArray(value: any) { return Array.isArray(value) ? value : []; }
function jsonObject(value: any) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }

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

// Strip accents + lowercase, matching the regex in the task spec.
function norm(s: string): string {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

const OPERATING_RE = /utilidad (de )?operaci|resultado (de )?operaci|utilidad operativa|operating (profit|income)/;

// Direct raw lookup for TOTAL liabilities — deliberately NOT using
// getMetric('totalLiabilities'), whose last fallback is totalDebt (only the
// interest-bearing portion), which would fabricate imbalances. Requires an
// explicit "total/suma de pasivo" line.
const TOTAL_LIAB_RE = /^(total,? de pasivo|total,? pasivo|pasivo total|suma del pasivo|total del pasivo)/;
const EQUITY_RE = /(capital contable|patrimonio|suma del capital|total,? capital contable)/;
const TOTAL_ASSETS_RE = /^(total,? activo|total del activo|activos totales|suma del activo)/;
// A "SUMA/TOTAL DEL PASIVO Y (DEL) CAPITAL" line equals total assets, not
// liabilities — any line mentioning BOTH pasivo and capital is that combined
// total and must never be picked as liabilities or equity.
function isCombinedTotal(n: string): boolean {
  return n.includes('pasivo') && (n.includes('capital') || n.includes('patrimonio'));
}

function findRawByRe(stmt: FinancialStatement_DB, re: RegExp, excludeNear: number | null = null): number | null {
  const items = (stmt.rawLineItems || []).filter(i => {
    if (typeof i?.value !== 'number') return false;
    if ((i.statementType || 'otro') === 'estado_resultados') return false;
    const n = norm(i.name);
    if (isCombinedTotal(n)) return false;
    // The "pasivo + capital" combined total always equals total assets, but
    // its label varies wildly ("+ CC", "+ Capital Contable", "y del capital").
    // Drop any candidate whose value matches total assets — that's the combined
    // line, never true liabilities.
    if (excludeNear && excludeNear !== 0 && Math.abs(i.value - excludeNear) / Math.abs(excludeNear) < 0.005) return false;
    return re.test(n);
  });
  if (!items.length) return null;
  // Prefer the largest-magnitude match (the grand total, not a subtotal).
  items.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  return items[0].value;
}

// Find an operating-profit line in the raw items (prefer estado_resultados,
// but accept any statementType since ingestion sometimes leaves it 'otro').
function findRawOperating(stmt: FinancialStatement_DB): { name: string; value: number } | null {
  const items = (stmt.rawLineItems || []).filter(i => typeof i?.value === 'number' && OPERATING_RE.test(norm(i.name)));
  if (!items.length) return null;
  // Prefer estado_resultados lines, then the one with the largest |value|
  // (the operating-profit total, not a sub-component).
  const er = items.filter(i => (i.statementType || 'otro') === 'estado_resultados');
  const pool = er.length ? er : items;
  pool.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  return { name: pool[0].name, value: pool[0].value };
}

function isEmpty(v: number | null | undefined): boolean {
  return v === null || v === undefined || v === 0;
}

function firstValueNum(...values: Array<number | null>): number | null {
  const found = values.find(v => v !== null && v !== undefined);
  return found ?? null;
}

// Does raw_line_items clearly contain a value for this concept? (uses getMetric
// which includes the raw fallback chain).
function rawHasValue(stmt: FinancialStatement_DB, key: string): number | null {
  const v = getMetric(stmt, key);
  return v !== null && v !== 0 ? v : null;
}

type EbitdaGapRow = {
  client: string;
  clientId: string;
  period: string;
  periodDate: string;
  mappedEbitda: number | null;
  rawOperatingProfitFound: number;
  rawOperatingLine: string;
};

type BalanceRow = {
  client: string; clientId: string; period: string; periodDate: string;
  totalAssets: number | null; totalLiabilities: number | null; equity: number | null;
  liabPlusEquity: number | null; relDiff: number; status: 'descuadre' | 'incompleto';
};

type CoreMissingRow = {
  client: string; clientId: string; period: string; periodDate: string;
  field: string; mappedValue: number | null; rawValueFound: number;
};

async function main() {
  console.log('Fetching clients and financial statements (service role, read-only)...');
  const [clients, statements] = await Promise.all([
    fetchAll('clients', 'id,name'),
    fetchAll('financial_statements', 'id,client_id,source_company_name,document_type,period,period_date,raw_line_items,mapped_data,extra_accounts,file_name'),
  ]);
  console.log(`Loaded ${clients.length} clients, ${statements.length} financial statement rows.\n`);

  const byClient = new Map<string, any[]>();
  for (const row of statements) {
    if (!byClient.has(row.client_id)) byClient.set(row.client_id, []);
    byClient.get(row.client_id)!.push(row);
  }

  const ebitdaGap: EbitdaGapRow[] = [];
  const balanceIssues: BalanceRow[] = [];
  const coreMissing: CoreMissingRow[] = [];
  const noStatementClients: string[] = [];

  let totalPeriods = 0;
  const clientsWithGap = new Set<string>();
  const clientsWithBalance = new Set<string>();
  const clientsWithCore = new Set<string>();
  // How many affected periods have a non-zero operating profit that COULD have
  // populated ebitda but didn't.
  let periodsEbitdaZeroWithRawOp = 0;

  const CORE = ['revenue', 'totalAssets', 'equity', 'totalDebt'] as const;

  for (const client of clients) {
    const rows = byClient.get(client.id) || [];
    if (!rows.length) { noStatementClients.push(client.name); continue; }
    const stmts = rows.map(toStatement).sort((a, b) => (a.periodDate || '').localeCompare(b.periodDate || ''));

    for (const stmt of stmts) {
      totalPeriods++;
      const m = jsonObject((stmt as any).mappedData);
      const mappedEbitda = (typeof m.ebitda === 'number' ? m.ebitda : null);

      // 1. EBITDA gap
      if (isEmpty(mappedEbitda)) {
        const rawOp = findRawOperating(stmt);
        if (rawOp && rawOp.value !== 0) {
          periodsEbitdaZeroWithRawOp++;
          clientsWithGap.add(client.name);
          ebitdaGap.push({
            client: client.name,
            clientId: client.id,
            period: stmt.period,
            periodDate: stmt.periodDate,
            mappedEbitda,
            rawOperatingProfitFound: rawOp.value,
            rawOperatingLine: rawOp.name,
          });
        }
      }

      // 2. Balance sheet check. totalAssets from mapped (fallback raw);
      // liabilities/equity from explicit raw totals only (no totalDebt fallback).
      const totalAssets = firstValueNum(typeof m.totalAssets === 'number' && m.totalAssets !== 0 ? m.totalAssets : null, findRawByRe(stmt, TOTAL_ASSETS_RE));
      const totalLiabilities = findRawByRe(stmt, TOTAL_LIAB_RE, totalAssets);
      const equity = firstValueNum(typeof m.equity === 'number' && m.equity !== 0 ? m.equity : null, findRawByRe(stmt, EQUITY_RE, totalAssets));
      if (totalAssets === null || totalAssets === 0 || totalLiabilities === null || equity === null) {
        // Anchor on assets: only "incompleto" when assets exist but a
        // liabilities/equity total is missing.
        if (totalAssets && totalAssets !== 0 && (totalLiabilities === null || equity === null)) {
          balanceIssues.push({
            client: client.name, clientId: client.id, period: stmt.period, periodDate: stmt.periodDate,
            totalAssets, totalLiabilities, equity, liabPlusEquity: null, relDiff: 0, status: 'incompleto',
          });
          clientsWithBalance.add(client.name);
        }
      } else {
        const liabPlusEquity = totalLiabilities + equity;
        const relDiff = Math.abs(totalAssets - liabPlusEquity) / Math.abs(totalAssets);
        if (relDiff > 0.01) {
          balanceIssues.push({
            client: client.name, clientId: client.id, period: stmt.period, periodDate: stmt.periodDate,
            totalAssets, totalLiabilities, equity, liabPlusEquity,
            relDiff: Number(relDiff.toFixed(4)), status: 'descuadre',
          });
          clientsWithBalance.add(client.name);
        }
      }

      // 3. Core fields missing in mapped but present in raw
      for (const field of CORE) {
        const mappedVal = (typeof m[field] === 'number' ? m[field] : null);
        if (isEmpty(mappedVal)) {
          const rawVal = rawHasValue(stmt, field);
          if (rawVal !== null) {
            coreMissing.push({
              client: client.name, clientId: client.id, period: stmt.period, periodDate: stmt.periodDate,
              field, mappedValue: mappedVal, rawValueFound: rawVal,
            });
            clientsWithCore.add(client.name);
          }
        }
      }
    }
  }

  const outDir = resolve(process.cwd(), 'audit-report');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, 'ebitda-gap.json'), JSON.stringify(ebitdaGap, null, 2));

  const summary = {
    totals: {
      clients: clients.length,
      clientsWithStatements: clients.length - noStatementClients.length,
      clientsWithoutStatements: noStatementClients.length,
      statementPeriods: totalPeriods,
    },
    ebitdaGap: {
      affectedPeriods: ebitdaGap.length,
      affectedClients: clientsWithGap.size,
      periodsEbitdaZeroWithRawOp,
    },
    balance: {
      affectedPeriods: balanceIssues.length,
      affectedClients: clientsWithBalance.size,
      descuadre: balanceIssues.filter(b => b.status === 'descuadre').length,
      incompleto: balanceIssues.filter(b => b.status === 'incompleto').length,
    },
    coreMissing: {
      affectedPeriods: coreMissing.length,
      affectedClients: clientsWithCore.size,
      byField: Object.fromEntries(CORE.map(f => [f, coreMissing.filter(c => c.field === f).length])),
    },
    noStatementClients,
    balanceIssues,
    coreMissingRows: coreMissing,
    balanceClients: [...clientsWithBalance].sort(),
    ebitdaGapClients: [...clientsWithGap].sort(),
  };

  writeFileSync(resolve(outDir, '_audit-data.json'), JSON.stringify(summary, null, 2));

  console.log('=== SUMMARY ===');
  console.log(JSON.stringify(summary.totals, null, 1));
  console.log('EBITDA gap:', JSON.stringify(summary.ebitdaGap));
  console.log('Balance:', JSON.stringify(summary.balance));
  console.log('Core missing:', JSON.stringify(summary.coreMissing));
  console.log('No-statement clients:', noStatementClients.length);
  console.log('\nWrote audit-report/ebitda-gap.json and audit-report/_audit-data.json');
}

main().catch(err => { console.error(err); process.exit(1); });
