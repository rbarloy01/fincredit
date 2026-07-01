const BUILTIN_MAPPINGS: Array<{ re: RegExp; metric: string; confidence: number; label: string }> = [
  { re: /ingreso|ventas|margenfinanciero|interesesganados|ingresosfinancieros/, metric: 'revenue', confidence: 0.82, label: 'Coincide con ingresos/ventas' },
  { re: /costo|costodeventas|costosfinancieros/, metric: 'cogs', confidence: 0.72, label: 'Coincide con costo/costo de ventas' },
  { re: /gastoadministr|gastosgenerales|gastooper|opex/, metric: 'operatingExpenses', confidence: 0.78, label: 'Coincide con gastos operativos' },
  { re: /ebitda|uafida/, metric: 'ebitda', confidence: 0.94, label: 'Coincide con EBITDA/UAFIDA' },
  { re: /gastofinancier|gastoporinteres|interesespagados|costofondeo/, metric: 'interestExpense', confidence: 0.86, label: 'Coincide con gasto financiero/intereses' },
  { re: /utilidadneta|resultadoneto|perdidaneta/, metric: 'netIncome', confidence: 0.9, label: 'Coincide con utilidad neta/resultado neto' },
  { re: /activocirculante|activocorriente|activocorto|disponibilidades|efectivo|bancos|carteracreditoneta/, metric: 'currentAssets', confidence: 0.72, label: 'Coincide con activo corriente/disponibilidades' },
  { re: /pasivocirculante|pasivocorriente|pasivocorto/, metric: 'currentLiabilities', confidence: 0.86, label: 'Coincide con pasivo corriente' },
  { re: /deudatotal|pasivoconcosto|prestamosbancarios|creditobancario|deudabancaria/, metric: 'totalDebt', confidence: 0.84, label: 'Coincide con deuda/pasivo con costo' },
  { re: /activototal|totalactivo/, metric: 'totalAssets', confidence: 0.9, label: 'Coincide con total activo' },
  { re: /capitalcontable|patrimonio|capitaltotal|totalcapital/, metric: 'equity', confidence: 0.9, label: 'Coincide con capital/patrimonio' },
];

export function normalizeAccount(value?: string) {
  return (value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

export function parseFinancialNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const raw = String(value ?? '').trim();
  if (!raw || /^[-–—]$/.test(raw)) return null;
  const negative = /^\(.*\)$/.test(raw) || /^-/.test(raw);
  let cleaned = raw
    .replace(/[()$%]/g, '')
    .replace(/\s/g, '')
    .replace(/[^\d,.-]/g, '');
  if (!cleaned) return null;
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  if (lastComma > lastDot) cleaned = cleaned.replace(/\./g, '').replace(',', '.');
  else cleaned = cleaned.replace(/,/g, '');
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) return null;
  return negative ? -Math.abs(parsed) : parsed;
}

export function suggestMetric(accountName: string) {
  const normalized = normalizeAccount(accountName);
  for (const mapping of BUILTIN_MAPPINGS) {
    if (mapping.re.test(normalized)) return { metric: mapping.metric, confidence: mapping.confidence, reason: mapping.label };
  }
  return { metric: 'extraAccounts', confidence: 0.35, reason: 'Sin coincidencia clara; se conserva como cuenta adicional' };
}

function likelyAccount(value: unknown) {
  const text = String(value ?? '').trim();
  if (text.length < 3) return false;
  return /[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/.test(text) && parseFinancialNumber(text) === null;
}

function periodFromHeader(value: unknown) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const year = text.match(/\b20\d{2}\b/)?.[0];
  if (!year) return '';
  const q = text.match(/\b([1-4])\s?[TQ]\b/i)?.[1];
  if (q) return `${q}T${year}`;
  const month = text.match(/\b(ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic|jan|apr|aug|dec|0?[1-9]|1[0-2])\b/i)?.[1];
  return month ? `${month}-${year}` : year;
}

export type FinancialCandidate = {
  accountName: string;
  value: number;
  rowNumber: number;
  columnNumber: number;
  period: string;
  metric: string;
  confidence: number;
  certainty: {
    score: number;
    level: 'high' | 'medium' | 'low';
    signals: string[];
    warnings: string[];
  };
};

function clampScore(value: number) {
  return Math.max(0.05, Math.min(0.99, Number(value.toFixed(2))));
}

function certaintyLevel(score: number): FinancialCandidate['certainty']['level'] {
  if (score >= 0.82) return 'high';
  if (score >= 0.58) return 'medium';
  return 'low';
}

function evaluateCandidateCertainty(args: {
  accountName: string;
  cell: unknown;
  metric: string;
  metricConfidence: number;
  metricReason: string;
  period: string;
  accountIndex: number;
  columnIndex: number;
  rowWidth: number;
  duplicateAccountCount: number;
}) {
  const signals: string[] = [args.metricReason];
  const warnings: string[] = [];
  let score = args.metricConfidence;

  if (args.period) {
    score += 0.08;
    signals.push(`Periodo detectado: ${args.period}`);
  } else {
    score -= 0.12;
    warnings.push('No se detecto periodo en el encabezado de la columna');
  }

  if (args.accountIndex <= 1) {
    score += 0.04;
    signals.push('La cuenta aparece al inicio del renglon');
  } else {
    score -= 0.04;
    warnings.push('La etiqueta de cuenta no esta en las primeras columnas');
  }

  if (args.columnIndex > args.accountIndex) {
    score += 0.03;
    signals.push('El valor aparece a la derecha de la cuenta');
  } else {
    score -= 0.05;
    warnings.push('El valor aparece antes de la cuenta');
  }

  const rawCell = String(args.cell ?? '').trim();
  if (/[$%,]/.test(rawCell) || /\d/.test(rawCell)) {
    score += 0.03;
    signals.push('La celda tiene formato numerico reconocible');
  }

  if (args.metric === 'extraAccounts') {
    score -= 0.1;
    warnings.push('La metrica sugerida requiere clasificacion manual');
  }

  if (args.accountName.length < 5) {
    score -= 0.1;
    warnings.push('Nombre de cuenta muy corto');
  }

  if (args.rowWidth > 8 && !args.period) {
    score -= 0.08;
    warnings.push('Renglon amplio sin periodo detectado; puede ser tabla multicolumna');
  }

  if (args.duplicateAccountCount > 1) {
    score -= 0.04;
    warnings.push('La cuenta aparece varias veces en la tabla');
  }

  const finalScore = clampScore(score);
  return {
    score: finalScore,
    level: certaintyLevel(finalScore),
    signals,
    warnings,
  };
}

export function extractFinancialCandidates(rows: any[][]): FinancialCandidate[] {
  const candidates: FinancialCandidate[] = [];
  const header = rows.slice(0, 8).find(row => row.some(periodFromHeader)) || [];
  const periodsByColumn = new Map<number, string>();
  header.forEach((cell, index) => {
    const period = periodFromHeader(cell);
    if (period) periodsByColumn.set(index, period);
  });

  const accountCounts = new Map<string, number>();
  rows.forEach(row => {
    const accountIndex = row.findIndex(likelyAccount);
    if (accountIndex < 0) return;
    const normalized = normalizeAccount(String(row[accountIndex]).trim());
    accountCounts.set(normalized, (accountCounts.get(normalized) || 0) + 1);
  });

  rows.forEach((row, rowIndex) => {
    const accountIndex = row.findIndex(likelyAccount);
    if (accountIndex < 0) return;
    const accountName = String(row[accountIndex]).trim();
    const suggestion = suggestMetric(accountName);
    const duplicateAccountCount = accountCounts.get(normalizeAccount(accountName)) || 1;

    row.forEach((cell, columnIndex) => {
      if (columnIndex === accountIndex) return;
      const value = parseFinancialNumber(cell);
      if (value === null) return;
      const period = periodsByColumn.get(columnIndex) || '';
      const certainty = evaluateCandidateCertainty({
        accountName,
        cell,
        metric: suggestion.metric,
        metricConfidence: suggestion.confidence,
        metricReason: suggestion.reason,
        period,
        accountIndex,
        columnIndex,
        rowWidth: row.length,
        duplicateAccountCount,
      });
      candidates.push({
        accountName,
        value,
        rowNumber: rowIndex + 1,
        columnNumber: columnIndex + 1,
        period,
        metric: suggestion.metric,
        confidence: certainty.score,
        certainty,
      });
    });
  });

  return candidates;
}
