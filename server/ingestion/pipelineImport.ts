import { createHash } from 'crypto';
import { readJson, sendJson } from '../apiHelpers.js';
import {
  requireIngestionManager,
  supabaseFetch,
  supabaseJson,
  normalizeToken,
} from './shared.js';

const METRIC_MAP: Record<string, string> = {
  ingresos_totales: 'revenue',
  ingresos_intereses: 'revenue',
  ingresos_por_comisiones: 'revenue',
  costo_ventas: 'cogs',
  gastos_operacion: 'operatingExpenses',
  gastos_financieros: 'interestExpense',
  utilidad_operacion: 'ebitda',
  utilidad_neta: 'netIncome',
  total_activo: 'totalAssets',
  total_pasivo: 'totalDebt',
  fondeadores_cp: 'totalDebt',
  fondeadores_lp: 'totalDebt',
  deuda_cp_proxy: 'totalDebt',
  deuda_lp_proxy: 'totalDebt',
  total_capital_contable: 'equity',
  efectivo_inversiones: 'currentAssets',
  cartera_bruta: 'currentAssets',
  cartera_neta_credito: 'currentAssets',
};

function stableHash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function compact(value: string) {
  return normalizeToken(value).replace(/\s+/g, '');
}

function statementType(value: unknown) {
  const text = String(value || '').toUpperCase();
  if (text === 'BG' || /BALANCE|SITUACION/.test(text)) return 'balance_general';
  if (text === 'ER' || /RESULTADO/.test(text)) return 'estado_resultados';
  return 'otro';
}

function numberOrNull(value: unknown) {
  const parsed = Number(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function sourceKey(row: any) {
  return `finmonitor_pipeline:${stableHash({
    client: row.client,
    source: row.source_ref || row.path || row.filename,
    period: row.period,
    statement: row.statement,
    rawLabel: row.raw_label,
    concept: row.concept,
    value: row.value,
  }).slice(0, 40)}`;
}

async function sourceKeyExists(admin: any, orgId: string, key: string) {
  const rows = await supabaseJson<any[]>(
    admin,
    `extraction_review_items?select=id&org_id=eq.${encodeURIComponent(orgId)}&source_key=eq.${encodeURIComponent(key)}&limit=1`,
    {},
    [],
  );
  return Boolean(rows[0]?.id);
}

export async function handlePipelineImport(req: any, res: any) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });

  try {
    const { orgId, supabase } = await requireIngestionManager(req);
    const body = await readJson(req);
    const payload = body.payload || body;
    const dryRun = Boolean(body.dryRun);
    const maxItems = Math.max(1, Math.min(Number(body.maxItems || 1000), 3000));
    const concepts = Array.isArray(payload.concepts) ? payload.concepts : [];
    if (!concepts.length) return sendJson(res, 400, { error: 'payload.concepts is required' });

    const clients = await supabaseJson<any[]>(
      supabase,
      `clients?select=id,name&org_id=eq.${encodeURIComponent(orgId)}`,
      {},
      [],
    );
    const clientsByName = new Map(clients.map(client => [compact(client.name), client.id]));

    const rows = [];
    const skipped: Record<string, number> = {};
    for (const concept of concepts.slice(0, maxItems)) {
      const clientName = String(concept.client || concept.Cliente || '').trim();
      const clientId = clientsByName.get(compact(clientName));
      const value = numberOrNull(concept.value);
      const period = String(concept.period || '').slice(0, 10);
      if (!clientId) {
        skipped.client = (skipped.client || 0) + 1;
        continue;
      }
      if (!period || value === null) {
        skipped.value = (skipped.value || 0) + 1;
        continue;
      }
      const key = sourceKey(concept);
      if (!dryRun && await sourceKeyExists(supabase, orgId, key)) {
        skipped.duplicate = (skipped.duplicate || 0) + 1;
        continue;
      }
      const metric = METRIC_MAP[String(concept.concept || '')] || 'extraAccounts';
      rows.push({
        org_id: orgId,
        client_id: clientId,
        document_id: null,
        item_type: 'financial_line_item',
        source_key: key,
        raw_value: {
          source: 'finmonitor-python-pipeline',
          sourcePath: concept.source_ref || concept.path || '',
          fileName: concept.filename || '',
          rawLabel: concept.raw_label || concept.normalized_label || '',
          rawValue: concept.raw_value || concept.original_value || concept.value,
          concept: concept.concept || '',
          statement: concept.statement || '',
          facilityId: concept.facility_id || '',
          pipelineStatus: concept.status || '',
        },
        suggested_value: {
          metric,
          period,
          periodDate: period,
          value,
          accountName: concept.raw_label || concept.normalized_label || concept.concept || 'Rubro importado',
          statementType: statementType(concept.statement),
          certaintyLevel: concept.mapping_status === 'approved' ? 'high' : 'medium',
          certaintySignals: [
            concept.mapping_status ? `mapping:${concept.mapping_status}` : '',
            concept.source_method ? `method:${concept.source_method}` : '',
          ].filter(Boolean),
          certaintyWarnings: concept.extract_error ? [concept.extract_error] : [],
        },
        confidence_score: numberOrNull(concept.mapping_confidence) ?? 0.55,
        status: 'pending',
      });
    }

    if (!dryRun && rows.length) {
      await supabaseFetch(supabase, 'extraction_review_items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify(rows),
      });
    }

    return sendJson(res, 200, {
      dryRun,
      acceptedForReview: rows.length,
      skipped,
      samples: rows.slice(0, 8).map(row => ({
        clientId: row.client_id,
        period: row.suggested_value.period,
        accountName: row.suggested_value.accountName,
        metric: row.suggested_value.metric,
        value: row.suggested_value.value,
        status: row.status,
      })),
    });
  } catch (error: any) {
    return sendJson(res, error?.status || 500, { error: error?.message || 'Pipeline import error' });
  }
}
