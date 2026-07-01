import { createHash } from 'crypto';
import { readJson, sendJson } from '../_helpers.js';
import { requireIngestionManager, supabaseFetch, supabaseJson } from '../ingestion/_shared.js';

export const maxDuration = 60;

const DEFAULT_MAPPED = {
  revenue: 0,
  cogs: 0,
  operatingExpenses: 0,
  ebitda: 0,
  interestExpense: 0,
  netIncome: 0,
  currentAssets: 0,
  currentLiabilities: 0,
  totalDebt: 0,
  totalAssets: 0,
  equity: 0,
};

async function getReviewItem(admin: any, orgId: string, id: string) {
  const rows = await supabaseJson<any[]>(
    admin,
    `extraction_review_items?select=*,documents(file_name)&org_id=eq.${encodeURIComponent(orgId)}&id=eq.${encodeURIComponent(id)}&limit=1`,
    {},
    [],
  );
  return rows[0] || null;
}

async function updateReviewItem(admin: any, id: string, patch: Record<string, any>) {
  await supabaseFetch(admin, `extraction_review_items?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(patch),
  });
}

function stableHash(value: unknown) {
  return createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex');
}

function fallbackSourceKey(item: any) {
  const raw = item.raw_value || {};
  const suggested = item.suggested_value || {};
  return `${item.item_type}:${stableHash({
    documentId: item.document_id,
    itemType: item.item_type,
    accountName: suggested.accountName || raw.accountName || null,
    metric: suggested.metric || null,
    period: suggested.period || null,
    value: suggested.value ?? raw.value ?? null,
    rowNumber: raw.rowNumber || null,
    columnNumber: raw.columnNumber || null,
    pageNumber: raw.pageNumber || null,
    sheetName: raw.sheetName || null,
    excerpt: raw.excerpt || suggested.assessment || null,
  }).slice(0, 32)}`;
}

function itemSourceKey(item: any) {
  return item.source_key || item.raw_value?.sourceKey || fallbackSourceKey(item);
}

function eqOrNull(column: string, value: any) {
  return value === null || value === undefined || value === ''
    ? `${column}=is.null`
    : `${column}=eq.${encodeURIComponent(String(value))}`;
}

async function findOrCreateStatement(admin: any, item: any) {
  const suggested = item.suggested_value || {};
  const fileName = item.documents?.file_name || '';
  const period = suggested.period || 'Sin periodo';
  const periodDate = suggested.periodDate || new Date().toISOString().slice(0, 10);
  const existing = await supabaseJson<any[]>(
    admin,
    [
      'financial_statements?select=*',
      `client_id=eq.${encodeURIComponent(item.client_id)}`,
      `period=eq.${encodeURIComponent(period)}`,
      `file_name=eq.${encodeURIComponent(fileName)}`,
      'limit=1',
    ].join('&'),
    {},
    [],
  );
  if (existing[0]) return existing[0];

  const rows = await supabaseJson<any[]>(
    admin,
    'financial_statements',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({
        client_id: item.client_id,
        document_type: 'financial_statement',
        period,
        period_date: periodDate,
        file_name: fileName,
        raw_line_items: [],
        mapped_data: DEFAULT_MAPPED,
        extra_accounts: [],
      }),
    },
    [],
  );
  return rows[0];
}

async function approveFinancialLineItem(admin: any, item: any) {
  if (!item.client_id) throw new Error('No se puede aprobar un rubro financiero sin client_id.');
  const statement = await findOrCreateStatement(admin, item);
  const raw = item.raw_value || {};
  const suggested = item.suggested_value || {};
  const value = Number(suggested.value ?? raw.value ?? 0) || 0;
  const metric = suggested.metric || 'extraAccounts';
  const accountName = suggested.accountName || raw.accountName || 'Rubro sin nombre';
  const sourceKey = itemSourceKey(item);

  const existingSources = await supabaseJson<any[]>(
    admin,
    [
      'financial_line_item_sources?select=id,source_key',
      `financial_statement_id=eq.${encodeURIComponent(statement.id)}`,
      `document_id=eq.${encodeURIComponent(item.document_id)}`,
      eqOrNull('document_table_id', raw.documentTableId || null),
      eqOrNull('page_number', raw.pageNumber || null),
      eqOrNull('sheet_name', raw.sheetName || null),
      eqOrNull('row_number', raw.rowNumber || null),
      `account_name=eq.${encodeURIComponent(accountName)}`,
      `value=eq.${encodeURIComponent(String(value))}`,
      'limit=1',
    ].join('&'),
    {},
    [],
  );
  if (existingSources[0]) {
    if (!existingSources[0].source_key) {
      await supabaseFetch(admin, `financial_line_item_sources?id=eq.${encodeURIComponent(existingSources[0].id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ source_key: sourceKey }),
      });
    }
    return { financialStatementId: statement.id, metric, value, duplicate: true };
  }

  const sourceRows = await supabaseJson<any[]>(
    admin,
    'financial_line_item_sources?on_conflict=financial_statement_id,source_key',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=representation' },
      body: JSON.stringify({
        financial_statement_id: statement.id,
        document_id: item.document_id,
        document_table_id: raw.documentTableId || null,
        page_number: raw.pageNumber || null,
        sheet_name: raw.sheetName || null,
        row_number: raw.rowNumber || null,
        source_key: sourceKey,
        account_name: accountName,
        value,
        source_excerpt: `${accountName}: ${value}`,
      }),
    },
    [],
  );
  if (!sourceRows.length) return { financialStatementId: statement.id, metric, value, duplicate: true };

  const rawLineItems = [...(statement.raw_line_items || []), {
    name: accountName,
    value,
    sourceKey,
    source: statement.file_name || '',
    sectionPath: raw.sheetName || raw.pageNumber ? [raw.sheetName, raw.pageNumber ? `Página ${raw.pageNumber}` : ''].filter(Boolean).join(' / ') : null,
    statementType: 'otro',
  }];
  const mappedData = { ...DEFAULT_MAPPED, ...(statement.mapped_data || {}) };
  const extraAccounts = [...(statement.extra_accounts || [])];

  if (metric === 'extraAccounts') {
    extraAccounts.push({
      key: accountName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''),
      label: accountName,
      value,
      sourceKey,
    });
  } else {
    mappedData[metric] = Number(mappedData[metric] || 0) + value;
  }

  await supabaseFetch(admin, `financial_statements?id=eq.${encodeURIComponent(statement.id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ raw_line_items: rawLineItems, mapped_data: mappedData, extra_accounts: extraAccounts }),
  });

  return { financialStatementId: statement.id, metric, value };
}

async function approveQualitativeItem(admin: any, item: any) {
  if (!item.client_id) throw new Error('No se puede aprobar un factor cualitativo sin client_id.');
  const suggested = item.suggested_value || {};
  const sourceKey = itemSourceKey(item);
  const category = suggested.category || 'General';
  const factor = suggested.factor || 'Factor cualitativo';
  const assessment = suggested.assessment || item.raw_value?.excerpt || '';
  const existing = await supabaseJson<any[]>(
    admin,
    [
      'qualitative_factors?select=id,source_key',
      `client_id=eq.${encodeURIComponent(item.client_id)}`,
      `document_id=eq.${encodeURIComponent(item.document_id)}`,
      `category=eq.${encodeURIComponent(category)}`,
      `factor=eq.${encodeURIComponent(factor)}`,
      `assessment=eq.${encodeURIComponent(assessment)}`,
      'limit=1',
    ].join('&'),
    {},
    [],
  );
  if (existing[0]) {
    if (!existing[0].source_key) {
      await supabaseFetch(admin, `qualitative_factors?id=eq.${encodeURIComponent(existing[0].id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ source_key: sourceKey, updated_at: new Date().toISOString() }),
      });
    }
    return { qualitativeFactorId: existing[0].id, duplicate: true };
  }
  const rows = await supabaseJson<any[]>(
    admin,
    'qualitative_factors?on_conflict=client_id,document_id,source_key',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=representation' },
      body: JSON.stringify({
        client_id: item.client_id,
        document_id: item.document_id,
        source_key: sourceKey,
        category,
        factor,
        assessment,
        risk_level: suggested.riskLevel || 'unknown',
        status: 'approved',
      }),
    },
    [],
  );
  return { qualitativeFactorId: rows[0]?.id || null, duplicate: !rows.length };
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });

  try {
    const { orgId, user, supabase } = await requireIngestionManager(req);
    const body = await readJson(req);
    const ids = Array.isArray(body.reviewItemIds) ? body.reviewItemIds : [body.reviewItemId].filter(Boolean);
    const action = body.action === 'reject' ? 'reject' : 'approve';
    if (!ids.length) return sendJson(res, 400, { error: 'reviewItemId or reviewItemIds required' });

    const results = [];
    for (const id of ids.slice(0, 100)) {
      const item = await getReviewItem(supabase, orgId, id);
      if (!item) throw new Error(`Review item not found: ${id}`);
      if (action === 'reject') {
        await updateReviewItem(supabase, item.id, {
          status: 'rejected',
          reviewed_by: user.id,
          reviewed_at: new Date().toISOString(),
        });
        results.push({ reviewItemId: id, rejected: true });
        continue;
      }

      let result: any = { skipped: true };
      if (item.status === 'approved') {
        results.push({ reviewItemId: id, skipped: true, duplicate: true });
        continue;
      } else if (item.item_type === 'financial_line_item') {
        result = await approveFinancialLineItem(supabase, item);
      } else if (item.item_type === 'qualitative_excerpt') {
        result = await approveQualitativeItem(supabase, item);
      }
      await updateReviewItem(supabase, item.id, {
        source_key: itemSourceKey(item),
        status: 'approved',
        reviewed_by: user.id,
        reviewed_at: new Date().toISOString(),
      });
      results.push({ reviewItemId: id, ...result });
    }

    sendJson(res, 200, action === 'reject'
      ? { rejected: results.length, results }
      : { approved: results.length, results });
  } catch (error: any) {
    sendJson(res, error?.status || 500, { error: error?.message || 'Review approval error' });
  }
}
