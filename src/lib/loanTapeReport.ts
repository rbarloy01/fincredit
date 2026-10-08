// Loan-tape portfolio report: analytics, insights and the native-chart Excel workbook (Axcess style).
// Everything here is deterministic and descriptive — facts, deltas and thresholds; no credit judgment.

import type { SheetDef } from './export';
import type { StandardLoan } from './loanTapeAnalytics';
import { activeRows, parseDate, sum, weightedAverage } from './loanTapeAnalytics';
import type { CockpitData } from './loanTapeCockpit';
import { AXC, type ChartKind, type ChartGrouping, type ChartSpec } from './xlsxCharts';
import { buildEconomicGroups, type EconomicGroup, type GroupOverrides } from './economicGroups';
import { buildMigrationMatrix, type MigrationMatrix } from './loanTapeMigration';
import { DPD_BUCKET_DEFS, QUALITY_DEFINITION_LINES, QUALITY_LABELS, QUALITY_RULES, RISK_THRESHOLDS, classifyDpd, reconcileQuality } from './portfolioRules';

// ── Types ─────────────────────────────────────────────────────────────────────

export type InsightLevel = 'good' | 'info' | 'warn' | 'alert';
export interface Insight { category: string; level: InsightLevel; text: string }

export interface Bucket { label: string; lo: number; hi: number; count: number; balance: number; pct: number; avgRate: number | null; waRate: number | null; avgTerm: number | null; avgDpd: number | null }
interface QualityClass { key: 'vigente' | 'atrasada' | 'vencida' | 'sin_dato'; label: string; count: number; balance: number; pct: number }
interface GroupRow {
  name: string; count: number; balance: number; pct: number;
  waRate: number | null; avgRate: number | null; avgTermMonths: number | null; avgDpd: number | null;
  avgAmount: number | null; minAmount: number | null; maxAmount: number | null;
  vigPct: number; atrPct: number; venPct: number;
}
interface PeriodRow { period: string; amount: number; count: number; growth: number | null }

export interface PortfolioAnalysis {
  focusPeriod: string;
  focusLabel: string;
  isSummary: boolean;
  rows: StandardLoan[];
  prevRows: StandardLoan[];
  prevLabel: string | null;
  kpi: {
    saldo: number; creditos: number; clientes: number; montoOriginal: number; amortizadoPct: number | null;
    waRate: number | null; simpleRate: number | null; minRate: number | null; maxRate: number | null; p25Rate: number | null; medianRate: number | null; p75Rate: number | null;
    waTermMonths: number | null; waRemainingMonths: number | null; waDpd: number | null;
    avgTicket: number; maxLoan: number; maxLoanPct: number; waAgeMonths: number | null;
    zeroRateCount: number; zeroRatePct: number;
  };
  prevKpi: { saldo: number; creditos: number; clientes: number; waRate: number | null; vencidaPct: number; atrasadaPct: number } | null;
  quality: QualityClass[];
  dpd: Array<{ bucket: string; count: number; balance: number; pct: number }>;
  clients: Array<{ rank: number; name: string; count: number; balance: number; pct: number; cumPct: number; venPct: number }>;
  topN: Array<{ label: string; balance: number; original: number; count: number; pct: number }>;
  hhi: number;
  effectiveClients: number | null;
  industries: GroupRow[];
  states: GroupRow[];
  products: GroupRow[];
  currencies: GroupRow[];
  sizeOutstanding: Bucket[];
  sizeAmount: Bucket[];
  sizeCount: Bucket[];
  rateBuckets: Bucket[];
  termBuckets: Bucket[];
  maturity: Array<{ quarter: string; count: number; balance: number; pct: number }>;
  originationMonthly: PeriodRow[];
  originationQuarterly: PeriodRow[];
  originationYearly: PeriodRow[];
  rateByDpd: Array<{ label: string; count: number; balance: number; waRate: number | null }>;
  coverage: Array<{ field: string; pct: number }>;
  endedWithBalance: { count: number; balance: number };
  maturing90: { count: number; balance: number };
  maturing12: { balance: number; pct: number };
  groups: EconomicGroup[];
  migration: MigrationMatrix | null;
}

// ── Small numeric helpers ─────────────────────────────────────────────────────

const DAY = 86400000;
const MONTH_DAYS = 30.44;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const bal = (r: StandardLoan) => r.outstanding_balance || 0;

function monthsBetween(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const x = new Date(a).getTime(); const y = new Date(b).getTime();
  return Number.isFinite(x) && Number.isFinite(y) ? (y - x) / DAY / MONTH_DAYS : null;
}

function wavg(rows: StandardLoan[], pick: (r: StandardLoan) => number | null): number | null {
  let w = 0; let t = 0;
  for (const r of rows) { const v = pick(r); const b = bal(r); if (v !== null && b > 0) { t += v * b; w += b; } }
  return w ? t / w : null;
}

function avg(values: Array<number | null>): number | null {
  const v = values.filter((x): x is number => x !== null && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

function quantile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q; const lo = Math.floor(pos); const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

const classOf = (dpd: number | null): QualityClass['key'] => classifyDpd(dpd);

const money0 = (v: number) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }).format(v || 0);
const moneyM = (v: number) => `${v < 0 ? '-' : ''}$${(Math.abs(v) / 1_000_000).toLocaleString('es-MX', { maximumFractionDigits: 1 })} M`;
const pctS = (v: number, d = 1) => `${(v * 100).toFixed(d)}%`;
const ppS = (a: number, b: number) => `${a - b >= 0 ? '+' : ''}${((a - b) * 100).toFixed(1)} pp`;

function equalWidth(rows: StandardLoan[], value: (r: StandardLoan) => number | null, n: number, label: (lo: number, hi: number) => string): Bucket[] {
  const items = rows.map(r => ({ r, v: value(r) })).filter((x): x is { r: StandardLoan; v: number } => x.v !== null);
  if (!items.length) return [];
  const lo = Math.min(...items.map(i => i.v)); let hi = Math.max(...items.map(i => i.v));
  if (lo === hi) hi = lo + 1;
  const edges = Array.from({ length: n + 1 }, (_, i) => lo + (i * (hi - lo)) / n);
  const totalBal = sum(items.map(i => i.r));
  return Array.from({ length: n }, (_, i) => {
    const members = items.filter(({ v }) => (i === n - 1 ? v >= edges[i] && v <= edges[i + 1] : v >= edges[i] && v < edges[i + 1])).map(x => x.r);
    return makeBucket(label(edges[i], edges[i + 1]), edges[i], edges[i + 1], members, totalBal);
  });
}

function quantileBuckets(rows: StandardLoan[], value: (r: StandardLoan) => number | null, n: number, label: (lo: number, hi: number) => string): Bucket[] {
  const items = rows.map(r => ({ r, v: value(r) })).filter((x): x is { r: StandardLoan; v: number } => x.v !== null);
  if (!items.length) return [];
  const sorted = [...items].sort((a, b) => a.v - b.v);
  const bins = Math.max(2, Math.min(n, new Set(sorted.map(s => s.v)).size));
  const totalBal = sum(items.map(i => i.r));
  const out: Bucket[] = [];
  for (let i = 0; i < bins; i++) {
    const slice = sorted.slice(Math.floor((i * sorted.length) / bins), Math.floor(((i + 1) * sorted.length) / bins));
    if (!slice.length) continue;
    out.push(makeBucket(label(slice[0].v, slice[slice.length - 1].v), slice[0].v, slice[slice.length - 1].v, slice.map(s => s.r), totalBal));
  }
  return out;
}

function makeBucket(label: string, lo: number, hi: number, members: StandardLoan[], totalBal: number): Bucket {
  const balance = sum(members);
  return {
    label, lo, hi, count: members.length, balance, pct: totalBal ? balance / totalBal : 0,
    avgRate: avg(members.map(m => num(m.interest_rate))),
    waRate: wavg(members, m => num(m.interest_rate)),
    avgTerm: avg(members.map(m => monthsBetween(m.start_date, m.end_date))),
    avgDpd: avg(members.map(m => num(m.days_overdue))),
  };
}

function groupRows(rows: StandardLoan[], key: (r: StandardLoan) => string, limit = 20): GroupRow[] {
  const total = sum(rows);
  const map = new Map<string, StandardLoan[]>();
  for (const r of rows) {
    const k = key(r).trim();
    if (!k) continue;
    (map.get(k) || map.set(k, []).get(k)!).push(r);
  }
  return [...map.entries()].map(([name, items]) => {
    const balance = sum(items);
    const amounts = items.map(i => num(i.amount)).filter((v): v is number => v !== null);
    const q = (k: QualityClass['key']) => sum(items.filter(i => classOf(num(i.days_overdue)) === k));
    return {
      name, count: items.length, balance, pct: total ? balance / total : 0,
      waRate: wavg(items, i => num(i.interest_rate)), avgRate: avg(items.map(i => num(i.interest_rate))),
      avgTermMonths: avg(items.map(i => monthsBetween(i.start_date, i.end_date))), avgDpd: avg(items.map(i => num(i.days_overdue))),
      avgAmount: avg(amounts), minAmount: amounts.length ? Math.min(...amounts) : null, maxAmount: amounts.length ? Math.max(...amounts) : null,
      vigPct: balance ? q('vigente') / balance : 0, atrPct: balance ? q('atrasada') / balance : 0, venPct: balance ? q('vencida') / balance : 0,
    };
  }).sort((a, b) => b.balance - a.balance).slice(0, limit);
}

function originationBy(rows: StandardLoan[], keyOf: (start: string) => string): PeriodRow[] {
  const map = new Map<string, { amount: number; count: number }>();
  for (const r of rows) {
    const d = r.start_date && parseDate(r.start_date);
    if (!d || !r.amount) continue;
    const k = keyOf(d);
    const cur = map.get(k) || { amount: 0, count: 0 };
    cur.amount += r.amount; cur.count += 1; map.set(k, cur);
  }
  const sorted = [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return sorted.map(([period, v], i) => ({ period, amount: v.amount, count: v.count, growth: i > 0 && sorted[i - 1][1].amount ? v.amount / sorted[i - 1][1].amount - 1 : null }));
}

const quarterOf = (d: string) => `${d.slice(0, 4)}-T${Math.floor((parseInt(d.slice(5, 7), 10) - 1) / 3) + 1}`;

// ── Analysis ──────────────────────────────────────────────────────────────────

export function analyzePortfolio(data: CockpitData, focusPeriod: string, groupOverrides: GroupOverrides = {}): PortfolioAnalysis | null {
  const point = data.series.find(s => s.period === focusPeriod) || data.series[data.series.length - 1];
  if (!point) return null;
  const active = activeRows(data.allRows);
  const rows = active.filter(r => r.file_date === point.period);
  const idx = data.periods.indexOf(point.period);
  const prevPeriod = idx > 0 ? data.periods[idx - 1] : null;
  const prevRows = prevPeriod ? active.filter(r => r.file_date === prevPeriod) : [];
  const isSummary = point.isSummary;
  const asOf = point.period;
  const total = sum(rows);

  const rates = rows.map(r => num(r.interest_rate)).filter((v): v is number => v !== null);
  const positiveRates = rates.filter(v => v > 0);
  const amounts = rows.map(r => num(r.amount)).filter((v): v is number => v !== null);
  const montoOriginal = amounts.reduce((a, b) => a + b, 0);
  const maxLoan = rows.reduce((m, r) => Math.max(m, bal(r)), 0);
  const zeroRate = rows.filter(r => r.interest_rate === 0 || r.interest_rate === null);

  const qualityOf = (list: StandardLoan[]): QualityClass[] => {
    const t = sum(list);
    const mk = (key: QualityClass['key'], label: string): QualityClass => {
      const m = list.filter(r => classOf(num(r.days_overdue)) === key);
      const b = sum(m);
      return { key, label, count: m.length, balance: b, pct: t ? b / t : 0 };
    };
    return (['vigente', 'atrasada', 'vencida', 'sin_dato'] as const).map(k => mk(k, QUALITY_LABELS[k]));
  };
  const quality = qualityOf(rows);
  const prevQuality = qualityOf(prevRows);

  const dpdDefs = DPD_BUCKET_DEFS.map(b => ({ bucket: b.label, min: b.min, max: b.max }));
  const dpd = dpdDefs.map(b => {
    const m = rows.filter(r => r.days_overdue !== null && r.days_overdue >= b.min && r.days_overdue <= b.max);
    const balance = sum(m);
    return { bucket: b.bucket, count: m.length, balance, pct: total ? balance / total : 0 };
  });

  // clients (by name), with cumulative share and overdue share
  const clientMap = new Map<string, StandardLoan[]>();
  for (const r of rows) { const k = (r.client || '').trim() || '(sin cliente)'; (clientMap.get(k) || clientMap.set(k, []).get(k)!).push(r); }
  const clientAll = [...clientMap.entries()].map(([name, items]) => ({ name, items, balance: sum(items) })).filter(c => c.balance > 0).sort((a, b) => b.balance - a.balance);
  let cum = 0;
  const clients = clientAll.slice(0, 20).map((c, i) => {
    const pct = total ? c.balance / total : 0; cum += pct;
    return { rank: i + 1, name: c.name, count: c.items.length, balance: c.balance, pct, cumPct: cum, venPct: c.balance ? sum(c.items.filter(r => classOf(num(r.days_overdue)) === 'vencida')) / c.balance : 0 };
  });
  const topN = [1, 3, 5, 10, 15, 20].filter(n => n <= clientAll.length).map(n => {
    const slice = clientAll.slice(0, n);
    const b = slice.reduce((a, c) => a + c.balance, 0);
    return { label: `Top ${n}`, balance: b, original: slice.reduce((a, c) => a + c.items.reduce((x, r) => x + (r.amount || 0), 0), 0), count: slice.reduce((a, c) => a + c.items.length, 0), pct: total ? b / total : 0 };
  });
  const hhi = clientAll.reduce((a, c) => a + (total ? (c.balance / total) ** 2 : 0), 0);

  const states = groupRows(rows, r => r.state || '', 11);
  const industries = groupRows(rows, r => r.industry || '', 10);
  const products = groupRows(rows, r => r.loan_type || '', 20);
  const currencies = groupRows(rows, r => r.currency || '', 6);

  const money = (v: number) => `$${Math.round(v).toLocaleString('es-MX')}`;
  const sizeOutstanding = equalWidth(rows, r => num(r.outstanding_balance), 5, (a, b) => `${money(a)} – ${money(b)}`);
  const sizeAmount = equalWidth(rows, r => num(r.amount), 5, (a, b) => `${money(a)} – ${money(b)}`);
  const sizeCount = quantileBuckets(rows, r => num(r.outstanding_balance), 5, (a, b) => `${money(a)} – ${money(b)}`);
  const rateBuckets = rates.length ? equalWidth(rows, r => num(r.interest_rate), 5, (a, b) => `${(a * 100).toFixed(2)}% – ${(b * 100).toFixed(2)}%`) : [];
  const termRows = rows.filter(r => monthsBetween(r.start_date, r.end_date) !== null);
  const termBuckets = termRows.length ? equalWidth(rows, r => monthsBetween(r.start_date, r.end_date), 5, (a, b) => `${a.toFixed(0)} – ${b.toFixed(0)} meses`) : [];

  const futureEnd = rows.filter(r => r.end_date && r.end_date >= asOf);
  const maturityMap = new Map<string, { count: number; balance: number }>();
  for (const r of futureEnd) { const k = quarterOf(r.end_date!); const c = maturityMap.get(k) || { count: 0, balance: 0 }; c.count += 1; c.balance += bal(r); maturityMap.set(k, c); }
  const maturity = [...maturityMap.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([quarter, v]) => ({ quarter, ...v, pct: total ? v.balance / total : 0 }));
  const in90 = new Date(new Date(asOf).getTime() + 90 * DAY).toISOString().slice(0, 10);
  const in365 = new Date(new Date(asOf).getTime() + 365 * DAY).toISOString().slice(0, 10);
  const m90 = futureEnd.filter(r => r.end_date! <= in90);
  const m12 = futureEnd.filter(r => r.end_date! <= in365);
  const ended = rows.filter(r => r.end_date && r.end_date < asOf && bal(r) > 0);

  const allActiveHistory = active.filter(r => !r.file_date || r.file_date <= asOf);
  const originationMonthly = originationBy(rows.length ? dedupeLatest(allActiveHistory) : [], d => d.slice(0, 7));
  const originationQuarterly = originationBy(dedupeLatest(allActiveHistory), quarterOf);
  const originationYearly = originationBy(dedupeLatest(allActiveHistory), d => d.slice(0, 4));

  const rateByDpd = (['vigente', 'atrasada', 'vencida'] as const).map(k => {
    const m = rows.filter(r => classOf(num(r.days_overdue)) === k);
    return { label: quality.find(q => q.key === k)!.label, count: m.length, balance: sum(m), waRate: wavg(m, r => num(r.interest_rate)) };
  });

  const present = (pick: (r: StandardLoan) => unknown) => (rows.length ? rows.filter(r => { const v = pick(r); return v !== null && v !== undefined && v !== ''; }).length / rows.length : 0);
  const coverage = [
    { field: 'Cliente', pct: present(r => r.client) }, { field: 'Saldo', pct: present(r => r.outstanding_balance) },
    { field: 'Monto original', pct: present(r => r.amount) }, { field: 'Tasa de interés', pct: present(r => r.interest_rate) },
    { field: 'Días de atraso (DPD)', pct: present(r => r.days_overdue) }, { field: 'Fecha de inicio', pct: present(r => r.start_date) },
    { field: 'Fecha de vencimiento', pct: present(r => r.end_date) }, { field: 'Producto', pct: present(r => r.loan_type) },
    { field: 'Giro / industria', pct: present(r => r.industry) }, { field: 'Estado', pct: present(r => r.state) },
  ];

  const ageMonths = wavg(rows, r => monthsBetween(r.start_date, asOf));
  const prevPoint = prevPeriod ? data.series.find(s => s.period === prevPeriod) : null;

  return {
    focusPeriod: point.period, focusLabel: point.label, isSummary, rows, prevRows, prevLabel: prevPoint?.label || null,
    kpi: {
      saldo: total, creditos: isSummary ? 0 : rows.length, clientes: isSummary ? 0 : clientMap.size, montoOriginal,
      amortizadoPct: montoOriginal > 0 ? Math.max(0, 1 - total / montoOriginal) : null,
      waRate: weightedAverage(rows, 'interest_rate'), simpleRate: avg(rates),
      minRate: rates.length ? Math.min(...rates) : null, maxRate: rates.length ? Math.max(...rates) : null,
      p25Rate: quantile(positiveRates, 0.25), medianRate: quantile(positiveRates, 0.5), p75Rate: quantile(positiveRates, 0.75),
      waTermMonths: wavg(rows, r => monthsBetween(r.start_date, r.end_date)),
      waRemainingMonths: wavg(futureEnd, r => monthsBetween(asOf, r.end_date)),
      waDpd: weightedAverage(rows, 'days_overdue'),
      avgTicket: rows.length ? total / rows.length : 0, maxLoan, maxLoanPct: total ? maxLoan / total : 0, waAgeMonths: ageMonths,
      zeroRateCount: zeroRate.length, zeroRatePct: rows.length ? zeroRate.length / rows.length : 0,
    },
    prevKpi: prevRows.length ? {
      saldo: sum(prevRows), creditos: prevRows.length, clientes: new Set(prevRows.map(r => r.client || '')).size,
      waRate: weightedAverage(prevRows, 'interest_rate'),
      vencidaPct: prevQuality.find(q => q.key === 'vencida')!.pct, atrasadaPct: prevQuality.find(q => q.key === 'atrasada')!.pct,
    } : null,
    quality, dpd, clients, topN, hhi, effectiveClients: hhi > 0 ? 1 / hhi : null,
    industries, states, products, currencies, sizeOutstanding, sizeAmount, sizeCount, rateBuckets, termBuckets, maturity,
    originationMonthly, originationQuarterly, originationYearly, rateByDpd, coverage,
    endedWithBalance: { count: ended.length, balance: sum(ended) },
    maturing90: { count: m90.length, balance: sum(m90) },
    maturing12: { balance: sum(m12), pct: total ? sum(m12) / total : 0 },
    groups: isSummary ? [] : buildEconomicGroups(rows, groupOverrides),
    migration: prevRows.length && !isSummary ? buildMigrationMatrix(prevRows, rows, prevPoint?.label || 'previo', point.label) : null,
  };
}

// Originations come from every snapshot, but a loan reappears each month — keep one row per loan (latest snapshot).
function dedupeLatest(rows: StandardLoan[]): StandardLoan[] {
  const m = new Map<string, StandardLoan>();
  rows.forEach((r, i) => { const k = r.loan_id ? String(r.loan_id) : `__${i}`; const prev = m.get(k); if (!prev || (r.file_date || '') >= (prev.file_date || '')) m.set(k, r); });
  return [...m.values()];
}

// ── Insights ──────────────────────────────────────────────────────────────────

export function buildLoanTapeInsights(a: PortfolioAnalysis, data: CockpitData, anomalies?: Record<string, any[]>): Insight[] {
  const out: Insight[] = [];
  const add = (category: string, level: InsightLevel, text: string) => out.push({ category, level, text });
  const k = a.kpi;
  const q = (key: QualityClass['key']) => a.quality.find(x => x.key === key)!;
  const ven = q('vencida'); const atr = q('atrasada'); const vig = q('vigente'); const sin = q('sin_dato');

  // Calidad
  const zeroDpd = a.dpd[0];
  if (zeroDpd) add('Calidad de cartera', 'info', `Cómo leer “vigente”: ${pctS(vig.pct)} del saldo está vigente (0-${QUALITY_RULES.vigenteMaxDpd} DPD) = ${pctS(zeroDpd.pct)} al corriente (0 días) + ${pctS(Math.max(0, vig.pct - zeroDpd.pct))} con atraso de 1-${QUALITY_RULES.vigenteMaxDpd} días. Es la misma cifra, vista en dos cortes.`);
  add('Calidad de cartera', ven.pct > RISK_THRESHOLDS.vencidaAlert ? 'alert' : ven.pct >= RISK_THRESHOLDS.vencidaWarn ? 'warn' : 'good', `Cartera vencida (${QUALITY_RULES.atrasadaMaxDpd + 1}+ DPD): ${pctS(ven.pct)} del saldo (${moneyM(ven.balance)} en ${ven.count} crédito${ven.count === 1 ? '' : 's'}).`);
  add('Calidad de cartera', atr.pct > RISK_THRESHOLDS.atrasadaWarn ? 'warn' : 'info', `Cartera atrasada (${QUALITY_RULES.vigenteMaxDpd + 1}-${QUALITY_RULES.atrasadaMaxDpd} DPD): ${pctS(atr.pct)} (${moneyM(atr.balance)}, ${atr.count} créditos). Vigente (0-${QUALITY_RULES.vigenteMaxDpd} DPD): ${pctS(vig.pct)}.`);
  if (a.prevKpi) {
    add('Calidad de cartera', ven.pct > a.prevKpi.vencidaPct + 0.005 ? 'warn' : ven.pct < a.prevKpi.vencidaPct - 0.005 ? 'good' : 'info', `Vs. ${a.prevLabel}: vencida ${ppS(ven.pct, a.prevKpi.vencidaPct)} (de ${pctS(a.prevKpi.vencidaPct)} a ${pctS(ven.pct)}); atrasada ${ppS(atr.pct, a.prevKpi.atrasadaPct)}.`);
  }
  if (k.waDpd !== null) add('Calidad de cartera', k.waDpd > RISK_THRESHOLDS.waDpdAlert ? 'alert' : k.waDpd > RISK_THRESHOLDS.waDpdWarn ? 'warn' : 'info', `DPD ponderado por saldo: ${k.waDpd.toFixed(1)} días.`);
  const over180 = a.dpd.find(d => d.bucket === '>180');
  if (over180 && over180.balance > 0) add('Calidad de cartera', 'alert', `${moneyM(over180.balance)} (${pctS(over180.pct)}) con más de 180 días de atraso en ${over180.count} crédito(s).`);
  const venClients = [...a.clients].filter(c => c.venPct > 0).sort((x, y) => y.venPct * y.balance - x.venPct * x.balance)[0];
  if (venClients && ven.balance > 0) add('Calidad de cartera', 'info', `El cliente con mayor saldo vencido es ${venClients.name}: ${moneyM(venClients.venPct * venClients.balance)} (${pctS((venClients.venPct * venClients.balance) / ven.balance)} de la cartera vencida).`);
  if (sin.balance > 0) add('Calidad de cartera', sin.pct > RISK_THRESHOLDS.missingDpdAlert ? 'alert' : 'warn', `${pctS(sin.pct)} del saldo (${sin.count} créditos) no trae DPD: no se puede clasificar como vigente/atrasada/vencida.`);

  // Movimiento
  const mig = data.migration.find(m => m.period === a.focusPeriod);
  if (mig) {
    add('Movimiento vs. corte previo', mig.deteriorated > mig.cured ? 'warn' : 'info', `${mig.deteriorated} crédito(s) entraron en mora y ${mig.cured} se curaron (${mig.worsened} empeoraron más de 5 días).`);
    add('Movimiento vs. corte previo', 'info', `Altas: ${mig.new_n} créditos por ${moneyM(mig.new_bal)}. Bajas: ${mig.gone_n} créditos por ${moneyM(mig.gone_bal)}. Saldo neto: ${moneyM(k.saldo - (a.prevKpi?.saldo || 0))}.`);
    const priorVigente = a.prevRows.filter(r => classOf(num(r.days_overdue)) === 'vigente').length;
    if (priorVigente) add('Movimiento vs. corte previo', 'info', `Roll-rate a mora: ${pctS(mig.deteriorated / priorVigente)} de los créditos vigentes del corte previo cayeron en atraso.`);
  }
  const incons = anomalies?.dpd_inconsistency?.length;
  if (incons) add('Movimiento vs. corte previo', 'warn', `${incons} crédito(s) con DPD sin cambio o con salto mayor a 30 días entre cortes: revisar consistencia del dato.`);

  // Concentración
  const top1 = a.topN.find(t => t.label === 'Top 1'); const top5 = a.topN.find(t => t.label === 'Top 5'); const top10 = a.topN.find(t => t.label === 'Top 10');
  if (top1) add('Concentración', top1.pct > RISK_THRESHOLDS.clientConcentrationAlert ? 'alert' : top1.pct > RISK_THRESHOLDS.clientConcentrationWarn ? 'warn' : 'info', `Cliente #1: ${a.clients[0].name} con ${pctS(top1.pct)} del saldo${top5 ? `; Top 5 ${pctS(top5.pct)}` : ''}${top10 ? `; Top 10 ${pctS(top10.pct)}` : ''}.`);
  if (a.effectiveClients !== null) add('Concentración', a.hhi > RISK_THRESHOLDS.hhiHigh ? 'alert' : a.hhi > RISK_THRESHOLDS.hhiModerate ? 'warn' : 'good', `HHI ${a.hhi.toFixed(3)} (${a.hhi > RISK_THRESHOLDS.hhiHigh ? 'concentración alta' : a.hhi > RISK_THRESHOLDS.hhiModerate ? 'concentración moderada' : 'cartera diversificada'}): equivale a ${a.effectiveClients.toFixed(1)} clientes del mismo tamaño.`);
  const big = a.clients.filter(c => c.pct > 0.05);
  if (a.clients.length) add('Concentración', 'info', `${big.length} cliente(s) superan 5% del saldo${big.length ? `: ${big.slice(0, 4).map(c => `${c.name} (${pctS(c.pct)})`).join(', ')}` : ''}.`);
  add('Concentración', k.maxLoanPct > RISK_THRESHOLDS.largestLoanWarn ? 'warn' : 'info', `Crédito más grande: ${moneyM(k.maxLoan)} (${pctS(k.maxLoanPct)} del saldo). Ticket promedio ${money0(k.avgTicket)}.`);
  if (a.products[0]) add('Concentración', 'info', `Producto principal: ${a.products[0].name} con ${pctS(a.products[0].pct)} del saldo${a.products.length > 1 ? ` (${a.products.length} productos)` : ''}.`);
  if (a.industries[0]) add('Concentración', a.industries[0].pct > 0.4 ? 'warn' : 'info', `Giro principal: ${a.industries[0].name} con ${pctS(a.industries[0].pct)} del saldo.`);
  if (a.states[0]) add('Concentración', a.states[0].pct > 0.4 ? 'warn' : 'info', `Estado principal: ${a.states[0].name} con ${pctS(a.states[0].pct)} del saldo.`);

  const multi = a.groups.filter(g => g.inferred);
  if (multi.length) {
    const topGroup = a.groups[0];
    add('Concentración', topGroup.pct > RISK_THRESHOLDS.clientConcentrationAlert ? 'alert' : topGroup.pct > RISK_THRESHOLDS.clientConcentrationWarn ? 'warn' : 'info',
      `Por grupo económico: ${multi.length} grupo(s) reúnen varios acreditados (${multi.slice(0, 3).map(g => `${g.name} · ${g.members.length} acreditados · ${pctS(g.pct)}`).join('; ')}). El grupo #1 pesa ${pctS(topGroup.pct)} del saldo${a.clients[0] && topGroup.pct > a.clients[0].pct + 0.0001 ? ` frente a ${pctS(a.clients[0].pct)} del cliente #1` : ''}.`);
  } else if (a.groups.length > 1) {
    add('Concentración', 'info', 'Por grupo económico: no se detectaron acreditados relacionados por nombre (sin columna de grupo o RFC en el tape, solo se infiere por nombre).');
  }

  // Migración entre cortes
  const mg = a.migration;
  if (mg) {
    const sm = mg.summary;
    if (sm.performingToDelinquentPct !== null) add('Migración de mora', sm.performingToDelinquentPct > 0.03 ? 'warn' : 'info', `Roll-in: ${pctS(sm.performingToDelinquentPct, 2)} del saldo al corriente (0 días) en ${mg.fromLabel} que sigue en cartera cayó en atraso en ${mg.toLabel} (no cuenta lo que salió).`);
    if (sm.delinquentCurePct !== null) add('Migración de mora', sm.delinquentCurePct >= 0.3 ? 'good' : 'info', `Cura: ${pctS(sm.delinquentCurePct)} del saldo en atraso volvió a 0 días.`);
    add('Migración de mora', sm.worsePct > sm.betterPct ? 'warn' : 'info', `De los créditos que siguen: ${pctS(sm.stablePct)} del saldo igual, ${pctS(sm.worsePct)} empeoró de bucket y ${pctS(sm.betterPct)} mejoró. Salieron ${moneyM(sm.exitBalance)} y entraron ${moneyM(sm.newBalance)}.`);
  }

  // Tasas
  if (k.waRate !== null) {
    add('Tasas', 'info', `Tasa ponderada por saldo: ${pctS(k.waRate, 2)}${k.simpleRate !== null ? ` (simple ${pctS(k.simpleRate, 2)})` : ''}${a.prevKpi?.waRate != null ? `; vs. ${a.prevLabel}: ${ppS(k.waRate, a.prevKpi.waRate)}` : ''}.`);
    if (k.p25Rate !== null && k.p75Rate !== null && k.medianRate !== null) add('Tasas', 'info', `Distribución de tasas (créditos con tasa > 0): mediana ${pctS(k.medianRate, 2)}, rango intercuartil ${pctS(k.p25Rate, 2)} – ${pctS(k.p75Rate, 2)}; mínima ${pctS(k.minRate ?? 0, 2)} y máxima ${pctS(k.maxRate ?? 0, 2)}.`);
    const dom = [...a.rateBuckets].sort((x, y) => y.pct - x.pct)[0];
    if (dom) add('Tasas', 'info', `El rango de tasa con más saldo es ${dom.label}: ${pctS(dom.pct)} del saldo en ${dom.count} créditos.`);
  }
  if (k.zeroRateCount > 0) add('Tasas', k.zeroRatePct > 0.05 ? 'warn' : 'info', `${k.zeroRateCount} crédito(s) (${pctS(k.zeroRatePct)}) reportan tasa 0% o vacía: validar contra el contrato o el layout.`);
  const rv = a.rateByDpd.find(r => r.label.startsWith('Vigente')); const rn = a.rateByDpd.find(r => r.label.startsWith('Vencida'));
  if (rv?.waRate != null && rn?.waRate != null && rn.count) add('Tasas', rn.waRate > rv.waRate ? 'info' : 'warn', `Tasa ponderada de créditos vencidos ${pctS(rn.waRate, 2)} vs. vigentes ${pctS(rv.waRate, 2)} (${ppS(rn.waRate, rv.waRate)}).`);
  const byRate = a.products.filter(p => p.waRate !== null).sort((x, y) => (y.waRate as number) - (x.waRate as number));
  if (byRate.length > 1) add('Tasas', 'info', `Producto con mayor tasa: ${byRate[0].name} (${pctS(byRate[0].waRate as number, 2)}); menor: ${byRate[byRate.length - 1].name} (${pctS(byRate[byRate.length - 1].waRate as number, 2)}).`);

  // Plazo y vencimientos
  if (k.waTermMonths !== null) add('Plazo y vencimientos', 'info', `Plazo original ponderado ${k.waTermMonths.toFixed(1)} meses${k.waRemainingMonths !== null ? `; plazo remanente ponderado ${k.waRemainingMonths.toFixed(1)} meses` : ''}.`);
  if (a.maturing90.count || a.maturing12.balance) add('Plazo y vencimientos', a.maturing12.pct > RISK_THRESHOLDS.maturing12mWarn ? 'warn' : 'info', `Vencen en 90 días: ${moneyM(a.maturing90.balance)} (${a.maturing90.count} créditos); en 12 meses: ${moneyM(a.maturing12.balance)} (${pctS(a.maturing12.pct)} del saldo).`);
  if (a.endedWithBalance.count) add('Plazo y vencimientos', 'warn', `${a.endedWithBalance.count} crédito(s) ya pasaron su fecha de vencimiento y aún tienen saldo (${moneyM(a.endedWithBalance.balance)}).`);
  const peak = [...a.maturity].sort((x, y) => y.balance - x.balance)[0];
  if (peak && a.maturity.length > 1) add('Plazo y vencimientos', peak.pct > RISK_THRESHOLDS.maturityQuarterWarn ? 'warn' : 'info', `Mayor concentración de vencimientos en ${peak.quarter}: ${moneyM(peak.balance)} (${pctS(peak.pct)} del saldo).`);

  // Originación y maduración
  if (k.amortizadoPct !== null) add('Originación y maduración', 'info', `Monto original colocado ${moneyM(k.montoOriginal)}; saldo actual ${moneyM(k.saldo)} (${pctS(k.amortizadoPct)} ya amortizado).`);
  if (k.waAgeMonths !== null) add('Originación y maduración', 'info', `Antigüedad ponderada de la cartera: ${k.waAgeMonths.toFixed(1)} meses desde el otorgamiento.`);
  const lastM = a.originationMonthly[a.originationMonthly.length - 1];
  if (lastM) add('Originación y maduración', 'info', `Originación más reciente (${lastM.period}): ${moneyM(lastM.amount)} en ${lastM.count} créditos${lastM.growth !== null ? ` (${lastM.growth >= 0 ? '+' : ''}${(lastM.growth * 100).toFixed(0)}% vs. mes previo)` : ''}.`);

  // Saldo y calidad del dato
  if (a.prevKpi && a.prevKpi.saldo) {
    const d = (k.saldo - a.prevKpi.saldo) / a.prevKpi.saldo;
    add('Saldo', Math.abs(d) > 0.15 ? 'warn' : 'info', `Saldo ${moneyM(a.prevKpi.saldo)} → ${moneyM(k.saldo)} (${d >= 0 ? '+' : ''}${(d * 100).toFixed(1)}%); créditos ${a.prevKpi.creditos} → ${k.creditos}; clientes ${a.prevKpi.clientes} → ${k.clientes}.`);
  } else {
    add('Saldo', 'info', `Saldo ${moneyM(k.saldo)} en ${k.creditos} créditos y ${k.clientes} clientes (${a.focusLabel}). Sin corte previo para comparar.`);
  }
  const gaps = a.coverage.filter(c => c.pct < 0.95);
  if (gaps.length) add('Calidad del dato', gaps.some(g => g.pct < 0.5) ? 'warn' : 'info', `Campos incompletos: ${gaps.map(g => `${g.field} ${pctS(g.pct, 0)}`).join(' · ')}. Lo que falta limita los análisis que dependen de ese campo.`);
  return out;
}

// ── Excel sheet builder ───────────────────────────────────────────────────────

export type Cell = string | number | null | { __fmtNum: true; raw: string | number | null; fmt: string };
type Kind = 'title' | 'subheading' | 'headers' | 'data' | 'total' | 'blank' | 'pad';
export const F = (raw: string | number | null, fmt: string): Cell => ({ __fmtNum: true, raw, fmt });
export const FMT = { money: '$#,##0;[Red]($#,##0);-', int: '#,##0', pct: '0.0%', pct2: '0.00%', dec1: '0.0', dec2: '0.00', text: '' };
export type ColFmt = keyof typeof FMT | undefined;

export interface TableRef { sub: number; header: number; first: number; last: number; raw: any[][]; headers: string[] }

export class SheetBuilder {
  rows: Cell[][] = [];
  kinds: Kind[] = [];
  charts: ChartSpec[] = [];
  readonly chartCol: number;
  readonly widths: number[];
  constructor(readonly name: string, tableWidths: number[], readonly tab = AXC.deep) {
    this.chartCol = tableWidths.length + 1;
    this.widths = [...tableWidths, 3, ...Array(10).fill(11)];
  }
  get next() { return this.rows.length + 1; }
  push(row: Cell[], kind: Kind) { this.rows.push(row); this.kinds.push(kind); }
  title(t: string) { this.push([t], 'title'); }
  sub(t: string) { this.push([t], 'subheading'); }
  blank() { this.push([], 'blank'); }
  text(t: string) { this.push([t], 'data'); }
  ensure(rowCount: number) { while (this.rows.length < rowCount) this.push([], 'pad'); }
  table(title: string, headers: string[], raw: any[][], fmts: ColFmt[], total?: any[]): TableRef {
    const sub = this.next;
    this.sub(title);
    const header = this.next;
    this.push(headers, 'headers');
    const first = this.next;
    const wrap = (r: any[]) => r.map((c, i) => (typeof c === 'number' && fmts[i] ? F(c, FMT[fmts[i]!]) : c));
    raw.forEach(r => this.push(wrap(r), 'data'));
    const last = this.next - 1;
    if (total) this.push(wrap(total), 'total');
    return { sub, header, first, last, raw, headers };
  }
  chart(t: TableRef, o: {
    title: string; kind: ChartKind; cat?: number; grouping?: ChartGrouping; yFmt?: string; y2Fmt?: string; rows?: number; slot?: number; legend?: ChartSpec['legend']; gap?: number;
    series: Array<{ col: number; name?: string; as?: 'bar' | 'line'; secondary?: boolean; labels?: boolean; color?: string; pointColors?: string[]; fmt?: string }>;
  }) {
    if (t.last < t.first) return;
    const h = o.rows ?? 17;
    const cat = o.cat ?? 0;
    const catCache = t.raw.map(r => String(r[cat] ?? ''));
    const slot = o.slot ?? 0;
    this.charts.push({
      title: o.title, kind: o.kind, grouping: o.grouping, legend: o.legend, gapWidth: o.gap, yFmt: o.yFmt, y2Fmt: o.y2Fmt,
      categories: { sheet: this.name, col: cat + 1, rowStart: t.first, rowEnd: t.last }, categoryCache: catCache,
      series: o.series.map(s => ({
        name: s.name ?? t.headers[s.col], values: { sheet: this.name, col: s.col + 1, rowStart: t.first, rowEnd: t.last },
        cache: t.raw.map(r => (typeof r[s.col] === 'number' ? (r[s.col] as number) : null)),
        as: s.as, secondaryAxis: s.secondary, labels: s.labels, color: s.color, pointColors: s.pointColors, numFmt: s.fmt,
      })),
      anchor: { col: this.chartCol, row: t.sub - 1 + slot * (h + 1), cols: 9, rows: h },
    });
    this.ensure(t.sub - 1 + (slot + 1) * (h + 1) + 1);
  }
  done(extra: Partial<SheetDef> = {}): SheetDef {
    return { name: this.name, rows: this.rows as SheetDef['rows'], colWidths: this.charts.length ? this.widths : this.widths.slice(0, this.chartCol - 1), rowKinds: this.kinds, charts: this.charts, hideGridlines: true, tabColor: this.tab, freezeRows: 0, ...extra };
  }
}

const SEMANTIC_DPD = [AXC.green, '7BC043', AXC.amber, AXC.orange, AXC.red, AXC.darkRed];
const QUALITY_COLORS = [AXC.green, AXC.amber, AXC.red, '9AA5BD'];

export interface ReportPayload {
  data: CockpitData;
  vintage: Array<{ cohort: string; creditos: number; saldo: number; vigPct: number; atrPct: number; venPct: number; avgDpd: number | null }>;
  snapshot: any;
  focusPeriod: string;
  focusLabel: string;
  groupOverrides?: GroupOverrides;
}

export function buildLoanTapeReportSheets(clientName: string, selectedPeriods: string[], payload: ReportPayload): SheetDef[] {
  const { data, vintage, snapshot } = payload;
  const a = analyzePortfolio(data, payload.focusPeriod, payload.groupOverrides || {});
  if (!a) return [{ name: 'Resumen', rows: [['Sin datos de cartera para reportar.']] }];
  const insights = buildLoanTapeInsights(a, data, snapshot?.anomalies);
  const selSet = new Set(selectedPeriods);
  const sel = data.series.filter(s => selSet.has(s.period));
  const sheets: SheetDef[] = [];
  const k = a.kpi;
  const withRate = a.rateBuckets.length > 0;

  // 1 — Portada ---------------------------------------------------------------
  {
    const s = new SheetBuilder('Portada', [34, 20, 18, 16]);
    s.title(`REPORTE DE CARTERA — ${clientName.toUpperCase()}`);
    s.text(`Corte: ${a.focusLabel} · ${sel.length} corte(s) seleccionados de ${data.periods.length} · Generado por FinMonitor`);
    s.blank();
    const kp: Array<[string, number | null, ColFmt, number | null]> = [
      ['Saldo total', k.saldo, 'money', a.prevKpi?.saldo ?? null],
      ['Créditos', k.creditos, 'int', a.prevKpi?.creditos ?? null],
      ['Clientes', k.clientes, 'int', a.prevKpi?.clientes ?? null],
      ['Monto original colocado', k.montoOriginal, 'money', null],
      ['% amortizado', k.amortizadoPct, 'pct', null],
      ['Ticket promedio (saldo)', k.avgTicket, 'money', null],
      ['Tasa ponderada', k.waRate, 'pct2', a.prevKpi?.waRate ?? null],
      ['Tasa promedio simple', k.simpleRate, 'pct2', null],
      ['Plazo original ponderado (meses)', k.waTermMonths, 'dec1', null],
      ['Plazo remanente ponderado (meses)', k.waRemainingMonths, 'dec1', null],
      ['DPD ponderado (días)', k.waDpd, 'dec1', null],
      [`${QUALITY_LABELS.vigente} %`, a.quality[0].pct, 'pct', null],
      ['   de los cuales al corriente (0 días) %', a.dpd[0]?.pct ?? null, 'pct', null],
      [`${QUALITY_LABELS.atrasada} %`, a.quality[1].pct, 'pct', a.prevKpi?.atrasadaPct ?? null],
      [`${QUALITY_LABELS.vencida} %`, a.quality[2].pct, 'pct', a.prevKpi?.vencidaPct ?? null],
      ['Top 1 cliente %', a.topN[0]?.pct ?? null, 'pct', null],
      ['Top 10 clientes %', a.topN.find(t => t.label === 'Top 10')?.pct ?? null, 'pct', null],
      ['HHI (clientes)', a.hhi, 'dec2', null],
    ];
    s.table('INDICADORES CLAVE', ['Indicador', 'Valor', `Corte previo${a.prevLabel ? ` (${a.prevLabel})` : ''}`, 'Δ'],
      kp.map(([n, v, f, p]) => {
        const fmt = FMT[f || 'int'];
        const delta = v !== null && p !== null ? v - p : null;
        return [n, v === null ? 'N/D' : F(v, fmt), p === null ? '' : F(p, fmt), delta === null ? '' : F(delta, f === 'pct' || f === 'pct2' ? '+0.0%;-0.0%;0.0%' : fmt)];
      }), []);
    s.blank();
    // quality + dpd tables feed the two charts next to the KPIs
    const qt = s.table(`CALIDAD DE CARTERA (convención 0-${QUALITY_RULES.vigenteMaxDpd} / ${QUALITY_RULES.vigenteMaxDpd + 1}-${QUALITY_RULES.atrasadaMaxDpd} / ${QUALITY_RULES.atrasadaMaxDpd + 1}+ DPD)`, ['Clasificación', 'Créditos', 'Saldo', '% saldo'],
      a.quality.map(c => [c.label, c.count, c.balance, c.pct]), [undefined, 'int', 'money', 'pct'],
      ['TOTAL', k.creditos, k.saldo, 1]);
    s.chart(qt, { title: 'Calidad de cartera (% del saldo)', kind: 'doughnut', series: [{ col: 3, labels: true, pointColors: QUALITY_COLORS, fmt: '0.0%' }] });
    s.blank();
    const dt = s.table('DISTRIBUCIÓN POR DÍAS DE ATRASO (DPD)', ['Bucket DPD', 'Créditos', 'Saldo', '% saldo'], a.dpd.map(d => [d.bucket, d.count, d.balance, d.pct]), [undefined, 'int', 'money', 'pct'],
      ['TOTAL', a.dpd.reduce((x, d) => x + d.count, 0), a.dpd.reduce((x, d) => x + d.balance, 0), a.dpd.reduce((x, d) => x + d.pct, 0)]);
    s.chart(dt, { title: 'Saldo por bucket DPD', kind: 'column', series: [{ col: 2, labels: true, pointColors: SEMANTIC_DPD, fmt: '$#,##0' }], yFmt: '$#,##0' });
    sheets.push(s.done({ freezeRows: 0 }));
  }

  // 2 — Insights ---------------------------------------------------------------
  {
    const s = new SheetBuilder('Insights', [26, 12, 120], AXC.cyan);
    s.charts = [];
    s.title(`INSIGHTS DE CARTERA — ${a.focusLabel}`);
    s.text('Lectura automática y descriptiva (hechos, variaciones y umbrales). No sustituye el juicio crediticio.');
    s.blank();
    const ht = s.table('HALLAZGOS', ['Tema', 'Nivel', 'Detalle'], insights.map(i => [i.category, { alert: 'ALERTA', warn: 'ATENCIÓN', good: 'BIEN', info: 'INFO' }[i.level], i.text]), []);
    const pill: Record<InsightLevel, { fill: string; font: string }> = {
      alert: { fill: 'FDECEB', font: AXC.red }, warn: { fill: 'FFF4DB', font: '9A6B00' }, good: { fill: 'E4F7EC', font: AXC.green }, info: { fill: 'EAF0FF', font: AXC.deep },
    };
    sheets.push(s.done({
      wrapColumns: [3], freezeRows: 4,
      cellStyles: insights.map((i, idx) => ({ row: ht.first + idx, col: 2, ...pill[i.level] })),
    }));
  }

  // 3 — Concentraciones ---------------------------------------------------------
  {
    const s = new SheetBuilder('Concentraciones', [34, 12, 18, 12, 14, 14, 14]);
    s.title(`CONCENTRACIONES — ${a.focusLabel}`);
    s.blank();
    if (a.clients.length) {
      const ct = s.table('POR CLIENTE (Top 20)', ['Cliente', 'Créditos', 'Saldo', '% saldo', '% acumulado', '% vencida del cliente'], a.clients.map(c => [c.name, c.count, c.balance, c.pct, c.cumPct, c.venPct]), [undefined, 'int', 'money', 'pct', 'pct', 'pct']);
      s.chart(ct, { title: 'Concentración por cliente', kind: 'bar', series: [{ col: 2, labels: false, color: AXC.deep, fmt: '$#,##0' }], yFmt: '$#,##0', rows: Math.max(17, a.clients.length + 4) });
      s.blank();
      const tt = s.table('ACUMULADO TOP-N CLIENTES', ['Grupo', 'Créditos', 'Saldo', '% saldo', 'Monto original'], a.topN.map(t => [t.label, t.count, t.balance, t.pct, t.original]), [undefined, 'int', 'money', 'pct', 'money']);
      s.chart(tt, { title: 'Concentración acumulada Top-N', kind: 'column', series: [{ col: 3, labels: true, color: AXC.blue, fmt: '0.0%' }], yFmt: '0%' });
      s.blank();
    }
    if (a.groups.length) {
      const top = a.groups.slice(0, 15);
      const gt = s.table('POR GRUPO ECONÓMICO (Top 15; se infiere por nombre)', ['Grupo', 'Acreditados', 'Créditos', 'Saldo', '% saldo', 'Confianza', 'Miembros'],
        top.map(g => [g.name, g.members.length, g.loans, g.balance, g.pct, g.inferred ? g.confidence : 'individual', g.members.slice(0, 4).map(m => m.name).join(' + ')]), [undefined, 'int', 'int', 'money', 'pct']);
      s.chart(gt, { title: 'Concentración por grupo económico', kind: 'bar', series: [{ col: 3, color: AXC.deep, fmt: '$#,##0' }], yFmt: '$#,##0', rows: Math.max(15, top.length + 4) });
      s.blank();
    }
    const grp = (title: string, list: GroupRow[], chartTitle: string, color: string) => {
      if (!list.length) return;
      const t = s.table(title, ['Nombre', 'Créditos', 'Saldo', '% saldo', 'Tasa pond.', 'DPD prom.'], list.map(g => [g.name, g.count, g.balance, g.pct, g.waRate, g.avgDpd]), [undefined, 'int', 'money', 'pct', 'pct2', 'dec1']);
      s.chart(t, { title: chartTitle, kind: 'bar', series: [{ col: 2, color, fmt: '$#,##0' }], yFmt: '$#,##0', rows: Math.max(15, list.length + 4) });
      s.blank();
    };
    grp('POR PRODUCTO', a.products, 'Saldo por producto', AXC.deep);
    grp('POR GIRO / INDUSTRIA (Top 10)', a.industries, 'Saldo por giro', AXC.cyan);
    grp('POR ESTADO (Top 10)', a.states, 'Saldo por estado', AXC.blue);
    if (a.currencies.length > 1) grp('POR MONEDA', a.currencies, 'Saldo por moneda', AXC.sky);
    const sizeTable = (title: string, list: Bucket[], chartTitle: string) => {
      if (!list.length) return;
      const t = s.table(title, ['Rango', 'Créditos', 'Saldo', '% saldo', 'Tasa simple', 'Plazo prom. (m)', 'DPD prom.'], list.map(b => [b.label, b.count, b.balance, b.pct, b.avgRate, b.avgTerm, b.avgDpd]), [undefined, 'int', 'money', 'pct', 'pct2', 'dec1', 'dec1'],
        ['TOTAL', list.reduce((x, b) => x + b.count, 0), list.reduce((x, b) => x + b.balance, 0), list.reduce((x, b) => x + b.pct, 0)]);
      s.chart(t, { title: chartTitle, kind: 'column', series: [{ col: 2, color: AXC.deep, fmt: '$#,##0' }, { col: 3, as: 'line', secondary: true, color: AXC.cyan, fmt: '0.0%' }], yFmt: '$#,##0', y2Fmt: '0%', rows: 16 });
      s.blank();
    };
    sizeTable('BUCKETS DE TAMAÑO — SALDO VIGENTE (rangos iguales)', a.sizeOutstanding, 'Loan size buckets — saldo');
    sizeTable('BUCKETS DE TAMAÑO — MONTO ORIGINAL (rangos iguales)', a.sizeAmount, 'Loan size buckets — monto original');
    sizeTable('BUCKETS DE TAMAÑO — SALDO (igual # de créditos por bucket)', a.sizeCount, 'Buckets por # de créditos');
    sheets.push(s.done({ freezeRows: 0 }));
  }

  // 4 — Calidad y DPD -----------------------------------------------------------
  {
    const s = new SheetBuilder('Calidad y DPD', [30, 12, 18, 12, 12, 12]);
    s.title(`CALIDAD DE CARTERA Y DPD — ${a.focusLabel}`);
    s.blank();
    const dt = s.table('DISTRIBUCIÓN DPD (0 / 1-30 / 31-60 / 61-89 / 90-180 / >180)', ['Bucket', 'Créditos', 'Saldo', '% saldo'], a.dpd.map(d => [d.bucket, d.count, d.balance, d.pct]), [undefined, 'int', 'money', 'pct']);
    s.chart(dt, { title: 'Saldo y % por bucket DPD', kind: 'column', series: [{ col: 2, labels: true, pointColors: SEMANTIC_DPD, fmt: '$#,##0' }, { col: 3, as: 'line', secondary: true, color: AXC.deep, fmt: '0.0%' }], yFmt: '$#,##0', y2Fmt: '0%' });
    s.blank();
    const rec = reconcileQuality(a.rows);
    s.table('PUENTE DE DEFINICIONES: “AL CORRIENTE” vs. “VIGENTE”', ['Concepto', 'Créditos', 'Saldo', '% saldo'], rec.bridge.map(b => [b.label, null, b.balance, b.pct]), [undefined, 'int', 'money', 'pct']);
    s.blank();
    if (a.products.length) {
      const pt = s.table('CALIDAD POR PRODUCTO (% del saldo del producto)', ['Producto', 'Saldo', 'Vigente %', 'Atrasada %', 'Vencida %', 'DPD prom.'], a.products.map(p => [p.name, p.balance, p.vigPct, p.atrPct, p.venPct, p.avgDpd]), [undefined, 'money', 'pct', 'pct', 'pct', 'dec1']);
      s.chart(pt, { title: 'Morosidad por producto', kind: 'bar', grouping: 'percentStacked', series: [{ col: 2, name: 'Vigente', color: AXC.green }, { col: 3, name: 'Atrasada', color: AXC.amber }, { col: 4, name: 'Vencida', color: AXC.red }], yFmt: '0%', rows: Math.max(15, a.products.length + 6) });
      s.blank();
    }
    if (a.industries.length) {
      const it = s.table('CALIDAD POR GIRO', ['Giro', 'Saldo', 'Vigente %', 'Atrasada %', 'Vencida %', 'DPD prom.'], a.industries.map(p => [p.name, p.balance, p.vigPct, p.atrPct, p.venPct, p.avgDpd]), [undefined, 'money', 'pct', 'pct', 'pct', 'dec1']);
      s.chart(it, { title: 'Morosidad por giro', kind: 'bar', grouping: 'percentStacked', series: [{ col: 2, name: 'Vigente', color: AXC.green }, { col: 3, name: 'Atrasada', color: AXC.amber }, { col: 4, name: 'Vencida', color: AXC.red }], yFmt: '0%', rows: Math.max(15, a.industries.length + 6) });
      s.blank();
    }
    if (data.watchlist.length) {
      s.table('WATCHLIST — VENCIDOS CRÓNICOS (>90 DPD en 2+ cortes)', ['Crédito', 'Cliente', 'Cortes vencido', 'Máx DPD', 'Saldo actual'], data.watchlist.map(w => [w.loan_id, w.client, w.monthsOverdue, w.maxDpd, w.saldoActual]), [undefined, undefined, 'int', 'int', 'money']);
    }
    sheets.push(s.done({ freezeRows: 0 }));
  }

  // 5 — Tasas -------------------------------------------------------------------
  if (withRate || a.products.some(p => p.waRate !== null)) {
    const s = new SheetBuilder('Tasas', [34, 12, 18, 12, 14, 14, 14, 14]);
    s.title(`TASAS DE INTERÉS — ${a.focusLabel}`);
    s.blank();
    const rv = (v: number | null) => (v === null ? 'N/D' : F(v, FMT.pct2));
    s.table('ESTADÍSTICOS DE TASA', ['Métrica', 'Valor'], [
      ['Tasa ponderada por saldo', rv(k.waRate)], ['Tasa promedio simple', rv(k.simpleRate)], ['Mediana (tasa > 0)', rv(k.medianRate)],
      ['Percentil 25 (tasa > 0)', rv(k.p25Rate)], ['Percentil 75 (tasa > 0)', rv(k.p75Rate)], ['Mínima', rv(k.minRate)], ['Máxima', rv(k.maxRate)],
      ['Créditos con tasa 0% o vacía', F(k.zeroRateCount, FMT.int)], ['% de créditos con tasa 0% o vacía', F(k.zeroRatePct, FMT.pct)],
    ], []);
    s.blank();
    if (withRate) {
      const rt = s.table('DISTRIBUCIÓN POR RANGO DE TASA (5 rangos iguales)', ['Rango de tasa', 'Créditos', 'Saldo', '% saldo', 'Plazo prom. (m)', 'DPD prom.'], a.rateBuckets.map(b => [b.label, b.count, b.balance, b.pct, b.avgTerm, b.avgDpd]), [undefined, 'int', 'money', 'pct', 'dec1', 'dec1'],
        ['TOTAL', a.rateBuckets.reduce((x, b) => x + b.count, 0), a.rateBuckets.reduce((x, b) => x + b.balance, 0), a.rateBuckets.reduce((x, b) => x + b.pct, 0)]);
      s.chart(rt, { title: 'Saldo por rango de tasa', kind: 'column', series: [{ col: 2, color: AXC.deep, fmt: '$#,##0' }, { col: 3, as: 'line', secondary: true, color: AXC.cyan, fmt: '0.0%' }], yFmt: '$#,##0', y2Fmt: '0%' });
      s.blank();
    }
    if (a.products.length) {
      const pt = s.table('TASA POR PRODUCTO', ['Producto', 'Créditos', 'Saldo', 'Tasa pond.', 'Tasa simple', 'Plazo prom. (m)', 'Monto prom.', 'Monto máx.'], a.products.map(p => [p.name, p.count, p.balance, p.waRate, p.avgRate, p.avgTermMonths, p.avgAmount, p.maxAmount]), [undefined, 'int', 'money', 'pct2', 'pct2', 'dec1', 'money', 'money']);
      s.chart(pt, { title: 'Tasa ponderada por producto', kind: 'column', series: [{ col: 3, labels: true, color: AXC.deep, fmt: '0.0%' }], yFmt: '0%' });
      s.blank();
    }
    const dt = s.table('TASA POR CALIDAD DE CARTERA', ['Clasificación', 'Créditos', 'Saldo', 'Tasa pond.'], a.rateByDpd.map(r => [r.label, r.count, r.balance, r.waRate]), [undefined, 'int', 'money', 'pct2']);
    s.chart(dt, { title: 'Tasa ponderada: vigente vs. atrasada vs. vencida', kind: 'column', series: [{ col: 3, labels: true, pointColors: [AXC.green, AXC.amber, AXC.red], fmt: '0.0%' }], yFmt: '0%' });
    s.blank();
    if (a.sizeOutstanding.length) {
      const sz = s.table('TASA POR TAMAÑO DE CRÉDITO (saldo)', ['Rango', 'Créditos', 'Saldo', 'Tasa pond.', 'Tasa simple'], a.sizeOutstanding.map(b => [b.label, b.count, b.balance, b.waRate, b.avgRate]), [undefined, 'int', 'money', 'pct2', 'pct2']);
      s.chart(sz, { title: 'Tasa ponderada por tamaño de crédito', kind: 'column', series: [{ col: 3, labels: true, color: AXC.blue, fmt: '0.0%' }], yFmt: '0%' });
    }
    sheets.push(s.done({ freezeRows: 0 }));
  }

  // 6 — Plazos y vencimientos ---------------------------------------------------
  if (a.termBuckets.length || a.maturity.length) {
    const s = new SheetBuilder('Plazos y vencimientos', [34, 12, 18, 12, 14, 14]);
    s.title(`PLAZOS Y VENCIMIENTOS — ${a.focusLabel}`);
    s.blank();
    s.table('INDICADORES DE PLAZO', ['Métrica', 'Valor'], [
      ['Plazo original ponderado (meses)', k.waTermMonths === null ? 'N/D' : F(k.waTermMonths, FMT.dec1)],
      ['Plazo remanente ponderado (meses)', k.waRemainingMonths === null ? 'N/D' : F(k.waRemainingMonths, FMT.dec1)],
      ['Vencen en 90 días (saldo)', F(a.maturing90.balance, FMT.money)],
      ['Vencen en 12 meses (saldo)', F(a.maturing12.balance, FMT.money)],
      ['Vencidos por fecha con saldo (créditos)', F(a.endedWithBalance.count, FMT.int)],
      ['Vencidos por fecha con saldo (saldo)', F(a.endedWithBalance.balance, FMT.money)],
    ], []);
    s.blank();
    if (a.termBuckets.length) {
      const tt = s.table('DISTRIBUCIÓN POR PLAZO ORIGINAL', ['Rango de plazo', 'Créditos', 'Saldo', '% saldo', 'Tasa simple', 'DPD prom.'], a.termBuckets.map(b => [b.label, b.count, b.balance, b.pct, b.avgRate, b.avgDpd]), [undefined, 'int', 'money', 'pct', 'pct2', 'dec1']);
      s.chart(tt, { title: 'Saldo por plazo original', kind: 'column', series: [{ col: 2, color: AXC.deep, fmt: '$#,##0' }, { col: 3, as: 'line', secondary: true, color: AXC.cyan, fmt: '0.0%' }], yFmt: '$#,##0', y2Fmt: '0%' });
      s.blank();
    }
    if (a.maturity.length) {
      const mt = s.table('PERFIL DE VENCIMIENTOS POR TRIMESTRE', ['Trimestre', 'Créditos', 'Saldo', '% saldo'], a.maturity.map(m => [m.quarter, m.count, m.balance, m.pct]), [undefined, 'int', 'money', 'pct']);
      s.chart(mt, { title: 'Vencimientos próximos por trimestre', kind: 'column', series: [{ col: 2, color: AXC.deep, fmt: '$#,##0' }, { col: 3, as: 'line', secondary: true, color: AXC.cyan, fmt: '0.0%' }], yFmt: '$#,##0', y2Fmt: '0%' });
    }
    sheets.push(s.done({ freezeRows: 0 }));
  }

  // 7 — Originación y cosecha ---------------------------------------------------
  if (a.originationMonthly.length || vintage.length) {
    const s = new SheetBuilder('Originación y cosecha', [26, 12, 18, 14, 14, 14, 14]);
    s.title('ORIGINACIÓN Y COSECHA');
    s.blank();
    const origBlock = (title: string, list: PeriodRow[], chartTitle: string) => {
      if (!list.length) return;
      const t = s.table(title, ['Periodo', 'Créditos', 'Monto originado', 'Crecimiento'], list.map(p => [p.period, p.count, p.amount, p.growth]), [undefined, 'int', 'money', 'pct']);
      s.chart(t, { title: chartTitle, kind: 'column', series: [{ col: 2, color: AXC.deep, fmt: '$#,##0' }, { col: 3, as: 'line', secondary: true, color: AXC.cyan, fmt: '0%' }], yFmt: '$#,##0', y2Fmt: '0%' });
      s.blank();
    };
    origBlock('ORIGINACIÓN ANUAL', a.originationYearly, 'Originación anual — monto y crecimiento');
    origBlock('ORIGINACIÓN TRIMESTRAL', a.originationQuarterly, 'Originación trimestral — monto y crecimiento');
    origBlock('ORIGINACIÓN MENSUAL', a.originationMonthly, 'Originación mensual — monto y crecimiento');
    if (vintage.length) {
      const vt = s.table(`COSECHA POR AÑO DE ORIGINACIÓN — ${a.focusLabel}`, ['Cohorte', 'Créditos', 'Saldo', 'Vigente %', 'Atrasada %', 'Vencida %', 'DPD prom.'], vintage.map(v => [v.cohort, v.creditos, v.saldo, v.vigPct, v.atrPct, v.venPct, v.avgDpd]), [undefined, 'int', 'money', 'pct', 'pct', 'pct', 'dec1']);
      s.chart(vt, { title: 'Calidad por cosecha (% del saldo)', kind: 'column', grouping: 'percentStacked', series: [{ col: 3, name: 'Vigente', color: AXC.green }, { col: 4, name: 'Atrasada', color: AXC.amber }, { col: 5, name: 'Vencida', color: AXC.red }], yFmt: '0%' });
      s.chart(vt, { title: 'Saldo por cosecha', kind: 'column', series: [{ col: 2, color: AXC.deep, fmt: '$#,##0' }], yFmt: '$#,##0', slot: 1 });
    }
    sheets.push(s.done({ freezeRows: 0 }));
  }

  // 8 — Evolución (multi-corte) --------------------------------------------------
  if (sel.length >= 2) {
    const s = new SheetBuilder('Evolución', [14, 18, 11, 11, 13, 12, 12, 12, 10, 10, 10, 10, 18, 11]);
    s.title('EVOLUCIÓN MENSUAL DE LA CARTERA');
    s.blank();
    const raw = sel.map(p => [p.label, p.saldo, p.creditos, p.clientes, p.wa_rate, p.vigPct, p.atrPct, p.venPct, p.hhi, p.top1, p.top3, p.top10, p.over180, p.runoff] as Array<string | number | null>);
    const t = s.table('SERIE MENSUAL', ['Periodo', 'Saldo', 'Créditos', 'Clientes', 'Tasa pond.', 'Vigente %', 'Atrasada %', 'Vencida %', 'HHI', 'Top-1 %', 'Top-3 %', 'Top-10 %', 'Saldo >180 DPD', 'Variación saldo'], raw,
      [undefined, 'money', 'int', 'int', 'pct2', 'pct', 'pct', 'pct', 'dec2', 'pct', 'pct', 'pct', 'money', 'pct']);
    s.chart(t, { title: 'Saldo y % vencida', kind: 'column', series: [{ col: 1, color: AXC.deep, fmt: '$#,##0' }, { col: 7, as: 'line', secondary: true, color: AXC.red, fmt: '0.0%' }], yFmt: '$#,##0', y2Fmt: '0%' });
    s.chart(t, { title: 'Mezcla de calidad (% del saldo)', kind: 'column', grouping: 'percentStacked', series: [{ col: 5, name: 'Vigente', color: AXC.green }, { col: 6, name: 'Atrasada', color: AXC.amber }, { col: 7, name: 'Vencida', color: AXC.red }], yFmt: '0%', slot: 1 });
    s.chart(t, { title: 'Tasa ponderada', kind: 'line', series: [{ col: 4, color: AXC.deep, labels: true, fmt: '0.0%' }], yFmt: '0%', slot: 2 });
    s.chart(t, { title: 'Concentración: Top-1 / Top-3 / Top-10', kind: 'line', series: [{ col: 9, color: AXC.deep }, { col: 10, color: AXC.cyan }, { col: 11, color: AXC.blue }], yFmt: '0%', slot: 3 });
    s.chart(t, { title: 'Créditos y clientes', kind: 'line', series: [{ col: 2, color: AXC.deep }, { col: 3, color: AXC.cyan }], yFmt: '#,##0', slot: 4 });
    s.blank();
    const dpdRaw = sel.map(p => [p.label, ...p.dpdPct] as Array<string | number | null>);
    const dh = s.table('MAPA DE CALOR DPD (% del saldo por bucket)', ['Periodo', '0 días', '1-30', '31-60', '61-89', '90-180', '>180'], dpdRaw, [undefined, 'pct', 'pct', 'pct', 'pct', 'pct', 'pct']);
    s.chart(dh, { title: 'Distribución DPD por corte (% del saldo)', kind: 'column', grouping: 'percentStacked', series: [1, 2, 3, 4, 5, 6].map((c, i) => ({ col: c, color: SEMANTIC_DPD[i] })), yFmt: '0%', slot: 0, rows: 17 });
    s.blank();
    const mig = data.migration.filter(m => selSet.has(m.period));
    if (mig.length) {
      const mt = s.table('MIGRACIÓN Y ROLL-RATE', ['Periodo', 'Altas #', 'Altas $', 'Bajas #', 'Bajas $', 'Deteriorados', 'Curados', 'Empeoraron'], mig.map(m => [m.label, m.new_n, m.new_bal, m.gone_n, m.gone_bal, m.deteriorated, m.cured, m.worsened]), [undefined, 'int', 'money', 'int', 'money', 'int', 'int', 'int']);
      s.chart(mt, { title: 'Altas vs. bajas ($)', kind: 'column', series: [{ col: 2, name: 'Altas', color: AXC.deep }, { col: 4, name: 'Bajas', color: AXC.muted }], yFmt: '$#,##0' });
      s.chart(mt, { title: 'Roll-rate: deteriorados vs. curados (#)', kind: 'column', series: [{ col: 5, name: 'Deteriorados', color: AXC.red }, { col: 6, name: 'Curados', color: AXC.green }], yFmt: '#,##0', slot: 1 });
    }
    if (data.clientTrends.length) {
      s.blank();
      const ct = s.table('SALDO DE LOS 5 CLIENTES PRINCIPALES POR CORTE', ['Periodo', ...data.clientTrends.map(c => c.client)], data.periods.map((p, i) => ({ p, i })).filter(({ p }) => selSet.has(p)).map(({ i }) => [data.labels[i], ...data.clientTrends.map(c => c.values[i])] as Array<string | number | null>), [undefined, ...data.clientTrends.map(() => 'money' as ColFmt)]);
      s.chart(ct, { title: 'Tendencia de clientes principales', kind: 'line', series: data.clientTrends.map((c, i) => ({ col: i + 1, name: c.client, color: [AXC.deep, AXC.cyan, AXC.blue, AXC.sky, AXC.muted][i % 5] })), yFmt: '$#,##0' });
    }
    sheets.push(s.done({ freezeRows: 0, colorScales: [{ ref: `B${dh.first}:B${dh.last}`, color: AXC.green }, { ref: `C${dh.first}:G${dh.last}`, color: AXC.red }] }));
  }

  // 8b — Matriz de migración -----------------------------------------------------
  if (a.migration) {
    const mg = a.migration;
    const s = new SheetBuilder('Matriz de migración', [40, 12, 12, 12, 12, 12, 12, 12, 12, 14]);
    s.title(`MATRIZ DE MIGRACIÓN DE MORA — ${mg.fromLabel} → ${mg.toLabel}`);
    s.text('Renglón = bucket DPD en el corte previo; columna = bucket en el corte actual. “Salió” = ya no aparece (pagado, vendido, castigado o con otro ID); “Nuevo” = alta del mes.');
    s.blank();
    const heads = ['Bucket previo', ...mg.columns, 'Total'];
    const countRows = mg.rows.map((r, i) => [r, ...mg.cells[i].map(c => c.count), mg.rowTotals[i].count]);
    const ct = s.table('CRÉDITOS (#)', heads, countRows, [undefined, ...mg.columns.map(() => 'int' as ColFmt), 'int']);
    s.blank();
    const pctRows = mg.rows.map((r, i) => [r, ...mg.rollPct[i], mg.rowTotals[i].balance ? 1 : 0]);
    const pt = s.table('ROLL RATES (% del saldo previo de cada renglón)', heads, pctRows, [undefined, ...mg.columns.map(() => 'pct' as ColFmt), 'pct']);
    s.blank();
    s.table('RESUMEN', ['Indicador', 'Valor'], [
      ['Créditos que siguen (#)', F(mg.summary.matched, FMT.int)], ['Saldo igual de bucket', F(mg.summary.stablePct, FMT.pct)], ['Saldo que empeoró de bucket', F(mg.summary.worsePct, FMT.pct)], ['Saldo que mejoró de bucket', F(mg.summary.betterPct, FMT.pct)],
      ['Roll-in: 0 días → atraso (de los que siguen)', mg.summary.performingToDelinquentPct === null ? 'N/D' : F(mg.summary.performingToDelinquentPct, FMT.pct2)], ['Cura: atraso → 0 días', mg.summary.delinquentCurePct === null ? 'N/D' : F(mg.summary.delinquentCurePct, FMT.pct2)],
      ['Saldo que salió', F(mg.summary.exitBalance, FMT.money)], ['Saldo nuevo', F(mg.summary.newBalance, FMT.money)],
    ], []);
    const nCols = mg.columns.length;
    sheets.push(s.done({ freezeRows: 0, colorScales: [{ ref: `B${pt.first}:${String.fromCharCode(65 + nCols)}${pt.first + mg.rows.length - 1}`, color: AXC.deep }] }));
    void ct;
  }

  // 9 — Anomalías ---------------------------------------------------------------
  {
    const an = snapshot?.anomalies || {};
    const s = new SheetBuilder('Anomalías', [20, 18, 18, 18, 18]);
    s.title(`ANOMALÍAS — ${a.focusLabel} (vs. corte previo)`);
    s.blank();
    const block = (title: string, list: any[] | undefined, keys: string[], heads: string[], fmts: ColFmt[]) => {
      if (!list?.length) { s.sub(`${title} — sin registros`); s.blank(); return; }
      s.table(`${title} (${list.length})`, heads, list.slice(0, 200).map(r => keys.map(k2 => (r?.[k2] ?? null))), fmts);
      s.blank();
    };
    block('Créditos nuevos', an.new_loans, ['loan_id', 'outstanding_balance', 'start_date', 'category', 'percentage'], ['Crédito', 'Saldo', 'Fecha inicio', 'Categoría', '% cartera'], [undefined, 'money', undefined, undefined, 'pct2']);
    block('Deterioro de DPD', an.dpd_deterioration, ['loan_id', 'days_overdue_prev', 'days_overdue_latest', 'outstanding_balance'], ['Crédito', 'DPD previo', 'DPD actual', 'Saldo'], [undefined, 'int', 'int', 'money']);
    block('Mejora de DPD', an.dpd_improvement, ['loan_id', 'days_overdue_prev', 'days_overdue_latest', 'delta_days_overdue'], ['Crédito', 'DPD previo', 'DPD actual', 'Δ días'], [undefined, 'int', 'int', 'int']);
    block('Créditos que desaparecen', an.disappeared_loans, ['loan_id', 'outstanding_balance', 'end_date', 'category', 'days_overdue_prev'], ['Crédito', 'Saldo', 'Fecha venc.', 'Categoría', 'DPD previo'], [undefined, 'money', undefined, undefined, 'int']);
    block('Vencidos por fecha con saldo', an.ended_loans, ['loan_id', 'outstanding_balance', 'end_date', 'days_overdue'], ['Crédito', 'Saldo', 'Fecha venc.', 'DPD'], [undefined, 'money', undefined, 'int']);
    block('DPD inconsistente', an.dpd_inconsistency, ['loan_id', 'days_overdue_prev', 'days_overdue_latest', 'category'], ['Crédito', 'DPD previo', 'DPD actual', 'Motivo'], [undefined, 'int', 'int', undefined]);
    block('Cambios de condición', an.condition_changes, ['loan_id', 'field_changed', 'value_prev', 'value_latest'], ['Crédito', 'Campo', 'Valor previo', 'Valor actual'], []);
    sheets.push(s.done({ freezeRows: 0 }));
  }

  // 10 — Calidad del dato -------------------------------------------------------
  {
    const s = new SheetBuilder('Calidad del dato', [34, 16]);
    s.title('COBERTURA Y CALIDAD DEL DATO');
    s.blank();
    s.table(`COBERTURA DE CAMPOS — ${a.focusLabel}`, ['Campo', '% de créditos con dato'], a.coverage.map(c => [c.field, c.pct]), [undefined, 'pct']);
    const vr = (snapshot?.validation || []) as Array<{ loan_id: string; rule_id: string; field: string; message: string }>;
    if (vr.length) {
      s.blank();
      s.table(`VALIDACIONES (${vr.length})`, ['Crédito', 'Regla', 'Campo', 'Mensaje'], vr.slice(0, 300).map(v => [v.loan_id, v.rule_id, v.field, v.message]), []);
    }
    sheets.push(s.done({ freezeRows: 0 }));
  }

  // 10b — Definiciones y reglas de negocio ---------------------------------------
  {
    const s = new SheetBuilder('Definiciones', [46, 18, 70], AXC.muted);
    s.title('DEFINICIONES Y REGLAS DE NEGOCIO DE CARTERA');
    s.text('Las mismas reglas aplican en el dashboard, los insights, el score de riesgo y este Excel (módulo único portfolioRules).');
    s.blank();
    s.table('CLASIFICACIÓN DE CALIDAD POR DÍAS DE ATRASO (DPD)', ['Regla', '', ''], QUALITY_DEFINITION_LINES.map(l => [l, '', '']), []);
    s.blank();
    const rec = reconcileQuality(a.rows);
    s.table('VERIFICACIONES DE CONSISTENCIA', ['Verificación', 'Resultado', 'Detalle'], rec.checks.map(c => [c.rule, c.ok ? 'OK' : 'REVISAR', c.detail]), []);
    s.blank();
    const pctRule = (v: number) => `${(v * 100).toFixed(0)}%`;
    s.table('UMBRALES DE ALERTA', ['Indicador', 'Atención', 'Alerta'], [
      ['Cartera vencida (% saldo)', pctRule(RISK_THRESHOLDS.vencidaWarn), `> ${pctRule(RISK_THRESHOLDS.vencidaAlert)}`],
      ['Cartera atrasada (% saldo)', `> ${pctRule(RISK_THRESHOLDS.atrasadaWarn)}`, ''],
      ['Concentración del cliente #1', `> ${pctRule(RISK_THRESHOLDS.clientConcentrationWarn)}`, `> ${pctRule(RISK_THRESHOLDS.clientConcentrationAlert)}`],
      ['Concentración Top 10', `> ${pctRule(RISK_THRESHOLDS.top10Warn)}`, `> ${pctRule(RISK_THRESHOLDS.top10Alert)}`],
      ['HHI (clientes)', `> ${RISK_THRESHOLDS.hhiModerate}`, `> ${RISK_THRESHOLDS.hhiHigh}`],
      ['DPD ponderado (días)', `> ${RISK_THRESHOLDS.waDpdWarn}`, `> ${RISK_THRESHOLDS.waDpdAlert}`],
      ['Saldo sin DPD (% saldo)', `> ${pctRule(RISK_THRESHOLDS.missingDpdWarn)}`, `> ${pctRule(RISK_THRESHOLDS.missingDpdAlert)}`],
    ], []);
    sheets.push(s.done({ wrapColumns: [1, 3], freezeRows: 0 }));
  }

  // 11 — LT estandarizada -------------------------------------------------------
  {
    const rows = data.allRows.filter(r => !r.file_date || selSet.has(r.file_date));
    const heads = ['Fecha corte', 'Crédito', 'Cliente', 'Monto original', 'Saldo', 'Tasa', 'Estatus', 'Inicio', 'Vencimiento', 'Producto', 'DPD', 'Moneda', 'Giro', 'Estado'];
    const s = new SheetBuilder('LT Estandarizada', [12, 16, 34, 16, 16, 10, 14, 12, 12, 22, 8, 9, 18, 16], AXC.muted);
    s.title('LOAN TAPE ESTANDARIZADA (cortes seleccionados)');
    s.blank();
    s.table('DETALLE', heads, rows.map(r => [r.file_date, r.loan_id, r.client, r.amount, r.outstanding_balance, r.interest_rate, r.loan_status, r.start_date, r.end_date, r.loan_type, r.days_overdue, r.currency, r.industry, r.state]),
      [undefined, undefined, undefined, 'money', 'money', 'pct2', undefined, undefined, undefined, undefined, 'int', undefined, undefined, undefined]);
    sheets.push(s.done({ freezeRows: 4 }));
  }

  return sheets;
}

