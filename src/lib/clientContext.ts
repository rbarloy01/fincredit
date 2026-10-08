// "Client profile" for the AI assistant: a compact, token-bounded, plain-text pack of everything the app knows about a
// client (financial statements, automatic ratios, indicators, contracts, loan tape analytics and the business rules used to
// compute them). The model is told to answer ONLY from this pack, so every number it quotes is traceable to the screens.
//
// Design notes
//  - Pre-computed aggregates beat raw rows: the model reads totals, ratios, concentrations and migration that the app already
//    validated, instead of re-deriving them from thousands of loan rows.
//  - Loan-level questions are covered with a short list (largest loans + delinquent loans); anything deeper is out of scope
//    and the assistant must say what is missing.
//  - The pack states its own limits (periods included, what was truncated, which statements are in review/quarantine).

import type { Client, Covenant_DB, FinancialStatement_DB, LoanTape_DB, Transaction } from '../db/index';
import { evaluateCovenantAuto, formulaLabel, resolveCovenantThreshold, standardRatios } from './financialMetrics';
import { isClientMonitored, MONITORING_PAUSED_TEXT } from './clientStatus';
import { QUALITY_DEFINITION_LINES, QUALITY_RULES } from './portfolioRules';
import { QUALITY_LABEL, type StatementQuality, type StatementQualityRecord } from './statementQuality';
import { buildCockpitData, buildVintage } from './loanTapeCockpit';
import { analyzePortfolio, buildLoanTapeInsights } from './loanTapeReport';
import { activeRows } from './loanTapeAnalytics';
import type { GroupOverrides } from './economicGroups';

export interface ClientContextInput {
  client: Client;
  statements: FinancialStatement_DB[];            // usable statements (quarantine already applied)
  allStatementsCount: number;
  qualityRecords?: Record<string, StatementQualityRecord | undefined>;
  qualityByStatement?: Record<string, StatementQuality | undefined>;
  covenants: Covenant_DB[];
  transactions: Transaction[];
  loanTapes: LoanTape_DB[];
  groupOverrides?: GroupOverrides;
}

export interface ClientContextPack { text: string; approxTokens: number; sections: Array<{ title: string; chars: number }>; notes: string[] }

const m0 = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? 'N/D' : `$${Math.round(v).toLocaleString('es-MX')}`);
const mM = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? 'N/D' : `$${(v / 1e6).toLocaleString('es-MX', { maximumFractionDigits: 1 })}M`);
const p1 = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? 'N/D' : `${(v * 100).toFixed(1)}%`);

const RATIO_KEYS = ['revenue', 'ebitda', 'ifnb_financial_margin', 'ifnb_net_margin', 'ifnb_operating_efficiency', 'debt_ebitda', 'dscr', 'current_ratio', 'leverage', 'debt_equity', 'capitalization', 'adjusted_capitalization', 'roa', 'roe', 'past_due_portfolio', 'past_due_coverage', 'portfolio_yield', 'funding_cost', 'immediate_liquidity'];
const PCT_RATIOS = new Set(['ifnb_financial_margin', 'ifnb_net_margin', 'ifnb_operating_efficiency', 'leverage', 'capitalization', 'roa', 'roe', 'past_due_portfolio', 'portfolio_yield', 'funding_cost']);

export function buildClientContext(input: ClientContextInput): ClientContextPack {
  const { client, covenants, transactions, loanTapes } = input;
  const monitored = isClientMonitored(client);
  const sections: Array<{ title: string; body: string }> = [];
  const notes: string[] = [];
  const add = (title: string, lines: string[]) => sections.push({ title, body: lines.filter(Boolean).join('\n') });

  add('PERFIL', [
    `Cliente: ${client.name}${client.taxId ? ` · RFC ${client.taxId}` : ''}`,
    `Industria: ${client.industry || 'N/D'} · Estatus: ${client.status || 'activo'} · Frecuencia de reporte: ${client.frequency || 'N/D'} · Moneda: ${client.currency || 'MXN'}`,
    `Línea total: ${m0(client.totalCreditValue)} · Saldo vigente registrado: ${m0(client.currentDue)} · Analista: ${client.analystName || 'N/D'} · Contrato: ${client.contractName || 'N/D'}`,
    !monitored ? `AVISO: ${MONITORING_PAUSED_TEXT}` : '',
  ]);

  // ── Estados financieros ──────────────────────────────────────────────────────
  const stmts = [...input.statements].sort((a, b) => a.periodDate.localeCompare(b.periodDate));
  const recent = stmts.slice(-4);
  const fsLines: string[] = [];
  if (!stmts.length) fsLines.push('Sin estados financieros cargados.');
  else {
    fsLines.push(`Periodos disponibles (${stmts.length}${input.allStatementsCount > stmts.length ? `; ${input.allStatementsCount - stmts.length} más están EN REVISIÓN y se excluyen` : ''}): ${stmts.map(s => s.period).join(' | ')}`);
    fsLines.push('Convención: los resultados de periodos intermedios suelen ser ACUMULADOS enero→mes; los ratios de rentabilidad se anualizan (12 / meses) y la nota lo indica.');
    for (const s of recent) {
      const q = input.qualityByStatement?.[s.id]; const rec = input.qualityRecords?.[s.id];
      fsLines.push('', `── ${s.period} (${s.periodDate})${q ? ` · ${QUALITY_LABEL[q.level]} ${q.score}/100` : ''}${rec?.status === 'aprobado' ? ' · aprobado manualmente' : ''}`);
      const ratios = standardRatios(s, stmts).filter(r => RATIO_KEYS.includes(r.key));
      fsLines.push(ratios.map(r => `${r.label}: ${r.value === null ? 'N/D' : PCT_RATIOS.has(r.key) ? p1(r.value) : r.key === 'revenue' || r.key === 'ebitda' ? m0(r.value) : `${r.value.toFixed(2)}x`}`).join(' · '));
      const annual = standardRatios(s, stmts).find(r => r.formula.includes('anualizado'));
      if (annual) fsLines.push(`(${annual.formula.split('·').pop()?.trim()})`);
      if (q) q.checks.filter(c => c.severity === 'warn' || c.severity === 'block').forEach(c => fsLines.push(`⚠ ${c.label}: ${c.detail}`));
    }
    const last = recent[recent.length - 1];
    const top = [...last.rawLineItems].filter(i => typeof i.value === 'number' && Math.abs(i.value as number) >= 1).sort((a, b) => Math.abs(b.value as number) - Math.abs(a.value as number)).slice(0, 45);
    fsLines.push('', `Cuentas principales de ${last.period} (hasta 45 por monto):`);
    top.forEach(i => fsLines.push(`- [${(i.statementType || 'otro').replace('balance_general', 'BG').replace('estado_resultados', 'ER').replace('flujo_efectivo', 'FE')}] ${i.name}: ${m0(i.value as number)}`));
    if (last.rawLineItems.length > top.length) notes.push(`Estados financieros: del último periodo se incluyen ${top.length} de ${last.rawLineItems.length} cuentas.`);
  }
  add('ESTADOS FINANCIEROS E INDICADORES AUTOMÁTICOS', fsLines);

  // ── Indicadores / covenants ──────────────────────────────────────────────────
  const fin = covenants.filter(c => c.type === 'financial');
  const covLines = fin.map(c => {
    const r = stmts.length ? evaluateCovenantAuto(c, stmts) : { value: null, status: 'cumple' as const };
    const th = resolveCovenantThreshold(c);
    return `- ${c.name} (${formulaLabel(c.formula || '')}): umbral ${c.operator === 'none' || th === null ? 'sin umbral' : `${c.operator} ${c.threshold}`}${monitored && r.value !== null ? ` · último valor ${r.value.toFixed(4)} · ${r.status}` : monitored ? '' : ' · sin monitoreo'}`;
  });
  add('INDICADORES FINANCIEROS (covenants financieros del contrato y estándar)', covLines.length ? covLines.slice(0, 30) : ['Sin indicadores configurados.']);

  // ── Contratos ────────────────────────────────────────────────────────────────
  add('CONTRATOS / FACILITIES', transactions.length ? transactions.slice(0, 12).map(t => `- ${t.name}: ${m0(t.originalAmount)} ${t.currency} · tipo ${t.creditType || 'N/D'} · firma ${t.signedAt || 'N/D'} · vencimiento ${t.maturityAt || 'N/D'}`) : ['Sin contratos registrados.']);

  // ── Loan tape ────────────────────────────────────────────────────────────────
  const tapeLines: string[] = [];
  const rowsExist = loanTapes.some(t => Array.isArray(t.extractedData?._standardized) && t.extractedData._standardized.length > 0);
  if (!loanTapes.length) tapeLines.push('Sin loan tapes cargados.');
  else if (!rowsExist) tapeLines.push('Hay archivos de loan tape pero sin filas analíticas (resumen o archivo sin leer).');
  else {
    const data = buildCockpitData(loanTapes);
    const focus = data.periods[data.periods.length - 1];
    const a = analyzePortfolio(data, focus, input.groupOverrides || {});
    if (a) {
      const k = a.kpi;
      tapeLines.push(`Cortes disponibles: ${data.labels.join(', ')}. Se describe el último: ${a.focusLabel}.`);
      tapeLines.push('Reglas de clasificación (únicas en todo el sistema):', ...QUALITY_DEFINITION_LINES.map(l => `  · ${l}`));
      tapeLines.push(`Saldo ${m0(k.saldo)} en ${k.creditos} créditos y ${k.clientes} clientes · monto original ${m0(k.montoOriginal)} (${p1(k.amortizadoPct)} amortizado) · ticket promedio ${m0(k.avgTicket)} · crédito mayor ${m0(k.maxLoan)} (${p1(k.maxLoanPct)}).`);
      tapeLines.push(`Tasa ponderada ${p1(k.waRate)} (simple ${p1(k.simpleRate)}, mediana ${p1(k.medianRate)}) · plazo ponderado ${k.waTermMonths === null ? 'N/D' : k.waTermMonths.toFixed(1) + ' m'} · plazo remanente ${k.waRemainingMonths === null ? 'N/D' : k.waRemainingMonths.toFixed(1) + ' m'} · DPD ponderado ${k.waDpd === null ? 'N/D' : k.waDpd.toFixed(1)} días.`);
      tapeLines.push(`Calidad: ${a.quality.map(q => `${q.label} ${p1(q.pct)} (${q.count} cr., ${mM(q.balance)})`).join(' · ')}.`);
      tapeLines.push(`Buckets DPD: ${a.dpd.map(d => `${d.bucket} ${p1(d.pct)}`).join(' · ')}.`);
      tapeLines.push(`Concentración clientes (Top ${a.clients.length ? Math.min(10, a.clients.length) : 0}): ${a.clients.slice(0, 10).map(c => `${c.name} ${p1(c.pct)}`).join('; ')}. HHI ${a.hhi.toFixed(3)}. ${a.topN.map(t => `${t.label} ${p1(t.pct)}`).join(' · ')}.`);
      const multi = a.groups.filter(g => g.inferred);
      tapeLines.push(multi.length ? `Grupos económicos (inferidos por nombre): ${multi.slice(0, 6).map(g => `${g.name} [${g.members.map(m => m.name).join(' + ')}] ${p1(g.pct)}`).join('; ')}.` : 'Grupos económicos: no se detectaron acreditados relacionados por nombre.');
      if (a.products.length) tapeLines.push(`Productos: ${a.products.slice(0, 8).map(p => `${p.name} ${p1(p.pct)} (tasa pond. ${p1(p.waRate)}, vencida ${p1(p.venPct)})`).join('; ')}.`);
      if (a.industries.length) tapeLines.push(`Giros: ${a.industries.slice(0, 6).map(p => `${p.name} ${p1(p.pct)}`).join('; ')}.`);
      if (a.states.length) tapeLines.push(`Estados: ${a.states.slice(0, 6).map(p => `${p.name} ${p1(p.pct)}`).join('; ')}.`);
      if (a.rateBuckets.length) tapeLines.push(`Rangos de tasa: ${a.rateBuckets.map(b => `${b.label} ${p1(b.pct)}`).join('; ')}.`);
      if (a.maturity.length) tapeLines.push(`Vencimientos por trimestre: ${a.maturity.slice(0, 10).map(m => `${m.quarter} ${p1(m.pct)}`).join('; ')}.`);
      if (data.series.length > 1) tapeLines.push(`Evolución: ${data.series.slice(-6).map(s => `${s.label}: saldo ${mM(s.saldo)}, vencida ${p1(s.venPct)}, tasa ${p1(s.wa_rate)}`).join(' | ')}.`);
      if (a.migration) { const sm = a.migration.summary; tapeLines.push(`Migración ${a.migration.fromLabel}→${a.migration.toLabel}: igual ${p1(sm.stablePct)}, empeoró ${p1(sm.worsePct)}, mejoró ${p1(sm.betterPct)}; roll-in ${p1(sm.performingToDelinquentPct)}; cura ${p1(sm.delinquentCurePct)}; salió ${mM(sm.exitBalance)}; nuevo ${mM(sm.newBalance)}.`); }
      const vint = buildVintage(data, focus);
      if (vint.length) tapeLines.push(`Cosechas: ${vint.map(v => `${v.cohort}: ${mM(v.saldo)}, vencida ${p1(v.venPct)}`).join('; ')}.`);
      tapeLines.push('', 'Insights automáticos del corte:', ...buildLoanTapeInsights(a, data).map(i => `- [${i.level}] ${i.category}: ${i.text}`));
      const loans = activeRows(a.rows);
      const largest = [...loans].sort((x, y) => (y.outstanding_balance || 0) - (x.outstanding_balance || 0)).slice(0, 20);
      const delinquent = loans.filter(l => (l.days_overdue || 0) > QUALITY_RULES.vigenteMaxDpd).sort((x, y) => (y.outstanding_balance || 0) - (x.outstanding_balance || 0)).slice(0, 25);
      const fmtLoan = (l: typeof loans[number]) => `${l.loan_id} | ${l.client} | saldo ${m0(l.outstanding_balance)} | DPD ${l.days_overdue ?? 'N/D'} | tasa ${p1(l.interest_rate)} | ${l.loan_type || 'N/D'}`;
      tapeLines.push('', 'Créditos más grandes (20):', ...largest.map(fmtLoan));
      if (delinquent.length) tapeLines.push('', `Créditos con atraso >${QUALITY_RULES.vigenteMaxDpd} días (hasta 25):`, ...delinquent.map(fmtLoan));
      if (loans.length > largest.length) notes.push(`Loan tape: solo se incluyen los 20 créditos más grandes y hasta 25 con atraso; el resto está agregado.`);
      const cov = a.coverage.filter(c => c.pct < 0.95);
      if (cov.length) tapeLines.push('', `Campos incompletos en el tape: ${cov.map(c => `${c.field} ${Math.round(c.pct * 100)}%`).join(', ')}.`);
    }
  }
  add('LOAN TAPE', tapeLines);

  const text = sections.map(s => `### ${s.title}\n${s.body}`).join('\n\n');
  return {
    text,
    approxTokens: Math.ceil(text.length / 3.6),
    sections: sections.map(s => ({ title: s.title, chars: s.body.length })),
    notes,
  };
}

export const ASSISTANT_SYSTEM_PROMPT = `Eres un analista de crédito senior de una institución financiera mexicana (Syscap / Axcess).
Respondes preguntas sobre UN cliente usando EXCLUSIVAMENTE el bloque "CONTEXTO DEL CLIENTE" que te doy.
Reglas:
1. Cita siempre el periodo o corte y la cifra de la que sales (ej. "abr-26: ROA 19.0% anualizado").
2. Si el dato no está en el contexto, di exactamente qué falta y no lo inventes ni lo estimes sin decirlo.
3. Usa las definiciones del contexto (vigente 0-30 DPD, atrasada 31-89, vencida 90 o más; "al corriente" = 0 días es solo un bucket dentro de vigente).
4. Distingue siempre acreditados (clientes del cliente) de créditos, y Top-N de clientes de Top-N de créditos.
5. Señala supuestos y limitaciones (periodos acumulados y anualizados, estados en revisión, tape sin DPD o sin fecha de vencimiento).
6. Para cálculos, muestra la fórmula y los números usados. No des recomendaciones de inversión ni dictámenes legales.
7. Responde en español, directo y breve. Formato: **negritas** para cifras clave, listas con guiones y tablas cortas cuando ayuden; no uses encabezados con # ni bloques de código.`;

// ── Portfolio-level scope (assistant opened outside a client) ─────────────────────────────────────────────────────────
export function buildPortfolioContext(clients: Client[]): ClientContextPack {
  const lines: string[] = [];
  const byStatus = new Map<string, number>();
  for (const c of clients) { const s = c.status || 'activo'; byStatus.set(s, (byStatus.get(s) || 0) + 1); }
  const monitored = clients.filter(isClientMonitored);
  const sum = (rows: Client[], pick: (c: Client) => number) => rows.reduce((a, c) => a + (pick(c) || 0), 0);
  lines.push(`Clientes: ${clients.length} (${[...byStatus.entries()].map(([s, n]) => `${n} ${s}`).join(', ')}). En monitoreo: ${monitored.length}.`);
  lines.push(`Línea total (monitoreados): ${mM(sum(monitored, c => c.totalCreditValue))} · Saldo vigente registrado: ${mM(sum(monitored, c => c.currentDue))}.`);
  lines.push('', 'FICHA POR CLIENTE (ordenados por línea): nombre | estatus | industria | línea | saldo registrado | analista | frecuencia');
  [...clients].sort((a, b) => (b.totalCreditValue || 0) - (a.totalCreditValue || 0)).slice(0, 120).forEach(c => {
    lines.push(`${c.name} | ${c.status || 'activo'} | ${c.industry || 'N/D'} | ${mM(c.totalCreditValue)} | ${mM(c.currentDue)} | ${c.analystName || 'N/D'} | ${c.frequency || 'N/D'}`);
  });
  const notes = clients.length > 120 ? [`Se listan los 120 clientes con mayor línea de ${clients.length}.`] : [];
  const text = lines.join('\n');
  return { text, approxTokens: Math.ceil(text.length / 3.6), sections: [{ title: 'CARTERA', chars: text.length }], notes };
}
