import type { InstitutionalLiability_DB } from '../db/index';

export const LIABILITY_TYPE_LABELS: Record<string, string> = {
  linea_credito: 'Línea de Crédito',
  prestamo_simple: 'Préstamo Simple',
  bono: 'Bono / Instrumento Bursátil',
  otro: 'Otro',
};

export interface LiabilitiesSummary {
  count: number;
  totalOriginalAmount: number;
  totalCurrentBalance: number;
  weightedAverageRate: number | null;
  averageUtilization: number | null;
  nextMaturity: { lenderName: string; maturityDate: string; currentBalance: number | null } | null;
  lenderCount: number;
  missingMaturityCount: number;
  missingRateCount: number;
  foreignCurrencyBalance: number;
  shortTermBalance: number;
}

function sumBy<T>(items: T[], get: (item: T) => number | null): number {
  return items.reduce((sum, item) => {
    const v = get(item);
    return v === null || !Number.isFinite(v) ? sum : sum + v;
  }, 0);
}

export function buildLiabilitiesSummary(liabilities: InstitutionalLiability_DB[]): LiabilitiesSummary {
  const totalOriginalAmount = sumBy(liabilities, l => l.originalAmount);
  const totalCurrentBalance = sumBy(liabilities, l => l.currentBalance);

  const rateWeighted = liabilities.filter(l => l.currentBalance !== null && l.interestRate !== null);
  const rateWeightSum = sumBy(rateWeighted, l => l.currentBalance);
  const weightedAverageRate = rateWeightSum > 0
    ? rateWeighted.reduce((sum, l) => sum + (l.currentBalance as number) * (l.interestRate as number), 0) / rateWeightSum
    : null;

  const utilizationEntries = liabilities
    .filter(l => l.originalAmount !== null && l.originalAmount > 0 && l.currentBalance !== null)
    .map(l => (l.currentBalance as number) / (l.originalAmount as number));
  const averageUtilization = utilizationEntries.length
    ? utilizationEntries.reduce((sum, v) => sum + v, 0) / utilizationEntries.length
    : null;

  const withMaturity = liabilities
    .filter(l => l.maturityDate)
    .sort((a, b) => (a.maturityDate as string).localeCompare(b.maturityDate as string));
  const nextMaturity = withMaturity.length
    ? { lenderName: withMaturity[0].lenderName, maturityDate: withMaturity[0].maturityDate as string, currentBalance: withMaturity[0].currentBalance }
    : null;

  const lenderCount = new Set(liabilities.map(l => l.lenderName.trim().toLowerCase())).size;
  const missingMaturityCount = liabilities.filter(l => !l.maturityDate).length;
  const missingRateCount = liabilities.filter(l => l.interestRate === null && !l.rateDescription).length;
  const foreignCurrencyBalance = sumBy(liabilities.filter(l => (l.currency || 'MXN') !== 'MXN'), l => l.currentBalance);
  const oneYearOut = new Date();
  oneYearOut.setFullYear(oneYearOut.getFullYear() + 1);
  const shortTermBalance = sumBy(liabilities.filter(l => {
    if (!l.maturityDate) return false;
    const d = new Date(l.maturityDate);
    return Number.isFinite(d.getTime()) && d <= oneYearOut;
  }), l => l.currentBalance);

  return {
    count: liabilities.length,
    totalOriginalAmount,
    totalCurrentBalance,
    weightedAverageRate,
    averageUtilization,
    nextMaturity,
    lenderCount,
    missingMaturityCount,
    missingRateCount,
    foreignCurrencyBalance,
    shortTermBalance,
  };
}

export interface LiabilityInsight {
  severity: 'info' | 'warning' | 'critical';
  title: string;
  detail: string;
  recommendation: string;
}

export interface ConcentrationRow {
  key: string;
  currentBalance: number;
  pctOfTotal: number;
  count: number;
}

function concentrationBy(liabilities: InstitutionalLiability_DB[], keyOf: (l: InstitutionalLiability_DB) => string): ConcentrationRow[] {
  const total = sumBy(liabilities, l => l.currentBalance);
  const groups = new Map<string, { currentBalance: number; count: number }>();
  liabilities.forEach(l => {
    const key = keyOf(l) || 'Sin dato';
    const bucket = groups.get(key) || { currentBalance: 0, count: 0 };
    bucket.currentBalance += l.currentBalance ?? 0;
    bucket.count += 1;
    groups.set(key, bucket);
  });
  return Array.from(groups.entries())
    .map(([key, { currentBalance, count }]) => ({ key, currentBalance, count, pctOfTotal: total > 0 ? currentBalance / total : 0 }))
    .sort((a, b) => b.currentBalance - a.currentBalance);
}

export function buildLenderConcentration(liabilities: InstitutionalLiability_DB[]): ConcentrationRow[] {
  return concentrationBy(liabilities, l => l.lenderName);
}

export function buildTypeConcentration(liabilities: InstitutionalLiability_DB[]): ConcentrationRow[] {
  return concentrationBy(liabilities, l => LIABILITY_TYPE_LABELS[l.liabilityType] || l.liabilityType);
}

export function buildCurrencyConcentration(liabilities: InstitutionalLiability_DB[]): ConcentrationRow[] {
  return concentrationBy(liabilities, l => l.currency || 'MXN');
}

export function buildLiabilitiesInsights(liabilities: InstitutionalLiability_DB[]): LiabilityInsight[] {
  const summary = buildLiabilitiesSummary(liabilities);
  if (!liabilities.length) return [];

  const insights: LiabilityInsight[] = [];
  const lenders = buildLenderConcentration(liabilities);
  const topLender = lenders[0];
  const fxPct = summary.totalCurrentBalance > 0 ? summary.foreignCurrencyBalance / summary.totalCurrentBalance : 0;
  const shortTermPct = summary.totalCurrentBalance > 0 ? summary.shortTermBalance / summary.totalCurrentBalance : 0;

  if (topLender && topLender.pctOfTotal >= 0.5) {
    insights.push({
      severity: topLender.pctOfTotal >= 0.7 ? 'critical' : 'warning',
      title: 'Concentración de fondeo',
      detail: `${topLender.key} concentra ${(topLender.pctOfTotal * 100).toFixed(1)}% del saldo institucional.`,
      recommendation: 'Validar dependencia del acreedor principal, covenants cruzados y plan de refinanciamiento alterno.',
    });
  }

  if (shortTermPct >= 0.25) {
    insights.push({
      severity: shortTermPct >= 0.5 ? 'critical' : 'warning',
      title: 'Vencimientos próximos',
      detail: `${formatMoney(summary.shortTermBalance)} vence dentro de los próximos 12 meses (${(shortTermPct * 100).toFixed(1)}% del saldo).`,
      recommendation: 'Pedir calendario de amortización y evidencia de renovación/refinanciamiento para los créditos relevantes.',
    });
  }

  if (fxPct >= 0.1) {
    insights.push({
      severity: fxPct >= 0.3 ? 'critical' : 'warning',
      title: 'Exposición cambiaria',
      detail: `${formatMoney(summary.foreignCurrencyBalance)} está denominado en moneda distinta a MXN (${(fxPct * 100).toFixed(1)}% del saldo).`,
      recommendation: 'Revisar cobertura natural, derivados o ingresos en la misma moneda antes de asumir capacidad de pago estable.',
    });
  }

  if (summary.weightedAverageRate !== null && summary.weightedAverageRate >= 0.18) {
    insights.push({
      severity: 'warning',
      title: 'Costo financiero elevado',
      detail: `La tasa ponderada estimada es ${formatPercent(summary.weightedAverageRate)}.`,
      recommendation: 'Comparar contra margen financiero/costo de fondeo histórico y detectar líneas que presionen rentabilidad.',
    });
  }

  const today = new Date().toISOString().slice(0, 10);
  const overdue = liabilities.filter(l => l.maturityDate && l.maturityDate < today && (l.currentBalance ?? 0) > 0);
  if (overdue.length) {
    insights.push({
      severity: 'critical',
      title: 'Facilities con vencimiento pasado',
      detail: `${overdue.length} facility(ies) con fecha de vencimiento ya cumplida y saldo ${formatMoney(sumBy(overdue, l => l.currentBalance))}: ${overdue.map(l => l.lenderName).join(', ')}.`,
      recommendation: 'Confirmar si se renovaron (actualizar fecha) o si hay un incumplimiento con el fondeador.',
    });
  }

  if (summary.missingMaturityCount || summary.missingRateCount) {
    insights.push({
      severity: 'info',
      title: 'Datos por completar',
      detail: `${summary.missingMaturityCount} filas sin vencimiento y ${summary.missingRateCount} sin tasa o referencia.`,
      recommendation: 'Completar vencimiento, tasa y garantía para mejorar el calendario de liquidez y el análisis de sensibilidad.',
    });
  }

  if (!insights.length) {
    insights.push({
      severity: 'info',
      title: 'Estructura sin alertas automáticas',
      detail: 'No se detectaron concentraciones, vencimientos o exposiciones relevantes con los umbrales actuales.',
      recommendation: 'Validar manualmente covenants, garantías y restricciones contractuales de cada facility.',
    });
  }

  return insights;
}

export interface MaturityBucket {
  year: number;
  currentBalance: number;
  count: number;
}

// Buckets by calendar year of maturity, plus a trailing "sin fecha" bucket
// (year 0) for facilities missing a maturity date, so nothing silently drops
// out of the total.
export function buildMaturityLadder(liabilities: InstitutionalLiability_DB[]): MaturityBucket[] {
  const buckets = new Map<number, { currentBalance: number; count: number }>();
  liabilities.forEach(l => {
    const year = l.maturityDate ? new Date(l.maturityDate).getFullYear() : 0;
    const bucket = buckets.get(year) || { currentBalance: 0, count: 0 };
    bucket.currentBalance += l.currentBalance ?? 0;
    bucket.count += 1;
    buckets.set(year, bucket);
  });
  return Array.from(buckets.entries())
    .map(([year, { currentBalance, count }]) => ({ year, currentBalance, count }))
    .sort((a, b) => (a.year === 0 ? 1 : b.year === 0 ? -1 : a.year - b.year));
}

export function formatMoney(value: number | null, currency = 'MXN'): string {
  if (value === null || !Number.isFinite(value)) return 'N/A';
  return value.toLocaleString('es-MX', { maximumFractionDigits: 0 }) + (currency !== 'MXN' ? ` ${currency}` : '');
}

export function formatPercent(value: number | null, decimals = 1): string {
  if (value === null || !Number.isFinite(value)) return 'N/A';
  return `${(value * 100).toFixed(decimals)}%`;
}

// ── Bulk-upload column mapping ───────────────────────────────────────────────
// A client's institutional funding sources are a short, manually-curatable
// list (typically 5-30 rows), unlike a retail loan tape's thousands of rows —
// so this is a light direct-synonym mapper rather than loanTapeAnalytics'
// fuzzy/scored matcher. Column order in the source file doesn't matter; header
// wording does, within the synonym list below.
const HEADER_SYNONYMS: Record<string, string[]> = {
  lenderName: ['acreedor', 'institucion', 'institucion financiera', 'banco', 'lender', 'otorgante', 'fondeador'],
  liabilityType: ['tipo', 'tipo de pasivo', 'tipo de credito', 'producto'],
  originalAmount: ['monto original', 'monto otorgado', 'linea', 'linea de credito', 'monto', 'importe original'],
  currentBalance: ['saldo actual', 'saldo', 'saldo insoluto', 'saldo vigente'],
  currency: ['moneda'],
  interestRate: ['tasa', 'tasa de interes', 'tasa anual', 'rate'],
  rateDescription: ['formula de tasa', 'tasa descripcion', 'referencia de tasa'],
  originationDate: ['fecha de originacion', 'fecha de firma', 'fecha de otorgamiento', 'fecha origen'],
  maturityDate: ['fecha de vencimiento', 'vencimiento', 'fecha vencimiento'],
  amortization: ['amortizacion', 'periodicidad', 'esquema de pago'],
  guarantee: ['garantia', 'garantias'],
  notes: ['notas', 'comentarios', 'observaciones'],
};

function normalizeHeader(h: string): string {
  return h.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function pickColumn(headers: string[], field: keyof typeof HEADER_SYNONYMS): string | null {
  const synonyms = HEADER_SYNONYMS[field];
  const normalizedHeaders = headers.map(h => ({ raw: h, norm: normalizeHeader(h) }));
  for (const syn of synonyms) {
    const hit = normalizedHeaders.find(h => h.norm === syn);
    if (hit) return hit.raw;
  }
  for (const syn of synonyms) {
    const hit = normalizedHeaders.find(h => h.norm.includes(syn));
    if (hit) return hit.raw;
  }
  return null;
}

// Excel serial dates arrive as numbers when a sheet cell is formatted as a
// date; everything else arrives as whatever string the source file used.
function parseCellDate(value: unknown): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value === 'number') {
    const ms = Math.round((value - 25569) * 86400 * 1000);
    const d = new Date(ms);
    return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : undefined;
  }
  const parsed = new Date(String(value));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : undefined;
}

function parseCellNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return value;
  const cleaned = String(value).replace(/[^0-9.,%-]/g, '').replace(/,/g, '');
  const n = parseFloat(cleaned);
  if (!Number.isFinite(n)) return null;
  return String(value).includes('%') ? n / 100 : n;
}

function parseCellRate(value: unknown): number | null {
  const n = parseCellNumber(value);
  if (n === null) return null;
  if (String(value).includes('%')) return n;
  return n > 1 && n <= 100 ? n / 100 : n;
}

export interface ParsedLiabilityRow {
  lenderName: string;
  liabilityType: 'linea_credito' | 'prestamo_simple' | 'bono' | 'otro';
  originalAmount: number | null;
  currentBalance: number | null;
  currency: string;
  interestRate: number | null;
  rateDescription?: string;
  originationDate?: string;
  maturityDate?: string;
  amortization?: string;
  guarantee?: string;
  notes?: string;
}

function guessLiabilityType(raw: unknown): ParsedLiabilityRow['liabilityType'] {
  const n = normalizeHeader(String(raw ?? ''));
  if (/bono|bursatil|cebur/.test(n)) return 'bono';
  if (/simple/.test(n)) return 'prestamo_simple';
  if (/linea|revolvente|cuenta corriente/.test(n)) return 'linea_credito';
  return 'otro';
}

export function parseLiabilitiesRows(rows: Record<string, unknown>[]): { parsed: ParsedLiabilityRow[]; unmatchedFields: string[] } {
  if (!rows.length) return { parsed: [], unmatchedFields: Object.keys(HEADER_SYNONYMS) };
  const headers = Object.keys(rows[0]);
  const columnFor = Object.fromEntries(
    (Object.keys(HEADER_SYNONYMS) as Array<keyof typeof HEADER_SYNONYMS>).map(field => [field, pickColumn(headers, field)]),
  ) as Record<keyof typeof HEADER_SYNONYMS, string | null>;
  const unmatchedFields = (Object.keys(columnFor) as Array<keyof typeof HEADER_SYNONYMS>).filter(f => !columnFor[f]);

  const parsed = rows
    .map(row => {
      const lenderCol = columnFor.lenderName;
      const lenderName = lenderCol ? String(row[lenderCol] ?? '').trim() : '';
      if (!lenderName) return null;
      return {
        lenderName,
        liabilityType: columnFor.liabilityType ? guessLiabilityType(row[columnFor.liabilityType]) : 'otro',
        originalAmount: columnFor.originalAmount ? parseCellNumber(row[columnFor.originalAmount]) : null,
        currentBalance: columnFor.currentBalance ? parseCellNumber(row[columnFor.currentBalance]) : null,
        currency: columnFor.currency ? String(row[columnFor.currency] ?? 'MXN').trim().toUpperCase() || 'MXN' : 'MXN',
        interestRate: columnFor.interestRate ? parseCellRate(row[columnFor.interestRate]) : null,
        rateDescription: columnFor.rateDescription ? (String(row[columnFor.rateDescription] ?? '').trim() || undefined) : undefined,
        originationDate: columnFor.originationDate ? parseCellDate(row[columnFor.originationDate]) : undefined,
        maturityDate: columnFor.maturityDate ? parseCellDate(row[columnFor.maturityDate]) : undefined,
        amortization: columnFor.amortization ? (String(row[columnFor.amortization] ?? '').trim() || undefined) : undefined,
        guarantee: columnFor.guarantee ? (String(row[columnFor.guarantee] ?? '').trim() || undefined) : undefined,
        notes: columnFor.notes ? (String(row[columnFor.notes] ?? '').trim() || undefined) : undefined,
      } as ParsedLiabilityRow;
    })
    .filter((r): r is ParsedLiabilityRow => r !== null);

  return { parsed, unmatchedFields };
}

// ── Cockpit / reporte (espejo del análisis de loan tapes) ────────────────────
// A diferencia del loan tape no hay cortes históricos: todo se calcula sobre el
// listado vigente de facilities, a la fecha `asOf`. El calendario proyectado
// asume amortización lineal de capital hasta el vencimiento según el texto de
// `amortization`; sin esquema reconocible (o línea revolvente) se trata como
// bullet, que es el supuesto conservador para riesgo de refinanciamiento.

export type AmortizationScheme = 'bullet' | 'mensual' | 'trimestral' | 'semestral' | 'anual';

export function amortizationScheme(l: InstitutionalLiability_DB): AmortizationScheme {
  const n = normalizeHeader(l.amortization || '');
  if (/mensual/.test(n)) return 'mensual';
  if (/trimes/.test(n)) return 'trimestral';
  if (/semes/.test(n)) return 'semestral';
  if (/anual/.test(n)) return 'anual';
  return 'bullet';
}

const SCHEME_STEP: Record<AmortizationScheme, number> = { bullet: 0, mensual: 1, trimestral: 3, semestral: 6, anual: 12 };

function monthsUntil(asOf: Date, date?: string): number | null {
  if (!date) return null;
  const d = new Date(date);
  if (!Number.isFinite(d.getTime())) return null;
  return (d.getTime() - asOf.getTime()) / (86400000 * 30.44);
}

export interface LenderRow {
  lender: string;
  facilities: number;
  originalAmount: number;
  currentBalance: number;
  pctOfTotal: number;
  cumPct: number;
  waRate: number | null;
  annualInterest: number;
  utilization: number | null;
  nextMaturity: string | null;
}

export interface BucketRow { label: string; count: number; currentBalance: number; pctOfTotal: number; waRate: number | null }

export interface ScheduleRow { label: string; principal: number; endingBalance: number; pctOfTotal: number }

export interface FacilityRow {
  liability: InstitutionalLiability_DB;
  typeLabel: string;
  utilization: number | null;
  available: number | null;
  remainingMonths: number | null;
  annualInterest: number | null;
  scheme: AmortizationScheme;
  status: 'vigente' | 'vence_12m' | 'vencida' | 'sin_fecha';
}

export interface DataGap { lender: string; missing: string[] }

export interface LiabilitiesKpis {
  totalBalance: number;
  totalOriginal: number;
  available: number;
  utilization: number | null;
  waRate: number | null;
  annualInterest: number;
  waRemainingMonths: number | null;
  due12mBalance: number;
  due12mPct: number;
  overdueBalance: number;
  top1Pct: number;
  top3Pct: number;
  hhi: number;
  lenders: number;
  facilities: number;
  fxPct: number;
}

export interface LiabilitiesAnalysis {
  asOf: string;
  kpi: LiabilitiesKpis;
  lenders: LenderRow[];
  topN: Array<{ label: string; currentBalance: number; pctOfTotal: number }>;
  byType: BucketRow[];
  byCurrency: BucketRow[];
  byGuarantee: BucketRow[];
  byScheme: BucketRow[];
  rateBuckets: BucketRow[];
  termBuckets: BucketRow[];
  maturityByYear: BucketRow[];
  maturityByQuarter: ScheduleRow[];
  monthlySchedule: ScheduleRow[];
  facilities: FacilityRow[];
  dataGaps: DataGap[];
  unscheduledBalance: number;
}

function bucketize(
  liabilities: InstitutionalLiability_DB[],
  defs: Array<{ label: string; test: (l: InstitutionalLiability_DB) => boolean }>,
  total: number,
): BucketRow[] {
  return defs.map(def => {
    const members = liabilities.filter(def.test);
    const bal = sumBy(members, l => l.currentBalance);
    const rated = members.filter(l => l.interestRate !== null && (l.currentBalance ?? 0) > 0);
    const rw = sumBy(rated, l => l.currentBalance);
    return {
      label: def.label,
      count: members.length,
      currentBalance: bal,
      pctOfTotal: total > 0 ? bal / total : 0,
      waRate: rw > 0 ? rated.reduce((s, l) => s + (l.currentBalance as number) * (l.interestRate as number), 0) / rw : null,
    };
  }).filter(b => b.count > 0);
}

function groupBuckets(liabilities: InstitutionalLiability_DB[], keyOf: (l: InstitutionalLiability_DB) => string, total: number): BucketRow[] {
  const keys = Array.from(new Set(liabilities.map(l => keyOf(l) || 'Sin dato')));
  return bucketize(liabilities, keys.map(k => ({ label: k, test: l => (keyOf(l) || 'Sin dato') === k })), total)
    .sort((a, b) => b.currentBalance - a.currentBalance);
}

// Principal due per month (index 0 = vencido/mes en curso) for the next `horizon` months.
function projectPrincipal(l: InstitutionalLiability_DB, asOf: Date, horizon: number): number[] | null {
  const bal = l.currentBalance ?? 0;
  const out = Array(horizon).fill(0);
  if (bal <= 0) return out;
  const remaining = monthsUntil(asOf, l.maturityDate);
  if (remaining === null) return null;
  const lastIdx = Math.max(0, Math.ceil(remaining));
  const step = SCHEME_STEP[amortizationScheme(l)];
  if (!step || lastIdx === 0) {
    if (lastIdx < horizon) out[lastIdx] += bal;
    return out;
  }
  const payments: number[] = [];
  for (let m = lastIdx; m >= 1; m -= step) payments.push(m);
  const each = bal / payments.length;
  payments.forEach(m => { if (m < horizon) out[m] += each; });
  return out;
}

const MONTHS_ES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

export function analyzeLiabilities(liabilities: InstitutionalLiability_DB[], asOf: Date = new Date()): LiabilitiesAnalysis {
  const total = sumBy(liabilities, l => l.currentBalance);
  const summary = buildLiabilitiesSummary(liabilities);

  const facilities: FacilityRow[] = liabilities.map((l): FacilityRow => {
    const remainingMonths = monthsUntil(asOf, l.maturityDate);
    const hasOriginal = l.originalAmount !== null && l.originalAmount > 0;
    return {
      liability: l,
      typeLabel: LIABILITY_TYPE_LABELS[l.liabilityType] || l.liabilityType,
      utilization: hasOriginal && l.currentBalance !== null ? l.currentBalance / (l.originalAmount as number) : null,
      available: hasOriginal && l.liabilityType === 'linea_credito' && l.currentBalance !== null ? Math.max(0, (l.originalAmount as number) - l.currentBalance) : null,
      remainingMonths,
      annualInterest: l.currentBalance !== null && l.interestRate !== null ? l.currentBalance * l.interestRate : null,
      scheme: amortizationScheme(l),
      status: remainingMonths === null ? 'sin_fecha' : remainingMonths < 0 ? 'vencida' : remainingMonths <= 12 ? 'vence_12m' : 'vigente',
    };
  }).sort((a, b) => (b.liability.currentBalance ?? 0) - (a.liability.currentBalance ?? 0));

  // Lenders
  const lenderMap = new Map<string, InstitutionalLiability_DB[]>();
  liabilities.forEach(l => {
    const key = l.lenderName.trim();
    lenderMap.set(key, [...(lenderMap.get(key) || []), l]);
  });
  let cum = 0;
  const lenders: LenderRow[] = Array.from(lenderMap.entries())
    .map(([lender, rows]) => {
      const bal = sumBy(rows, l => l.currentBalance);
      const orig = sumBy(rows, l => l.originalAmount);
      const rated = rows.filter(l => l.interestRate !== null && (l.currentBalance ?? 0) > 0);
      const rw = sumBy(rated, l => l.currentBalance);
      const maturities = rows.map(l => l.maturityDate).filter(Boolean).sort() as string[];
      return {
        lender, facilities: rows.length, originalAmount: orig, currentBalance: bal,
        pctOfTotal: total > 0 ? bal / total : 0, cumPct: 0,
        waRate: rw > 0 ? rated.reduce((s, l) => s + (l.currentBalance as number) * (l.interestRate as number), 0) / rw : null,
        annualInterest: sumBy(rows, l => (l.currentBalance !== null && l.interestRate !== null ? l.currentBalance * l.interestRate : null)),
        utilization: orig > 0 ? bal / orig : null,
        nextMaturity: maturities[0] || null,
      };
    })
    .sort((a, b) => b.currentBalance - a.currentBalance)
    .map(r => { cum += r.pctOfTotal; return { ...r, cumPct: cum }; });

  const topN = [1, 3, 5, 10].filter(n => n === 1 || lenders.length > n - 1).map(n => {
    const bal = lenders.slice(0, n).reduce((s, r) => s + r.currentBalance, 0);
    return { label: `Top ${n}`, currentBalance: bal, pctOfTotal: total > 0 ? bal / total : 0 };
  });
  const hhi = lenders.reduce((s, r) => s + r.pctOfTotal ** 2, 0);

  const rateBuckets = bucketize(liabilities, [
    { label: '< 10%', test: l => l.interestRate !== null && l.interestRate < 0.10 },
    { label: '10% – 12%', test: l => l.interestRate !== null && l.interestRate >= 0.10 && l.interestRate < 0.12 },
    { label: '12% – 14%', test: l => l.interestRate !== null && l.interestRate >= 0.12 && l.interestRate < 0.14 },
    { label: '14% – 16%', test: l => l.interestRate !== null && l.interestRate >= 0.14 && l.interestRate < 0.16 },
    { label: '16% – 18%', test: l => l.interestRate !== null && l.interestRate >= 0.16 && l.interestRate < 0.18 },
    { label: '≥ 18%', test: l => l.interestRate !== null && l.interestRate >= 0.18 },
    { label: 'Sin tasa', test: l => l.interestRate === null },
  ], total);

  const rem = (l: InstitutionalLiability_DB) => monthsUntil(asOf, l.maturityDate);
  const termBuckets = bucketize(liabilities, [
    { label: 'Vencida', test: l => { const m = rem(l); return m !== null && m < 0; } },
    { label: '0 – 6 meses', test: l => { const m = rem(l); return m !== null && m >= 0 && m <= 6; } },
    { label: '6 – 12 meses', test: l => { const m = rem(l); return m !== null && m > 6 && m <= 12; } },
    { label: '1 – 2 años', test: l => { const m = rem(l); return m !== null && m > 12 && m <= 24; } },
    { label: '2 – 3 años', test: l => { const m = rem(l); return m !== null && m > 24 && m <= 36; } },
    { label: '3 – 5 años', test: l => { const m = rem(l); return m !== null && m > 36 && m <= 60; } },
    { label: '> 5 años', test: l => { const m = rem(l); return m !== null && m > 60; } },
    { label: 'Sin fecha', test: l => rem(l) === null },
  ], total);

  const maturityByYear = buildMaturityLadder(liabilities).map(b => ({
    label: b.year === 0 ? 'Sin fecha' : String(b.year), count: b.count, currentBalance: b.currentBalance,
    pctOfTotal: total > 0 ? b.currentBalance / total : 0, waRate: null,
  }));

  // Projected principal runoff (36 months)
  const HORIZON = 37;
  const monthly = Array(HORIZON).fill(0);
  let unscheduledBalance = 0;
  liabilities.forEach(l => {
    const p = projectPrincipal(l, asOf, HORIZON);
    if (!p) { unscheduledBalance += l.currentBalance ?? 0; return; }
    p.forEach((v, i) => { monthly[i] += v; });
  });
  let running = total;
  const monthlySchedule: ScheduleRow[] = monthly.map((principal, i) => {
    running -= principal;
    const d = new Date(asOf.getFullYear(), asOf.getMonth() + i, 1);
    return {
      label: i === 0 ? `Vencido / ${MONTHS_ES[d.getMonth()]}-${String(d.getFullYear()).slice(2)}` : `${MONTHS_ES[d.getMonth()]}-${String(d.getFullYear()).slice(2)}`,
      principal, endingBalance: Math.max(0, running), pctOfTotal: total > 0 ? principal / total : 0,
    };
  });
  const maturityByQuarter: ScheduleRow[] = [];
  for (let q = 0; q < 8; q++) {
    const slice = monthly.slice(q === 0 ? 0 : q * 3 + 1, q * 3 + 4);
    const principal = slice.reduce((s, v) => s + v, 0);
    const end = monthlySchedule[Math.min(q * 3 + 3, HORIZON - 1)].endingBalance;
    const d = new Date(asOf.getFullYear(), asOf.getMonth() + q * 3 + 1, 1);
    maturityByQuarter.push({ label: `T${q + 1} (${MONTHS_ES[d.getMonth()]}-${String(d.getFullYear()).slice(2)})`, principal, endingBalance: end, pctOfTotal: total > 0 ? principal / total : 0 });
  }

  const byScheme = groupBuckets(liabilities, l => {
    const s = amortizationScheme(l);
    return s === 'bullet' ? (l.amortization ? 'Bullet / al vencimiento' : 'Sin esquema (bullet supuesto)') : s.charAt(0).toUpperCase() + s.slice(1);
  }, total);

  const dataGaps: DataGap[] = liabilities.map(l => ({
    lender: l.lenderName,
    missing: [
      l.currentBalance === null ? 'saldo' : '',
      l.originalAmount === null ? 'monto original' : '',
      l.interestRate === null && !l.rateDescription ? 'tasa' : '',
      !l.maturityDate ? 'vencimiento' : '',
      !l.amortization ? 'amortización' : '',
      !l.guarantee ? 'garantía' : '',
    ].filter(Boolean),
  })).filter(g => g.missing.length);

  const withTerm = facilities.filter(f => f.remainingMonths !== null && (f.liability.currentBalance ?? 0) > 0);
  const termWeight = withTerm.reduce((s, f) => s + (f.liability.currentBalance as number), 0);
  const ratedOriginal = liabilities.filter(l => l.originalAmount !== null && l.originalAmount > 0 && l.currentBalance !== null);
  const origForUtil = sumBy(ratedOriginal, l => l.originalAmount);

  return {
    asOf: asOf.toISOString().slice(0, 10),
    kpi: {
      totalBalance: total,
      totalOriginal: summary.totalOriginalAmount,
      available: facilities.reduce((s, f) => s + (f.available ?? 0), 0),
      utilization: origForUtil > 0 ? sumBy(ratedOriginal, l => l.currentBalance) / origForUtil : null,
      waRate: summary.weightedAverageRate,
      annualInterest: facilities.reduce((s, f) => s + (f.annualInterest ?? 0), 0),
      waRemainingMonths: termWeight > 0 ? withTerm.reduce((s, f) => s + Math.max(0, f.remainingMonths as number) * (f.liability.currentBalance as number), 0) / termWeight : null,
      due12mBalance: summary.shortTermBalance,
      due12mPct: total > 0 ? summary.shortTermBalance / total : 0,
      overdueBalance: facilities.filter(f => f.status === 'vencida').reduce((s, f) => s + (f.liability.currentBalance ?? 0), 0),
      top1Pct: lenders[0]?.pctOfTotal ?? 0,
      top3Pct: topN.find(t => t.label === 'Top 3')?.pctOfTotal ?? lenders.reduce((s, r) => s + r.pctOfTotal, 0),
      hhi,
      lenders: lenders.length,
      facilities: liabilities.length,
      fxPct: total > 0 ? summary.foreignCurrencyBalance / total : 0,
    },
    lenders,
    topN,
    byType: groupBuckets(liabilities, l => LIABILITY_TYPE_LABELS[l.liabilityType] || l.liabilityType, total),
    byCurrency: groupBuckets(liabilities, l => l.currency || 'MXN', total),
    byGuarantee: groupBuckets(liabilities, l => (l.guarantee || '').trim() || 'Sin garantía registrada', total),
    byScheme,
    rateBuckets,
    termBuckets,
    maturityByYear,
    maturityByQuarter,
    monthlySchedule,
    facilities,
    dataGaps,
    unscheduledBalance,
  };
}
