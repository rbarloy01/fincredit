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
