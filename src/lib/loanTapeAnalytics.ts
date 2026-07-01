import { LoanTape_DB } from '../db/index';
import { StructuredLoanTapeAnalysis } from '../services/ai';
import { parseNullableFinancialNumber } from './numberParsing';

export interface StandardLoan {
  loan_id: string | null;
  client: string | null;
  amount: number | null;
  outstanding_balance: number | null;
  interest_rate: number | null;
  loan_status: string | null;
  start_date: string | null;
  end_date: string | null;
  loan_type: string | null;
  days_overdue: number | null;
  currency: string | null;
  industry: string | null;
  state: string | null;
  file_date: string | null;
}

export interface MappingNote {
  source_header: string;
  target_term: keyof StandardLoan;
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
}

export interface LoanTapeExportContext {
  tape: LoanTape_DB;
  standardizedRows: StandardLoan[];
  mappingReport: MappingNote[];
  profile: ReturnType<typeof buildLoanTapeDataProfile>;
  analysis: StructuredLoanTapeAnalysis;
}

type Severity = 'high' | 'medium' | 'low';

const CRITICAL_FIELDS: Array<keyof StandardLoan> = ['loan_id', 'client', 'amount', 'outstanding_balance', 'interest_rate', 'loan_type', 'days_overdue', 'start_date', 'end_date'];

const SYNONYMS: Record<keyof StandardLoan, string[]> = {
  loan_id: ['contrato', 'loan id', 'loan number', 'loan no', 'folio', 'numero credito', 'no contrato', 'id prestamo', 'operacion'],
  client: ['cliente', 'client', 'customer', 'razon social', 'nombre', 'client id', 'apellidos'],
  amount: ['amount', 'loan amount', 'lended amount', 'principal', 'original amount', 'monto original', 'monto otorgado', 'monto maximo', 'costo'],
  outstanding_balance: ['capital balance', 'saldo capital', 'saldo insoluto', 'capital por pagar', 'saldo insoluto capital'],
  interest_rate: ['interest rate', 'tasa', 'tasa interes', 'rate', 'rate %'],
  loan_status: ['status', 'estado', 'loan status', 'estatus'],
  start_date: ['start date', 'origination date', 'fecha inicio', 'fecha otorgamiento', 'disbursement date'],
  end_date: ['end date', 'maturity date', 'fecha vencimiento', 'fecha fin', 'due date'],
  loan_type: ['loan type', 'producto', 'product', 'product type', 'tipo contrato', 'tipo credito', 'tipo prestamo', 'tipo producto', 'linea', 'modalidad', 'subproducto', 'segmento', 'programa', 'plan', 'esquema'],
  days_overdue: ['days overdue', 'days past due', 'dpd', 'mora dias', 'dias atraso', 'dias de atraso', 'dias vencidos', 'delinquent days'],
  currency: ['currency', 'moneda', 'divisa'],
  industry: ['industry', 'giro', 'sector', 'industria'],
  state: ['state', 'provincia', 'estado residencia', 'estado de residencia', 'region'],
  file_date: ['file date', 'fecha archivo', 'fecha corte', 'fecha reporte'],
};

const PAID_STATUSES = ['paid', 'fully paid', 'paid off', 'closed', 'canceled', 'cancelled', 'liquidated', 'liquidado', 'pagado'];

function normalize(value: any): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[%#]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function parseNumber(value: any): number | null {
  return parseNullableFinancialNumber(value);
}

function excelSerialToDate(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 20000 || serial > 80000) return null;
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  return new Date(ms).toISOString().slice(0, 10);
}

function parseDate(value: any): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return excelSerialToDate(value);
  const raw = String(value).trim();
  if (!raw) return null;
  const direct = raw.match(/(20\d{2})[-/_.](\d{1,2})[-/_.](\d{1,2})/);
  if (direct) return `${direct[1]}-${direct[2].padStart(2, '0')}-${direct[3].padStart(2, '0')}`;
  const mx = raw.match(/(\d{1,2})[-/_.](\d{1,2})[-/_.](20\d{2})/);
  if (mx) return `${mx[3]}-${mx[2].padStart(2, '0')}-${mx[1].padStart(2, '0')}`;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function parseFileDate(fileName?: string): string | null {
  const raw = fileName || '';
  const ymd = raw.match(/(20\d{2})[-_. ]?(\d{2})[-_. ]?(\d{2})/);
  if (ymd) return `${ymd[1]}-${ymd[2]}-${ymd[3]}`;
  const yymmdd = raw.match(/\b(\d{2})[-_. ]?(\d{2})[-_. ]?(\d{2})\b/);
  if (yymmdd) {
    const year = Number(yymmdd[1]) >= 70 ? `19${yymmdd[1]}` : `20${yymmdd[1]}`;
    return `${year}-${yymmdd[2]}-${yymmdd[3]}`;
  }
  return null;
}

function pickColumns(headers: string[]) {
  const mapping: Partial<Record<keyof StandardLoan, string>> = {};
  const notes: MappingNote[] = [];
  const used = new Set<string>();
  const normalized = headers.map(h => ({ header: h, norm: normalize(h) }));

  const capitalVigente = normalized.find(h => h.norm.includes('capital vigente'))?.header;
  const capitalVencido = normalized.find(h => h.norm.includes('capital vencido'))?.header;

  for (const target of Object.keys(SYNONYMS) as Array<keyof StandardLoan>) {
    if (target === 'file_date') continue;
    if (target === 'outstanding_balance' && capitalVigente && capitalVencido) continue;
    const terms = SYNONYMS[target].map(normalize);
    const exact = normalized.find(h => !used.has(h.header) && terms.includes(h.norm));
    const fuzzy = exact || normalized.find(h => !used.has(h.header) && terms.some(t => h.norm.includes(t) || t.includes(h.norm)));
    if (fuzzy) {
      mapping[target] = fuzzy.header;
      used.add(fuzzy.header);
      notes.push({ source_header: fuzzy.header, target_term: target, confidence: exact ? 'high' : 'medium', reasoning: 'Header matched loan tape synonym' });
    }
  }

  if (capitalVigente && capitalVencido) {
    notes.push({ source_header: `${capitalVigente} + ${capitalVencido}`, target_term: 'outstanding_balance', confidence: 'high', reasoning: 'Prioritized sum of capital vigente and capital vencido' });
  }

  return { mapping, notes, capitalVigente, capitalVencido };
}

export function standardizeLoanTape(rows: any[], fileName?: string) {
  const headers = rows[0] ? Object.keys(rows[0]) : [];
  const { mapping, notes, capitalVigente, capitalVencido } = pickColumns(headers);
  const fallbackFileDate = parseFileDate(fileName);

  const standardized: StandardLoan[] = rows.map(row => {
    const get = (key: keyof StandardLoan) => mapping[key] ? row[mapping[key] as string] : null;
    const capitalA = capitalVigente ? parseNumber(row[capitalVigente]) : null;
    const capitalB = capitalVencido ? parseNumber(row[capitalVencido]) : null;
    const balance = capitalA !== null || capitalB !== null
      ? (capitalA || 0) + (capitalB || 0)
      : parseNumber(get('outstanding_balance'));

    return {
      loan_id: get('loan_id') ? String(get('loan_id')).trim() : null,
      client: get('client') ? String(get('client')).trim() : null,
      amount: parseNumber(get('amount')),
      outstanding_balance: balance,
      interest_rate: parseNumber(get('interest_rate')),
      loan_status: get('loan_status') ? String(get('loan_status')).trim() : null,
      start_date: parseDate(get('start_date')),
      end_date: parseDate(get('end_date')),
      loan_type: get('loan_type') ? String(get('loan_type')).trim() : null,
      days_overdue: parseNumber(get('days_overdue')),
      currency: get('currency') ? String(get('currency')).trim() : 'MXN',
      industry: get('industry') ? String(get('industry')).trim() : null,
      state: get('state') ? String(get('state')).trim() : null,
      file_date: parseDate(get('file_date')) || fallbackFileDate,
    };
  }).filter(row => Object.values(row).some(v => v !== null && v !== ''));

  return { standardized, mappingReport: notes };
}

function activeRows(rows: StandardLoan[]) {
  return rows.filter(r => !PAID_STATUSES.includes(normalize(r.loan_status)));
}

function latestRows(rows: StandardLoan[]) {
  const dates = Array.from(new Set(rows.map(r => r.file_date).filter(Boolean) as string[])).sort();
  const latest = dates[dates.length - 1] || null;
  return { latest, rows: latest ? rows.filter(r => r.file_date === latest) : rows };
}

function latestAndPreviousRows(rows: StandardLoan[]) {
  const dates = Array.from(new Set(rows.map(r => r.file_date).filter(Boolean) as string[])).sort();
  const latest = dates[dates.length - 1] || null;
  const previous = dates[dates.length - 2] || null;
  if (!latest) return { latest: null, previous: null, latestRows: rows, previousRows: [] as StandardLoan[] };
  return {
    latest,
    previous,
    latestRows: rows.filter(r => r.file_date === latest),
    previousRows: previous ? rows.filter(r => r.file_date === previous) : [] as StandardLoan[],
  };
}

function sum(rows: StandardLoan[]) {
  return rows.reduce((acc, r) => acc + (r.outstanding_balance || 0), 0);
}

function pct(value: number, total: number) {
  return total > 0 ? value / total : 0;
}

function fmtMoney(value: number) {
  return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }).format(value);
}

function fmtPct(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function trend(current: number, previous: number, higherIsWorse = false) {
  if (!Number.isFinite(previous) || previous === 0 || Math.abs(current - previous) < 0.000001) return 'stable';
  const up = current > previous;
  if (higherIsWorse) return up ? 'down' : 'up';
  return up ? 'up' : 'down';
}

function fmtChange(current: number, previous: number, kind: 'money' | 'pct' | 'number') {
  if (!Number.isFinite(previous) || previous === 0) return undefined;
  const delta = current - previous;
  if (kind === 'money') return `${delta >= 0 ? '+' : ''}${fmtMoney(delta)}`;
  if (kind === 'pct') return `${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)} pp`;
  return `${delta >= 0 ? '+' : ''}${delta.toFixed(0)}`;
}

function quality(rows: StandardLoan[]) {
  const total = sum(rows);
  const groups = {
    vigente: rows.filter(r => r.days_overdue !== null && r.days_overdue === 0),
    atrasada: rows.filter(r => r.days_overdue !== null && r.days_overdue >= 1 && r.days_overdue <= 90),
    vencida: rows.filter(r => r.days_overdue !== null && r.days_overdue > 90),
    sin_dato: rows.filter(r => r.days_overdue === null),
  };
  return Object.fromEntries(Object.entries(groups).map(([k, v]) => {
    const balance = sum(v);
    return [k, { count: v.length, balance, pct: pct(balance, total) }];
  }));
}

function dpdDistribution(rows: StandardLoan[]) {
  const total = sum(rows);
  const buckets = [
    { bucket: '0 dias', min: 0, max: 0 },
    { bucket: '1-30', min: 1, max: 30 },
    { bucket: '31-60', min: 31, max: 60 },
    { bucket: '61-90', min: 61, max: 90 },
    { bucket: '91-180', min: 91, max: 180 },
    { bucket: '>180', min: 181, max: Infinity },
  ];
  const distribution = buckets.map(b => {
    const items = rows.filter(r => r.days_overdue !== null && r.days_overdue >= b.min && r.days_overdue <= b.max);
    const balance = sum(items);
    return { bucket: b.bucket, count: items.length, balance, pct: pct(balance, total) };
  });
  const missing = rows.filter(r => r.days_overdue === null);
  if (missing.length) {
    const balance = sum(missing);
    distribution.push({ bucket: 'Sin dato', count: missing.length, balance, pct: pct(balance, total) });
  }
  return distribution;
}

function groupBy(rows: StandardLoan[], field: keyof StandardLoan, limit = 10) {
  const total = sum(rows);
  const map = new Map<string, StandardLoan[]>();
  for (const row of rows) {
    const key = String(row[field] || '').trim();
    if (!key || ['total', 'top', 'otros'].includes(normalize(key))) continue;
    map.set(key, [...(map.get(key) || []), row]);
  }
  return Array.from(map.entries())
    .map(([name, items]) => {
      const balance = sum(items);
      return {
        name,
        count: items.length,
        balance,
        pct: pct(balance, total),
        severity: field === 'client' && pct(balance, total) > 0.2 ? 'high' : field === 'client' && pct(balance, total) > 0.1 ? 'medium' : 'low',
      };
    })
    .sort((a, b) => b.balance - a.balance)
    .slice(0, limit);
}

function weightedAverage(rows: StandardLoan[], field: 'days_overdue' | 'interest_rate') {
  const usable = rows.filter(row => row[field] !== null && Number.isFinite(row[field]) && (row.outstanding_balance || 0) > 0);
  const weight = sum(usable);
  if (!weight) return null;
  return usable.reduce((total, row) => total + Number(row[field]) * (row.outstanding_balance || 0), 0) / weight;
}

function topShare(rows: StandardLoan[], count: number) {
  const total = sum(rows);
  const largest = [...rows]
    .sort((a, b) => (b.outstanding_balance || 0) - (a.outstanding_balance || 0))
    .slice(0, count);
  return pct(sum(largest), total);
}

function loanTypeProfile(rows: StandardLoan[]) {
  const total = sum(rows);
  const map = new Map<string, StandardLoan[]>();
  for (const row of rows) {
    const key = String(row.loan_type || '').trim();
    if (!key) continue;
    map.set(key, [...(map.get(key) || []), row]);
  }
  return Array.from(map.entries()).map(([name, items]) => {
    const balance = sum(items);
    const avg = (field: keyof StandardLoan) => {
      const values = items.map(i => Number(i[field])).filter(Number.isFinite);
      return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
    };
    const terms = items.map(i => {
      if (!i.start_date || !i.end_date) return null;
      const a = new Date(i.start_date).getTime();
      const b = new Date(i.end_date).getTime();
      return Number.isFinite(a) && Number.isFinite(b) ? (b - a) / (86400 * 1000 * 30.44) : null;
    }).filter((v): v is number => v !== null);
    return {
      name,
      count: items.length,
      balance,
      pct: pct(balance, total),
      avg_interest_rate: avg('interest_rate'),
      avg_term_months: terms.length ? terms.reduce((a, b) => a + b, 0) / terms.length : null,
      avg_days_overdue: avg('days_overdue'),
      min_amount: Math.min(...items.map(i => i.amount || 0).filter(v => v > 0)),
      max_amount: Math.max(...items.map(i => i.amount || 0).filter(v => v > 0)),
      avg_amount: avg('amount'),
    };
  }).sort((a, b) => b.balance - a.balance);
}

function buckets(rows: StandardLoan[], field: 'amount' | 'outstanding_balance') {
  const values = rows.map(r => r[field]).filter((v): v is number => v !== null && Number.isFinite(v));
  if (!values.length) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const hi = min === max ? min + 1 : max;
  const total = rows.reduce((acc, row) => acc + (row[field] || 0), 0);
  return Array.from({ length: 5 }, (_, i) => {
    const lo = min + i * (hi - min) / 5;
    const upper = min + (i + 1) * (hi - min) / 5;
    const items = rows.filter(r => {
      const value = r[field];
      return value !== null && value >= lo && (i === 4 ? value <= upper : value < upper);
    });
    const balance = items.reduce((acc, row) => acc + (row[field] || 0), 0);
    return { bucket: `${fmtMoney(lo)} - ${fmtMoney(upper)}`, count: items.length, balance, pct: pct(balance, total) };
  });
}

function validate(rows: StandardLoan[]) {
  const issues: Array<{ loan_id: string; rule_id: string; field: string; message: string; severity: Severity }> = [];
  const byDateId = new Set<string>();
  const duplicates = new Set<string>();

  rows.forEach((r, index) => {
    const loanId = r.loan_id || `fila ${index + 1}`;
    CRITICAL_FIELDS.forEach(field => {
      if (r[field] === null || r[field] === undefined || r[field] === '') {
        issues.push({ loan_id: loanId, rule_id: 'missing', field, message: `Campo requerido sin mapear o vacío: ${field}`, severity: 'high' });
      }
    });
    if ((r.amount || 0) <= 0) issues.push({ loan_id: loanId, rule_id: 'amount_positive', field: 'amount', message: 'amount debe ser mayor a cero', severity: 'high' });
    if ((r.outstanding_balance || 0) < 0) issues.push({ loan_id: loanId, rule_id: 'balance_non_negative', field: 'outstanding_balance', message: 'outstanding_balance no puede ser negativo', severity: 'high' });
    if (r.amount !== null && r.outstanding_balance !== null && r.outstanding_balance > r.amount) issues.push({ loan_id: loanId, rule_id: 'balance_lte_amount', field: 'outstanding_balance', message: 'outstanding_balance excede amount', severity: 'high' });
    if ((r.interest_rate || 0) < 0) issues.push({ loan_id: loanId, rule_id: 'rate_non_negative', field: 'interest_rate', message: 'interest_rate no puede ser negativa', severity: 'high' });
    if ((r.days_overdue || 0) < 0) issues.push({ loan_id: loanId, rule_id: 'dpd_non_negative', field: 'days_overdue', message: 'days_overdue no puede ser negativo', severity: 'high' });
    if (r.start_date && r.end_date && r.end_date <= r.start_date) issues.push({ loan_id: loanId, rule_id: 'date_order', field: 'end_date', message: 'end_date debe ser posterior a start_date', severity: 'high' });
    if (r.loan_id) {
      const key = `${r.file_date || 'no_date'}::${r.loan_id}`;
      if (byDateId.has(key)) duplicates.add(key);
      byDateId.add(key);
    }
  });

  duplicates.forEach(key => issues.push({ loan_id: key.split('::')[1], rule_id: 'duplicate_loan_id', field: 'loan_id', message: 'loan_id duplicado dentro del mismo file_date', severity: 'high' }));
  return issues;
}

function missingFieldProfile(rows: StandardLoan[], mappingReport: MappingNote[] = []) {
  const mapped = new Set(mappingReport.map(m => m.target_term));
  return CRITICAL_FIELDS.map(field => {
    const missingRows = rows.filter(r => r[field] === null || r[field] === undefined || r[field] === '').length;
    return {
      field,
      mapped: mapped.has(field),
      missingRows,
      missingPct: rows.length ? missingRows / rows.length : 1,
      severity: !mapped.has(field) || missingRows / Math.max(rows.length, 1) > 0.2 ? 'high' as Severity : missingRows > 0 ? 'medium' as Severity : 'low' as Severity,
      impact: field === 'loan_id' ? 'No se pueden comparar meses ni detectar duplicados.'
        : field === 'outstanding_balance' ? 'No se puede medir saldo, concentración, DPD ponderado ni aforo.'
        : field === 'days_overdue' ? 'No se puede clasificar cartera vigente/atrasada/vencida.'
        : field === 'amount' ? 'No se puede comparar línea original contra saldo actual.'
        : field === 'interest_rate' ? 'No se puede perfilar tasa ni precio de riesgo.'
        : field === 'loan_type' ? 'No se puede segmentar por producto.'
        : field === 'client' ? 'No se puede medir concentración por acreditado.'
        : 'Limita análisis de vintage, vencimiento y cambios esperados.',
    };
  }).sort((a, b) => {
    const rank = { high: 0, medium: 1, low: 2 };
    return rank[a.severity] - rank[b.severity] || b.missingPct - a.missingPct;
  });
}

export function buildLoanTapeDataProfile(rows: StandardLoan[], mappingReport: MappingNote[] = []) {
  const totalRows = rows.length;
  const active = activeRows(rows);
  const { latest, rows: latestRowsOnly } = latestRows(active.length ? active : rows);
  const missingFields = missingFieldProfile(rows, mappingReport);
  const mappedFields = Array.from(new Set(mappingReport.map(m => m.target_term)));
  const highMissing = missingFields.filter(f => f.severity === 'high');
  const validation = validate(rows);
  const duplicateCount = validation.filter(v => v.rule_id === 'duplicate_loan_id').length;
  const readinessScore = Math.max(0, Math.min(100, Math.round(
    100
    - highMissing.length * 12
    - missingFields.filter(f => f.severity === 'medium').length * 5
    - Math.min(25, validation.length / Math.max(totalRows, 1) * 100)
  )));
  const canAnalyze = highMissing.length === 0 || (mappedFields.includes('outstanding_balance') && mappedFields.includes('days_overdue'));
  const nextActions = [
    ...highMissing.slice(0, 5).map(f => `Mapear o completar ${f.field}: ${f.impact}`),
    ...(duplicateCount ? [`Resolver ${duplicateCount} loan_id duplicado(s) antes de comparar periodos.`] : []),
    ...(mappedFields.includes('file_date') || latest ? [] : ['Agregar fecha de corte o incluirla en el nombre del archivo para análisis temporal.']),
  ].slice(0, 6);

  return {
    readinessScore,
    canAnalyze,
    totalRows,
    latestFileDate: latest,
    latestRows: latestRowsOnly.length,
    mappedFields,
    unmappedCriticalFields: missingFields.filter(f => !f.mapped).map(f => f.field),
    missingFields,
    validationCount: validation.length,
    duplicateCount,
    nextActions,
  };
}

export function buildLoanTapeExportContexts(tapes: LoanTape_DB[]): LoanTapeExportContext[] {
  return tapes.map(tape => {
    const data = tape.extractedData;
    const rawRows = Array.isArray(data) ? data : (data?.rows || []);
    const standardized = standardizeLoanTape(rawRows, tape.fileName);
    const standardizedRows = Array.isArray(data?._standardized)
      ? data._standardized as StandardLoan[]
      : standardized.standardized;
    const mappingReport = Array.isArray(data?._mappingReport)
      ? data._mappingReport as MappingNote[]
      : standardized.mappingReport;
    const localAnalysis = analyzeLoanTapesLocally(tapes, tape.id);
    const storedAnalysis = data?._analysis as StructuredLoanTapeAnalysis | undefined;
    const analysis = storedAnalysis
      ? {
          ...localAnalysis,
          ...storedAnalysis,
          portfolioQuality: localAnalysis.portfolioQuality,
          dpd_distribution: localAnalysis.dpd_distribution,
          concentrations: localAnalysis.concentrations,
          anomalies: localAnalysis.anomalies,
          validation: localAnalysis.validation,
        }
      : localAnalysis;

    return {
      tape,
      standardizedRows,
      mappingReport,
      profile: buildLoanTapeDataProfile(standardizedRows, mappingReport),
      analysis,
    };
  });
}

function answerRows(rows: any[], columns: string[]) {
  if (!rows.length) return 'No encontré registros para esa consulta.';
  return rows.slice(0, 10).map((row, index) => {
    const parts = columns.map(col => `${col}: ${row[col] ?? 'N/D'}`).join(' · ');
    return `${index + 1}. ${parts}`;
  }).join('\n');
}

export function answerLoanTapeQuestion(question: string, rows: StandardLoan[], analysis?: StructuredLoanTapeAnalysis | null, mappingReport: MappingNote[] = []) {
  const q = normalize(question);
  const active = activeRows(rows);
  const { rows: latest } = latestRows(active.length ? active : rows);
  const total = sum(latest);
  const profile = buildLoanTapeDataProfile(rows, mappingReport);

  if (!q.trim()) return 'Pregúntame algo sobre mora, concentración, saldos, cambios vs mes anterior o calidad de datos.';
  if (/(falta|missing|calidad|map|columna|confiable|readiness|listo)/.test(q)) {
    const missing = profile.missingFields.filter(f => f.severity !== 'low').slice(0, 8);
    if (!missing.length) return `El tape está bastante usable: score ${profile.readinessScore}/100, ${profile.mappedFields.length} campos mapeados y ${profile.validationCount} alertas de validación.`;
    return `Score de preparación: ${profile.readinessScore}/100.\n\nLo que falta o pega más:\n${missing.map(f => `- ${f.field}: ${f.mapped ? `${(f.missingPct * 100).toFixed(1)}% filas vacías` : 'no mapeado'}; ${f.impact}`).join('\n')}`;
  }
  if (/(top|mayor|grande|concentracion|cliente)/.test(q)) {
    const top = [...latest].sort((a, b) => (b.outstanding_balance || 0) - (a.outstanding_balance || 0)).slice(0, 10)
      .map(r => ({ loan_id: r.loan_id, client: r.client, outstanding_balance: fmtMoney(r.outstanding_balance || 0), pct: fmtPct(pct(r.outstanding_balance || 0, total)), days_overdue: r.days_overdue }));
    return `Top créditos por saldo:\n${answerRows(top, ['loan_id', 'client', 'outstanding_balance', 'pct', 'days_overdue'])}`;
  }
  if (/(mora|dpd|atras|vencid|overdue)/.test(q)) {
    const overdue = [...latest].filter(r => (r.days_overdue || 0) > 0).sort((a, b) => (b.days_overdue || 0) - (a.days_overdue || 0));
    const overdueBalance = sum(overdue);
    const top = overdue.slice(0, 10).map(r => ({ loan_id: r.loan_id, client: r.client, days_overdue: r.days_overdue, outstanding_balance: fmtMoney(r.outstanding_balance || 0), pct: fmtPct(pct(r.outstanding_balance || 0, total)) }));
    return `Cartera con DPD > 0: ${overdue.length} créditos, ${fmtMoney(overdueBalance)} (${fmtPct(pct(overdueBalance, total))} del saldo).\n\nMayores atrasos:\n${answerRows(top, ['loan_id', 'client', 'days_overdue', 'outstanding_balance', 'pct'])}`;
  }
  if (/(cambio|mes|anterior|nuevo|desapare|deterior|mejor)/.test(q)) {
    const a = analysis?.anomalies || anomalies(rows);
    const lines = [
      `Nuevos créditos: ${a.new_loans?.length || 0}`,
      `Créditos que desaparecen: ${a.disappeared_loans?.length || 0}`,
      `Deterioros DPD: ${a.dpd_deterioration?.length || 0}`,
      `Mejoras DPD: ${a.dpd_improvement?.length || 0}`,
      `Cambios de condición: ${a.condition_changes?.length || 0}`,
    ];
    return `${lines.join('\n')}\n\nDetalle más relevante:\n${answerRows([...(a.dpd_deterioration || []), ...(a.new_loans || [])].slice(0, 10), ['loan_id', 'days_overdue_prev', 'days_overdue_latest', 'outstanding_balance', 'category'])}`;
  }
  if (/(producto|tipo|segmento)/.test(q)) {
    const productRows = loanTypeProfile(latest).slice(0, 10).map(r => ({ ...r, balance: fmtMoney(r.balance), pct: fmtPct(r.pct), avg_interest_rate: r.avg_interest_rate?.toFixed(2) ?? 'N/D', avg_days_overdue: r.avg_days_overdue?.toFixed(1) ?? 'N/D' }));
    return `Perfil por producto:\n${answerRows(productRows, ['name', 'count', 'balance', 'pct', 'avg_interest_rate', 'avg_days_overdue'])}`;
  }
  return analysis?.executiveSummary || `Resumen: ${latest.length} registros activos, saldo ${fmtMoney(total)}. Preguntas útiles: "qué falta", "top concentración", "mora", "cambios vs mes anterior", "por producto".`;
}

function anomalies(rows: StandardLoan[]) {
  const dates = Array.from(new Set(rows.map(r => r.file_date).filter(Boolean) as string[])).sort();
  if (dates.length < 2) return {};
  const previousDate = dates[dates.length - 2];
  const latestDate = dates[dates.length - 1];
  const prev = activeRows(rows.filter(r => r.file_date === previousDate));
  const latest = activeRows(rows.filter(r => r.file_date === latestDate));
  const prevMap = new Map(prev.filter(r => r.loan_id).map(r => [r.loan_id as string, r]));
  const latestMap = new Map(latest.filter(r => r.loan_id).map(r => [r.loan_id as string, r]));

  const latestTotal = sum(latest);
  const previousTotal = sum(prev);
  const latestMonth = latestDate.slice(0, 7);
  const previousTime = new Date(previousDate).getTime();
  const latestTime = new Date(latestDate).getTime();
  const new_loans = latest.filter(r => r.loan_id && !prevMap.has(r.loan_id)).map(r => ({
    loan_id: r.loan_id,
    outstanding_balance: r.outstanding_balance,
    start_date: r.start_date,
    category: r.start_date?.slice(0, 7) === latestMonth ? 'Expected' : 'Not Expected',
    percentage: pct(r.outstanding_balance || 0, latestTotal),
  }));
  const disappeared_loans = prev.filter(r => r.loan_id && !latestMap.has(r.loan_id)).map(r => {
    const endTime = r.end_date ? new Date(r.end_date).getTime() : 0;
    return {
      loan_id: r.loan_id,
      outstanding_balance: r.outstanding_balance,
      end_date: r.end_date,
      category: endTime > latestTime ? 'Early payment' : endTime > previousTime ? 'On time' : 'Delayed',
      days_overdue_prev: r.days_overdue,
      percentage: pct(r.outstanding_balance || 0, previousTotal),
    };
  });
  const ended_loans = latest.filter(r => r.end_date && r.end_date < latestDate).map(r => ({ loan_id: r.loan_id, outstanding_balance: r.outstanding_balance, end_date: r.end_date, days_overdue: r.days_overdue }));
  const dpd_improvement: any[] = [];
  const dpd_deterioration: any[] = [];
  const dpd_inconsistency: any[] = [];
  const condition_changes: any[] = [];

  latestMap.forEach((current, id) => {
    const prior = prevMap.get(id);
    if (!prior) return;
    const prevDpd = prior.days_overdue || 0;
    const latestDpd = current.days_overdue || 0;
    if (latestDpd < prevDpd) dpd_improvement.push({ loan_id: id, days_overdue_prev: prevDpd, days_overdue_latest: latestDpd, delta_days_overdue: latestDpd - prevDpd });
    if (latestDpd > prevDpd) dpd_deterioration.push({
      loan_id: id,
      days_overdue_prev: prevDpd,
      days_overdue_latest: latestDpd,
      delta_days_overdue: latestDpd - prevDpd,
      outstanding_balance: current.outstanding_balance,
    });
    if (prevDpd > 0 && latestDpd > 0 && (prevDpd === latestDpd || Math.abs(latestDpd - prevDpd) > 30)) {
      dpd_inconsistency.push({ loan_id: id, days_overdue_prev: prevDpd, days_overdue_latest: latestDpd, delta_days_overdue: latestDpd - prevDpd, category: prevDpd === latestDpd ? 'No change in days' : 'Increment bigger than monthly cadence' });
    }
    (['start_date', 'end_date', 'loan_type', 'industry', 'currency', 'state', 'client'] as Array<keyof StandardLoan>).forEach(field => {
      if ((prior[field] || '') !== (current[field] || '')) condition_changes.push({ loan_id: id, field_changed: field, value_prev: prior[field], value_latest: current[field] });
    });
  });

  return { new_loans, disappeared_loans, ended_loans, dpd_improvement, dpd_deterioration, dpd_inconsistency, condition_changes };
}

export function analyzeLoanTapesLocally(tapes: LoanTape_DB[], selectedTapeId?: string): StructuredLoanTapeAnalysis {
  const allStandardized = tapes.flatMap(tape => {
    const data = tape.extractedData;
    const stored = data?._standardized;
    const fallbackDate = parseDate(tape.uploadDate);
    if (Array.isArray(stored)) {
      return (stored as StandardLoan[]).map(row => ({ ...row, file_date: row.file_date || fallbackDate }));
    }
    const rows = Array.isArray(data) ? data : (data?.rows || []);
    return standardizeLoanTape(rows, tape.fileName).standardized.map(row => ({ ...row, file_date: row.file_date || fallbackDate }));
  });
  const selected = tapes.find(t => t.id === selectedTapeId);
  const selectedRawRows = selected
    ? (Array.isArray(selected.extractedData) ? selected.extractedData : (selected.extractedData?.rows || []))
    : [];
  const selectedStandardized = selected ? standardizeLoanTape(selectedRawRows, selected.fileName) : null;
  const selectedRows = selected
    ? ((selected.extractedData?._standardized || selectedStandardized?.standardized || []) as StandardLoan[])
        .map(row => ({ ...row, file_date: row.file_date || parseDate(selected.uploadDate) }))
    : allStandardized;
  const selectedMappingReport = selected
    ? (selected.extractedData?._mappingReport || selectedStandardized?.mappingReport || [])
    : [];
  const active = activeRows(allStandardized);
  const activeOrSelected = active.length ? active : selectedRows;
  const { previous, latestRows: latest, previousRows } = latestAndPreviousRows(activeOrSelected);
  const q: any = quality(latest);
  const pq: any = quality(previousRows);
  const dpd = dpdDistribution(latest);
  const total = sum(latest);
  const previousTotal = sum(previousRows);
  const loanCount = new Set(latest.map(r => r.loan_id).filter(Boolean)).size;
  const previousLoanCount = new Set(previousRows.map(r => r.loan_id).filter(Boolean)).size;
  const clientCount = new Set(latest.map(r => r.client).filter(Boolean)).size;
  const previousClientCount = new Set(previousRows.map(r => r.client).filter(Boolean)).size;
  const validation = validate(selectedRows);
  const concentrations = {
    by_client: groupBy(latest, 'client', 20),
    by_loan_type: loanTypeProfile(latest),
    by_state: groupBy(latest, 'state', 20),
    by_industry: groupBy(latest, 'industry', 20),
    buckets_outstanding: buckets(latest, 'outstanding_balance'),
    buckets_amount: buckets(latest, 'amount'),
  };
  const vencidaPct = q.vencida?.pct || 0;
  const atrasadaPct = q.atrasada?.pct || 0;
  const previousVencidaPct = pq.vencida?.pct || 0;
  const previousAtrasadaPct = pq.atrasada?.pct || 0;
  const maxClientPct = concentrations.by_client[0]?.pct || 0;
  const previousMaxClientPct = groupBy(previousRows, 'client', 1)[0]?.pct || 0;
  const weightedDpd = weightedAverage(latest, 'days_overdue');
  const previousWeightedDpd = weightedAverage(previousRows, 'days_overdue');
  const weightedRate = weightedAverage(latest, 'interest_rate');
  const previousWeightedRate = weightedAverage(previousRows, 'interest_rate');
  const top10Pct = topShare(latest, 10);
  const previousTop10Pct = topShare(previousRows, 10);
  const missingDpdPct = q.sin_dato?.pct || 0;
  const validationPenalty = Math.min(15, validation.length / Math.max(selectedRows.length, 1) * 20);
  const riskScore = Math.min(100, Math.round(
    (vencidaPct * 100 * 4)
    + (atrasadaPct * 100 * 1.5)
    + (maxClientPct > 0.3 ? 15 : maxClientPct > 0.2 ? 8 : 0)
    + (missingDpdPct * 20)
    + validationPenalty
  ));
  const overallStatus = vencidaPct > 0.1 || riskScore >= 70 ? 'critical' : vencidaPct >= 0.05 || atrasadaPct > 0.2 || riskScore >= 40 ? 'warning' : 'good';
  const dataProfile = buildLoanTapeDataProfile(selectedRows, selectedMappingReport);
  const anomalySet: any = anomalies(activeOrSelected);
  const trendDirection = previousRows.length
    ? trend((vencidaPct * 2) + atrasadaPct + maxClientPct, (previousVencidaPct * 2) + previousAtrasadaPct + previousMaxClientPct, true)
    : 'stable';

  const findings = [
    ...dataProfile.missingFields.filter(f => f.severity !== 'low').slice(0, 5).map(f => ({ severity: f.severity, category: 'Preparación de Datos', title: `${f.field} ${f.mapped ? 'incompleto' : 'sin mapear'}`, detail: f.mapped ? `${fmtPct(f.missingPct)} de filas sin dato.` : 'No encontré una columna equivalente en el archivo.', recommendation: f.impact })),
    ...validation.slice(0, 10).map(v => ({ severity: v.severity, category: 'Calidad de Datos', title: v.rule_id, detail: `${v.loan_id}: ${v.message}`, recommendation: 'Revisar mapeo o dato fuente.' })),
    ...concentrations.by_client.filter(c => c.severity !== 'low').slice(0, 5).map(c => ({ severity: c.severity, category: 'Concentración', title: `Concentración en ${c.name}`, detail: `${fmtPct(c.pct)} del saldo de cartera`, recommendation: 'Revisar límite contractual por acreditado.' })),
    ...(anomalySet.dpd_deterioration?.length ? [{ severity: 'medium', category: 'Deterioro', title: `${anomalySet.dpd_deterioration.length} créditos entraron en mora`, detail: 'Comparación contra el corte anterior.', recommendation: 'Priorizar cobranza y revisar si el deterioro está concentrado por cliente/producto.' }] : []),
    ...(anomalySet.disappeared_loans?.length ? [{ severity: 'low', category: 'Cambios de Portafolio', title: `${anomalySet.disappeared_loans.length} créditos desaparecieron`, detail: 'Puede ser pago, recompra, castigo o inconsistencia de ID.', recommendation: 'Validar contra movimientos y calendario de vencimientos.' }] : []),
    ...(missingDpdPct > 0 ? [{ severity: missingDpdPct > 0.1 ? 'high' : 'medium', category: 'Cobertura DPD', title: `${fmtPct(missingDpdPct)} del saldo no tiene DPD`, detail: 'Ese saldo no se clasificó como vigente, atrasado ni vencido.', recommendation: 'Completar DPD antes de usar la mezcla de cartera para decisiones o covenants.' }] : []),
  ].sort((a, b) => ({ high: 0, medium: 1, low: 2 }[a.severity] ?? 3) - ({ high: 0, medium: 1, low: 2 }[b.severity] ?? 3));

  const topClient = concentrations.by_client[0];
  const deteriorationIds = new Set((anomalySet.dpd_deterioration || []).map((item: any) => item.loan_id));
  const deteriorationBalance = sum(latest.filter(row => row.loan_id && deteriorationIds.has(row.loan_id)));
  const comparisonText = previous
    ? ` Contra ${previous}, el saldo cambió ${fmtChange(total, previousTotal, 'money') || 'sin variación calculable'}, la cartera vencida ${fmtChange(vencidaPct, previousVencidaPct, 'pct') || 'sin variación calculable'} y ${anomalySet.dpd_deterioration?.length || 0} créditos deterioraron DPD por ${fmtMoney(deteriorationBalance)}.`
    : ' No existe un corte anterior comparable; la tendencia se habilitará al cargar otro periodo.';
  const concentrationText = topClient
    ? ` El mayor cliente es ${topClient.name} con ${fmtPct(topClient.pct)} del saldo; Top 10 concentra ${fmtPct(top10Pct)}.`
    : '';

  return {
    overallStatus,
    riskScore,
    executiveSummary: `Cartera de ${loanCount} créditos y ${clientCount} clientes por ${fmtMoney(total)}: vigente ${fmtPct(q.vigente?.pct || 0)}, atrasada ${fmtPct(atrasadaPct)}, vencida ${fmtPct(vencidaPct)}${missingDpdPct ? ` y ${fmtPct(missingDpdPct)} sin DPD` : ''}.${concentrationText}${comparisonText}`,
    trendDirection,
    portfolioQuality: q,
    dpd_distribution: dpd,
    concentrations,
    anomalies: anomalySet,
    validation,
    metrics: [
      { name: 'Saldo total outstanding', latestValue: fmtMoney(total), previousValue: previousRows.length ? fmtMoney(previousTotal) : undefined, change: fmtChange(total, previousTotal, 'money'), trend: trend(total, previousTotal), status: overallStatus, congruent: true },
      { name: 'Numero de creditos', latestValue: String(loanCount), previousValue: previousRows.length ? String(previousLoanCount) : undefined, change: fmtChange(loanCount, previousLoanCount, 'number'), trend: trend(loanCount, previousLoanCount), status: 'good', congruent: true },
      { name: 'Numero de clientes', latestValue: String(clientCount), previousValue: previousRows.length ? String(previousClientCount) : undefined, change: fmtChange(clientCount, previousClientCount, 'number'), trend: trend(clientCount, previousClientCount), status: 'good', congruent: true },
      { name: '% cartera vencida', latestValue: fmtPct(vencidaPct), previousValue: previousRows.length ? fmtPct(previousVencidaPct) : undefined, change: fmtChange(vencidaPct, previousVencidaPct, 'pct'), trend: trend(vencidaPct, previousVencidaPct, true), status: vencidaPct > 0.1 ? 'critical' : vencidaPct >= 0.05 ? 'warning' : 'good', congruent: true },
      { name: '% cartera atrasada', latestValue: fmtPct(atrasadaPct), previousValue: previousRows.length ? fmtPct(previousAtrasadaPct) : undefined, change: fmtChange(atrasadaPct, previousAtrasadaPct, 'pct'), trend: trend(atrasadaPct, previousAtrasadaPct, true), status: atrasadaPct > 0.2 ? 'warning' : 'good', congruent: true },
      { name: 'Concentracion max cliente', latestValue: fmtPct(maxClientPct), previousValue: previousRows.length ? fmtPct(previousMaxClientPct) : undefined, change: fmtChange(maxClientPct, previousMaxClientPct, 'pct'), trend: trend(maxClientPct, previousMaxClientPct, true), status: maxClientPct > 0.2 ? 'critical' : maxClientPct > 0.1 ? 'warning' : 'good', congruent: true },
      { name: 'Concentracion Top 10 creditos', latestValue: fmtPct(top10Pct), previousValue: previousRows.length ? fmtPct(previousTop10Pct) : undefined, change: fmtChange(top10Pct, previousTop10Pct, 'pct'), trend: trend(top10Pct, previousTop10Pct, true), status: top10Pct > 0.75 ? 'critical' : top10Pct > 0.5 ? 'warning' : 'good', congruent: true },
      { name: 'DPD ponderado por saldo', latestValue: weightedDpd === null ? 'N/D' : `${weightedDpd.toFixed(1)} dias`, previousValue: previousWeightedDpd === null ? undefined : `${previousWeightedDpd.toFixed(1)} dias`, change: weightedDpd !== null && previousWeightedDpd !== null ? fmtChange(weightedDpd, previousWeightedDpd, 'number') : undefined, trend: weightedDpd !== null && previousWeightedDpd !== null ? trend(weightedDpd, previousWeightedDpd, true) : 'stable', status: weightedDpd !== null && weightedDpd > 60 ? 'critical' : weightedDpd !== null && weightedDpd > 30 ? 'warning' : 'good', congruent: true },
      { name: 'Tasa ponderada por saldo', latestValue: weightedRate === null ? 'N/D' : `${weightedRate.toFixed(2)}%`, previousValue: previousWeightedRate === null ? undefined : `${previousWeightedRate.toFixed(2)}%`, change: weightedRate !== null && previousWeightedRate !== null ? `${weightedRate - previousWeightedRate >= 0 ? '+' : ''}${(weightedRate - previousWeightedRate).toFixed(2)} pp` : undefined, trend: weightedRate !== null && previousWeightedRate !== null ? trend(weightedRate, previousWeightedRate) : 'stable', status: 'good', congruent: true },
    ],
    findings,
    congruencyChecks: [],
  };
}
