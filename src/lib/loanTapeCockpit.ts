// Cross-period ("cockpit") analytics for loan tapes.
// Builds month-over-month series, DPD migration, concentration/HHI trends, vintage
// (origination cohorts), a chronic-overdue watchlist, and a deterministic
// descriptive-quantitative narrative — reusing the per-snapshot primitives in
// loanTapeAnalytics.ts. No AI, no credit judgment: facts and deltas only.

import type { LoanTape_DB } from '../db/index';
import {
  StandardLoan,
  standardizeLoanTape,
  analyzeLoanTapesLocally,
  activeRows,
  sum,
  dpdDistribution,
  weightedAverage,
  groupBy,
  parseDate,
} from './loanTapeAnalytics';
import type { StructuredLoanTapeAnalysis } from '../services/ai';

export const DPD_BUCKETS = ['0 dias', '1-30', '31-60', '61-90', '91-180', '>180'] as const;

export interface CockpitPeriodPoint {
  period: string;          // 'YYYY-MM-DD'
  label: string;           // 'jun 24'
  saldo: number;
  creditos: number;
  clientes: number;
  wa_rate: number | null;
  vig: number; atr: number; ven: number; sinDato: number;
  vigPct: number; atrPct: number; venPct: number;
  dpd: number[];           // balances over DPD_BUCKETS (length 6)
  dpdPct: number[];
  over180: number;
  hhi: number;
  top1: number; top3: number; top5: number; top10: number;
  runoff: number | null;   // (saldo - prevSaldo) / prevSaldo
}

export interface CockpitMigration {
  period: string; label: string;
  new_n: number; new_bal: number;
  gone_n: number; gone_bal: number;
  deteriorated: number; cured: number; worsened: number;
}

export interface CockpitVintage {
  cohort: string;
  creditos: number; saldo: number;
  vig: number; atr: number; ven: number;
  vigPct: number; atrPct: number; venPct: number;
  avgDpd: number | null;
}

export interface CockpitClientTrend {
  client: string;
  values: (number | null)[]; // aligned to periods
}

export interface CockpitWatch {
  loan_id: string; client: string;
  monthsOverdue: number; maxDpd: number; saldoActual: number;
}

export interface CockpitData {
  periods: string[];
  labels: string[];
  series: CockpitPeriodPoint[];
  migration: CockpitMigration[];
  clientTrends: CockpitClientTrend[];
  watchlist: CockpitWatch[];
  topClients: string[];
  allRows: StandardLoan[];
}

const MONTHS_ES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
export function periodLabel(iso: string | null): string {
  if (!iso) return '—';
  const [y, m] = iso.split('-');
  const mi = Math.max(0, Math.min(11, (parseInt(m, 10) || 1) - 1));
  return `${MONTHS_ES[mi]} ${(y || '').slice(2)}`;
}

const norm = (v: any) => String(v ?? '').trim();
const clientKey = (r: StandardLoan) => norm(r.client) || '(sin cliente)';

// APEM / monitoreo convention: vigente = 0-30 DPD, atrasada = 31-90, vencida = >90.
// (The generic skill uses vigente=0; the cockpit follows the client-monitoring cut so
// figures reconcile with the operational cartera-vencida reports.)
function classifyBalances(rows: StandardLoan[]) {
  const bal = (pred: (r: StandardLoan) => boolean) => rows.filter(pred).reduce((a, r) => a + (r.outstanding_balance || 0), 0);
  return {
    vig: bal(r => r.days_overdue !== null && r.days_overdue <= 30),
    atr: bal(r => r.days_overdue !== null && r.days_overdue > 30 && r.days_overdue <= 90),
    ven: bal(r => r.days_overdue !== null && r.days_overdue > 90),
    sinDato: bal(r => r.days_overdue === null),
  };
}

function rowsStandardized(tape: LoanTape_DB): StandardLoan[] {
  const data: any = tape.extractedData;
  const fallback = parseDate(tape.uploadDate);
  const std: StandardLoan[] = Array.isArray(data?._standardized)
    ? data._standardized
    : standardizeLoanTape(Array.isArray(data) ? data : (data?.rows || []), tape.fileName).standardized;
  return std.map(r => ({ ...r, file_date: r.file_date || fallback }));
}

function flatten(tapes: LoanTape_DB[]): StandardLoan[] {
  const all: StandardLoan[] = [];
  for (const tape of tapes) all.push(...rowsStandardized(tape));
  return all;
}

function hhiOf(rows: StandardLoan[]): number {
  const total = sum(rows);
  if (!total) return 0;
  const m = new Map<string, number>();
  for (const r of rows) m.set(clientKey(r), (m.get(clientKey(r)) || 0) + (r.outstanding_balance || 0));
  let s = 0;
  for (const v of m.values()) { const share = v / total; s += share * share; }
  return s;
}

function cumTop(rows: StandardLoan[], ns: number[]): Record<number, number> {
  const total = sum(rows);
  const m = new Map<string, number>();
  for (const r of rows) m.set(clientKey(r), (m.get(clientKey(r)) || 0) + (r.outstanding_balance || 0));
  const vals = [...m.values()].sort((a, b) => b - a);
  const out: Record<number, number> = {};
  for (const n of ns) out[n] = total ? vals.slice(0, n).reduce((a, b) => a + b, 0) / total : 0;
  return out;
}

function dedupById(rows: StandardLoan[]): Map<string, StandardLoan> {
  const m = new Map<string, StandardLoan>();
  for (const r of rows) { const id = norm(r.loan_id); if (id) m.set(id, r); }
  return m;
}

export function buildCockpitData(tapes: LoanTape_DB[]): CockpitData {
  const all = flatten(tapes);
  const active = activeRows(all);
  const periods = Array.from(new Set(active.map(r => r.file_date).filter(Boolean) as string[])).sort();
  const labels = periods.map(periodLabel);
  const byPeriod = (p: string) => active.filter(r => r.file_date === p);

  const series: CockpitPeriodPoint[] = periods.map((p, i) => {
    const rows = byPeriod(p);
    const total = sum(rows);
    const cl = classifyBalances(rows);
    const dist = dpdDistribution(rows);
    const dpd = DPD_BUCKETS.map(b => dist.find(d => d.bucket === b)?.balance || 0);
    const dpdPct = dpd.map(v => (total ? v / total : 0));
    const ct = cumTop(rows, [1, 3, 5, 10]);
    const prev = i > 0 ? sum(byPeriod(periods[i - 1])) : null;
    return {
      period: p, label: labels[i],
      saldo: total,
      creditos: rows.length,
      clientes: new Set(rows.map(clientKey)).size,
      wa_rate: weightedAverage(rows, 'interest_rate'),
      vig: cl.vig, atr: cl.atr, ven: cl.ven, sinDato: cl.sinDato,
      vigPct: total ? cl.vig / total : 0, atrPct: total ? cl.atr / total : 0, venPct: total ? cl.ven / total : 0,
      dpd, dpdPct,
      over180: dpd[5] || 0,
      hhi: hhiOf(rows),
      top1: ct[1], top3: ct[3], top5: ct[5], top10: ct[10],
      runoff: prev && prev > 0 ? (total - prev) / prev : null,
    };
  });

  const migration: CockpitMigration[] = [];
  for (let i = 1; i < periods.length; i++) {
    const a = dedupById(byPeriod(periods[i - 1]));
    const b = dedupById(byPeriod(periods[i]));
    let new_n = 0, new_bal = 0, gone_n = 0, gone_bal = 0, deteriorated = 0, cured = 0, worsened = 0;
    for (const [id, r] of b) if (!a.has(id)) { new_n++; new_bal += r.outstanding_balance || 0; }
    for (const [id, r] of a) if (!b.has(id)) { gone_n++; gone_bal += r.outstanding_balance || 0; }
    for (const [id, ra] of a) {
      const rb = b.get(id); if (!rb) continue;
      const da = ra.days_overdue, db = rb.days_overdue;
      if (da === 0 && db !== null && db >= 1) deteriorated++;
      if (da !== null && da >= 1 && db === 0) cured++;
      if (da !== null && db !== null && db > da + 5) worsened++;
    }
    migration.push({ period: periods[i], label: labels[i], new_n, new_bal, gone_n, gone_bal, deteriorated, cured, worsened });
  }

  // Top clients by total balance across all periods (exclude blank)
  const clientTotals = new Map<string, number>();
  for (const r of active) { const k = clientKey(r); if (k === '(sin cliente)') continue; clientTotals.set(k, (clientTotals.get(k) || 0) + (r.outstanding_balance || 0)); }
  const topClients = [...clientTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(e => e[0]);
  const clientTrends: CockpitClientTrend[] = topClients.map(client => ({
    client,
    values: periods.map(p => {
      const rows = byPeriod(p).filter(r => clientKey(r) === client);
      return rows.length ? sum(rows) : null;
    }),
  }));

  // Watchlist: loans overdue >90d in >=2 periods
  const flags = new Map<string, { client: string; months: number; maxDpd: number }>();
  for (const p of periods) {
    for (const r of byPeriod(p)) {
      const id = norm(r.loan_id);
      if (!id || r.days_overdue === null || r.days_overdue <= 90) continue;
      const cur = flags.get(id) || { client: clientKey(r), months: 0, maxDpd: 0 };
      cur.months += 1; cur.maxDpd = Math.max(cur.maxDpd, r.days_overdue || 0);
      flags.set(id, cur);
    }
  }
  const latestRows = periods.length ? dedupById(byPeriod(periods[periods.length - 1])) : new Map();
  const watchlist: CockpitWatch[] = [...flags.entries()]
    .filter(([, v]) => v.months >= 2)
    .map(([id, v]) => ({ loan_id: id, client: v.client, monthsOverdue: v.months, maxDpd: v.maxDpd, saldoActual: latestRows.get(id)?.outstanding_balance || 0 }))
    .sort((a, b) => b.monthsOverdue - a.monthsOverdue || b.saldoActual - a.saldoActual)
    .slice(0, 15);

  return { periods, labels, series, migration, clientTrends, watchlist, topClients, allRows: all };
}

// Portfolio quality for one period, using the cockpit's 0-30/31-90/>90 convention
// (so the per-corte detail panel reconciles with the KPIs and the client's reports).
export function periodQuality(data: CockpitData, period: string) {
  const rows = activeRows(data.allRows).filter(r => r.file_date === period);
  const total = sum(rows);
  const c = classifyBalances(rows);
  const cnt = (pred: (r: StandardLoan) => boolean) => rows.filter(pred).length;
  return {
    vigente: { count: cnt(r => r.days_overdue !== null && r.days_overdue <= 30), balance: c.vig, pct: total ? c.vig / total : 0 },
    atrasada: { count: cnt(r => r.days_overdue !== null && r.days_overdue > 30 && r.days_overdue <= 90), balance: c.atr, pct: total ? c.atr / total : 0 },
    vencida: { count: cnt(r => r.days_overdue !== null && r.days_overdue > 90), balance: c.ven, pct: total ? c.ven / total : 0 },
  };
}

// Vintage / cosecha by origination cohort, on a given snapshot period (default latest).
export function buildVintage(data: CockpitData, period?: string): CockpitVintage[] {
  const p = period || data.periods[data.periods.length - 1];
  if (!p) return [];
  const rows = activeRows(data.allRows).filter(r => r.file_date === p);
  const m = new Map<string, StandardLoan[]>();
  for (const r of rows) {
    const cohort = r.start_date && /^\d{4}/.test(r.start_date) ? r.start_date.slice(0, 4) : 'Sin fecha';
    m.set(cohort, [...(m.get(cohort) || []), r]);
  }
  return [...m.entries()].map(([cohort, items]) => {
    const total = sum(items);
    const { vig, atr, ven } = classifyBalances(items);
    const dpds = items.map(i => i.days_overdue).filter((v): v is number => v !== null);
    return {
      cohort, creditos: items.length, saldo: total,
      vig, atr, ven,
      vigPct: total ? vig / total : 0, atrPct: total ? atr / total : 0, venPct: total ? ven / total : 0,
      avgDpd: dpds.length ? dpds.reduce((a, b) => a + b, 0) / dpds.length : null,
    };
  }).sort((a, b) => (a.cohort < b.cohort ? -1 : 1));
}

// Full per-snapshot skill analysis for a chosen period (uses rows up to & including it).
export function snapshotAnalysis(tapes: LoanTape_DB[], period: string): StructuredLoanTapeAnalysis {
  const subset = tapes
    .map(tape => {
      const std = rowsStandardized(tape).filter(r => !r.file_date || r.file_date <= period);
      return { ...tape, extractedData: { ...(tape.extractedData || {}), _standardized: std } };
    })
    .filter(t => (t.extractedData._standardized as StandardLoan[]).length > 0);
  return analyzeLoanTapesLocally(subset as LoanTape_DB[]);
}

const money = (v: number) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }).format(v || 0);
const pctS = (v: number) => `${(v * 100).toFixed(1)}%`;
const pp = (a: number, b: number) => `${(a - b) >= 0 ? '+' : ''}${((a - b) * 100).toFixed(1)} pp`;

// Deterministic descriptive-quantitative narrative. Facts and deltas ONLY — no judgment.
export function buildCockpitNarrative(data: CockpitData, selectedPeriods?: string[]): string[] {
  const sel = (selectedPeriods && selectedPeriods.length ? data.series.filter(s => selectedPeriods.includes(s.period)) : data.series);
  if (!sel.length) return ['Sin períodos para describir.'];
  const first = sel[0], last = sel[sel.length - 1];
  const lines: string[] = [];
  lines.push(`Período descrito: ${first.label} → ${last.label} (${sel.length} corte${sel.length > 1 ? 's' : ''}).`);
  if (sel.length > 1) {
    const dPct = first.saldo ? (last.saldo - first.saldo) / first.saldo : 0;
    lines.push(`Saldo: ${money(first.saldo)} → ${money(last.saldo)} (${dPct >= 0 ? '+' : ''}${(dPct * 100).toFixed(1)}%).`);
    lines.push(`Cartera vencida (>90d): ${pctS(first.venPct)} → ${pctS(last.venPct)} (${pp(last.venPct, first.venPct)}).`);
    lines.push(`Cartera atrasada (1-90d): ${pctS(first.atrPct)} → ${pctS(last.atrPct)} (${pp(last.atrPct, first.atrPct)}).`);
    lines.push(`Créditos activos: ${first.creditos} → ${last.creditos}. Clientes: ${first.clientes} → ${last.clientes}.`);
    const runoffs = sel.map(s => s.runoff).filter((v): v is number => v !== null);
    if (runoffs.length) lines.push(`Variación mensual de saldo (runoff) promedio: ${(runoffs.reduce((a, b) => a + b, 0) / runoffs.length * 100).toFixed(1)}%.`);
  } else {
    lines.push(`Saldo: ${money(last.saldo)} en ${last.creditos} créditos y ${last.clientes} clientes.`);
    lines.push(`Vigente ${pctS(last.vigPct)} · atrasada ${pctS(last.atrPct)} · vencida (>90d) ${pctS(last.venPct)}.`);
  }
  const topName = (() => {
    const rows = activeRows(data.allRows).filter(r => r.file_date === last.period);
    return groupBy(rows, 'client', 1)[0]?.name || '—';
  })();
  lines.push(`Concentración Top-1: ${pctS(last.top1)} (${topName}); Top-3 ${pctS(last.top3)}; Top-10 ${pctS(last.top10)}. HHI ${last.hhi.toFixed(3)}.`);
  lines.push(`Saldo con más de 180 días de atraso: ${money(last.over180)} (${pctS(last.saldo ? last.over180 / last.saldo : 0)}).`);
  lines.push(`Tasa ponderada: ${last.wa_rate !== null ? pctS(last.wa_rate) : '—'}.`);
  const lastMig = data.migration.filter(m => sel.some(s => s.period === m.period)).slice(-1)[0];
  if (lastMig) lines.push(`En el corte ${lastMig.label}: ${lastMig.deteriorated} crédito(s) se deterioraron y ${lastMig.cured} se curaron; ${lastMig.new_n} alta(s), ${lastMig.gone_n} baja(s).`);
  return lines;
}
