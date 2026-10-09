import { LoanTape_DB } from '../db/index';
import { imorBreakdown, liveLoansDetail, DPD_BUCKET_DEFS, DPD_CONSISTENCY, QUALITY_RULES, RISK_THRESHOLDS, checkDpdConsistency, classifyDpd, dpdRangeFromText, isStrongDpdText, resolveDpd, type DpdConsistency, type DpdSource } from './portfolioRules';
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
  dpd_source?: DpdSource | null;
  id_source?: 'inferred' | null;
  installment?: number | null;
  currency: string | null;
  industry: string | null;
  state: string | null;
  file_date: string | null;
  source_granularity?: 'loan' | 'product_summary' | 'state_summary';
  source_share?: number | null;
}
export type StandardLoanField = Exclude<keyof StandardLoan, 'source_granularity' | 'source_share' | 'dpd_source' | 'id_source' | 'installment'>;

// Retroalimentación del analista al mapeo: encabezado normalizado → campo estándar (o 'ignore' = no usar).
// Se guarda por cliente y gana sobre el mapeo automático en cada importación.
export type MappingOverrides = Record<string, StandardLoanField | 'ignore'>;
export const MAPPING_OVERRIDES_KEY = 'loantape_mapping_overrides';
export const STANDARD_FIELD_LABELS: Record<StandardLoanField, string> = {
  loan_id: 'ID de crédito', client: 'Cliente', amount: 'Monto original', outstanding_balance: 'Saldo insoluto',
  interest_rate: 'Tasa', loan_status: 'Estatus del crédito', start_date: 'Fecha de inicio', end_date: 'Fecha de vencimiento',
  loan_type: 'Producto', days_overdue: 'Días de atraso', currency: 'Moneda', industry: 'Giro / industria',
  state: 'Estado (geográfico)', file_date: 'Fecha de corte',
};
export function mappingHeaderKey(header: string): string { return normalize(header); }

export interface MappingNote {
  source_header: string;
  target_term: StandardLoanField;
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
type CapabilityStatus = 'available' | 'partial' | 'blocked';

const CRITICAL_FIELDS: StandardLoanField[] = ['loan_id', 'client', 'amount', 'outstanding_balance', 'interest_rate', 'loan_type', 'days_overdue', 'start_date', 'end_date'];
const PROFILE_FIELDS: StandardLoanField[] = ['loan_id', 'client', 'amount', 'outstanding_balance', 'interest_rate', 'loan_status', 'loan_type', 'days_overdue', 'start_date', 'end_date', 'currency', 'industry', 'state', 'file_date'];
const BASE_ANALYSIS_FIELD: StandardLoanField = 'outstanding_balance';
const ROW_VALIDATION_FIELDS: StandardLoanField[] = ['outstanding_balance', 'loan_id', 'client', 'days_overdue'];

const FIELD_IMPACT: Record<StandardLoanField, string> = {
  loan_id: 'Limita comparativos entre cortes, duplicados y altas/bajas.',
  client: 'Limita concentración por acreditado; saldos y mora siguen disponibles.',
  amount: 'Limita utilización contra línea original; saldos y concentración siguen disponibles.',
  outstanding_balance: 'Sin saldo no se puede medir cartera, concentración, DPD ponderado ni buckets.',
  interest_rate: 'Limita tasa ponderada y lectura de precio de riesgo.',
  loan_status: 'Se puede inferir estatus con DPD si existe; si no, queda como dato descriptivo.',
  start_date: 'Limita vintage, plazo original y altas esperadas.',
  end_date: 'Limita vencimientos, pagos esperados y créditos vencidos activos.',
  loan_type: 'Limita segmentación por producto.',
  days_overdue: 'Limita mora, cartera atrasada/vencida y DPD ponderado; concentración por saldo sigue disponible.',
  currency: 'Se asume MXN si falta.',
  industry: 'Limita concentración por industria.',
  state: 'Limita concentración por estado.',
  file_date: 'Limita comparativos temporales si tampoco viene fecha en el nombre del archivo.',
};

const ANALYSIS_REQUIREMENTS = [
  { key: 'portfolio_balance', label: 'Saldo total y tamaño de cartera', required: ['outstanding_balance'] as StandardLoanField[], partial: [] as StandardLoanField[] },
  { key: 'dpd_quality', label: 'Mora, buckets DPD y cartera vencida', required: ['outstanding_balance', 'days_overdue'] as StandardLoanField[], partial: [] as StandardLoanField[] },
  { key: 'client_concentration', label: 'Concentración por cliente', required: ['outstanding_balance', 'client'] as StandardLoanField[], partial: ['loan_id'] as StandardLoanField[] },
  { key: 'loan_concentration', label: 'Top créditos y buckets por saldo', required: ['outstanding_balance'] as StandardLoanField[], partial: ['loan_id'] as StandardLoanField[] },
  { key: 'product_mix', label: 'Cartera por producto', required: ['outstanding_balance', 'loan_type'] as StandardLoanField[], partial: [] as StandardLoanField[] },
  { key: 'weighted_rate', label: 'Tasa ponderada por saldo', required: ['outstanding_balance', 'interest_rate'] as StandardLoanField[], partial: [] as StandardLoanField[] },
  { key: 'maturity_vintage', label: 'Vencimientos, plazo y vintage', required: ['start_date', 'end_date'] as StandardLoanField[], partial: ['outstanding_balance'] as StandardLoanField[] },
  { key: 'period_comparison', label: 'Comparativo vs corte anterior', required: ['loan_id', 'file_date'] as StandardLoanField[], partial: ['outstanding_balance', 'days_overdue'] as StandardLoanField[] },
  { key: 'geo_industry', label: 'Concentración por estado e industria', required: ['outstanding_balance'] as StandardLoanField[], partial: ['state', 'industry'] as StandardLoanField[] },
];
const CORE_ANALYSIS_KEYS = new Set(['portfolio_balance', 'dpd_quality', 'client_concentration', 'loan_concentration', 'weighted_rate']);

const SYNONYMS: Record<StandardLoanField, string[]> = {
  loan_id: ['contrato', 'loan id', 'loan number', 'loan no', 'folio', 'numero credito', 'numero de credito', 'numero de prestamo intermediario', 'prestamo intermediario', 'no credito', 'no contrato', 'id prestamo', 'id credito', 'operacion', 'cuenta', 'no cuenta', 'referencia'],
  client: ['cliente', 'client', 'customer', 'razon social', 'nombre', 'nombre cliente', 'nombre acreditado', 'acreditado', 'deudor', 'borrower', 'obligor', 'client id', 'id cliente', 'apellidos', 'rfc'],
  amount: ['amount', 'loan amount', 'lended amount', 'principal', 'original amount', 'monto original', 'monto otorgado', 'monto maximo', 'monto autorizado', 'importe dispuesto', 'importe original', 'limite credito', 'linea autorizada', 'costo'],
  outstanding_balance: ['capital balance', 'saldo capital', 'saldo insoluto', 'saldo actual', 'saldo vigente', 'saldo total', 'capital vigente', 'capital vencido', 'capital moroso y vencido', 'capital mosoro y vencido', 'capital por pagar', 'capital pendiente', 'saldo insoluto capital', 'principal balance', 'outstanding', 'balance', 'monto activo', 'saldo dispuesto'],
  interest_rate: ['interest rate', 'tasa', 'tasa interes', 'tasa de interes', 'tasa final', 'tasa base', 'tasa anual de interes', 'tasa sobretasa acreditado', 'rate', 'rate %', 'tir', 'tna'],
  loan_status: ['status', 'estado credito', 'estado del credito', 'estado del activo', 'estatus del activo', 'estado activo', 'loan status', 'estatus', 'estatus credito', 'situacion', 'condicion', 'clasificacion'],
  start_date: ['start date', 'origination date', 'fecha inicio', 'fecha otorgamiento', 'fecha apertura', 'fecha disposicion', 'fecha alta', 'disbursement date'],
  end_date: ['end date', 'maturity date', 'fecha vencimiento', 'fecha fin', 'fecha pago final', 'due date'],
  loan_type: ['loan type', 'producto', 'product', 'product type', 'tipo contrato', 'tipo credito', 'tipo prestamo', 'tipo producto', 'linea', 'modalidad', 'subproducto', 'segmento', 'programa', 'plan', 'esquema'],
  days_overdue: ['days overdue', 'days past due', 'dpd', 'mora dias', 'dias mora', 'dias de mora', 'dias en mora', 'dias de retraso', 'dias atraso', 'dias de atraso', 'dias vencidos', 'dias de vencidos', 'dias vencido', 'dias vencida', 'delinquent days'],
  currency: ['currency', 'moneda', 'divisa'],
  industry: ['industry', 'giro', 'sector', 'industria', 'actividad economica', 'ramo', 'sub grupo', 'subgrupo', 'sector economico'],
  state: ['state', 'provincia', 'entidad', 'estado residencia', 'estado de residencia', 'region', 'plaza', 'localidad'],
  file_date: ['file date', 'fecha archivo', 'fecha corte', 'fecha reporte', 'corte', 'periodo'],
};

export const PAID_STATUSES = ['paid', 'fully paid', 'paid off', 'closed', 'canceled', 'cancelled', 'liquidated', 'liquidado', 'liquidada', 'pagado', 'pagada', 'settled', 'saldado', 'finiquitado'];

export function normalize(value: any): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[%#]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function parseNumber(value: any): number | null {
  return parseNullableFinancialNumber(value);
}

const MEXICAN_STATES = new Set([
  'aguascalientes', 'baja california', 'baja california sur', 'campeche', 'chiapas', 'chihuahua',
  'ciudad de mexico', 'cdmx', 'coahuila', 'colima', 'durango', 'guanajuato', 'guerrero',
  'hidalgo', 'jalisco', 'mexico', 'estado de mexico', 'michoacan', 'morelos', 'nayarit',
  'nuevo leon', 'oaxaca', 'puebla', 'queretaro', 'quintana roo', 'san luis potosi',
  'sinaloa', 'sonora', 'tabasco', 'tamaulipas', 'tlaxcala', 'veracruz', 'yucatan', 'zacatecas',
]);

const STATUS_WORDS = ['vigente', 'vencido', 'vencida', 'atrasado', 'atrasada', 'liquidado', 'liquidada', 'pagado', 'pagada', 'castigado', 'cerrado', 'activo', 'mora'];
const PRODUCT_WORDS = ['credito', 'prestamo', 'factoraje', 'arrendamiento', 'simple', 'revolvente', 'nomina', 'auto', 'pyme', 'leasing', 'linea'];
const CURRENCY_WORDS = ['mxn', 'usd', 'eur', 'pesos', 'dolares', 'dolares americanos'];

function excelSerialToDate(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 20000 || serial > 80000) return null;
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  return new Date(ms).toISOString().slice(0, 10);
}

const PERIOD_MONTHS_ES: Record<string, number> = {
  ene: 1, enero: 1, jan: 1, january: 1,
  feb: 2, febrero: 2, february: 2,
  mar: 3, marzo: 3, march: 3,
  abr: 4, abril: 4, apr: 4, april: 4,
  may: 5, mayo: 5,
  jun: 6, junio: 6, june: 6,
  jul: 7, julio: 7, july: 7,
  ago: 8, agosto: 8, aug: 8, august: 8,
  sep: 9, sept: 9, septiembre: 9, september: 9,
  oct: 10, octubre: 10, october: 10,
  nov: 11, noviembre: 11, november: 11,
  dic: 12, diciembre: 12, dec: 12, december: 12,
};

function fullYearToken(rawYear: string): number {
  if (rawYear.length === 4) return Number(rawYear);
  const year = Number(rawYear);
  return year >= 70 ? 1900 + year : 2000 + year;
}

function dateISO(year: number, month: number, day: number): string | null {
  if (!Number.isFinite(year) || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function endOfMonthISO(year: number, month: number): string | null {
  if (!Number.isFinite(year) || month < 1 || month > 12) return null;
  const date = new Date(year, month, 0);
  return dateISO(date.getFullYear(), month, date.getDate());
}

export function parseLoanTapePeriodText(value?: string | null): string | null {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const normalized = normalize(raw);
  const monthPattern = Object.keys(PERIOD_MONTHS_ES).join('|');
  const dayMonthYear = normalized.match(new RegExp(`\\b(\\d{1,2})\\s*(?:de\\s*)?(${monthPattern})(?:\\s*(?:de|del))?\\s*(\\d{2}|\\d{4})\\b`));
  if (dayMonthYear) {
    return dateISO(fullYearToken(dayMonthYear[3]), PERIOD_MONTHS_ES[dayMonthYear[2]], Number(dayMonthYear[1]));
  }

  let monthYear = normalized.match(new RegExp(`\\b(${monthPattern})\\s*(\\d{2}|\\d{4})\\b`));
  if (!monthYear) monthYear = normalized.match(new RegExp(`\\b(\\d{2}|\\d{4})\\s*(${monthPattern})\\b`));
  if (monthYear) {
    const monthToken = PERIOD_MONTHS_ES[monthYear[1]] ? monthYear[1] : monthYear[2];
    const yearToken = PERIOD_MONTHS_ES[monthYear[1]] ? monthYear[2] : monthYear[1];
    return endOfMonthISO(fullYearToken(yearToken), PERIOD_MONTHS_ES[monthToken]);
  }

  return null;
}

export function parseDate(value: any): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return excelSerialToDate(value);
  const raw = String(value).trim();
  if (!raw) return null;
  const textual = parseLoanTapePeriodText(raw);
  if (textual) return textual;
  const direct = raw.match(/(20\d{2})[-/_.](\d{1,2})[-/_.](\d{1,2})/);
  if (direct) return `${direct[1]}-${direct[2].padStart(2, '0')}-${direct[3].padStart(2, '0')}`;
  const mx = raw.match(/(\d{1,2})[-/_.](\d{1,2})[-/_.](20\d{2})/);
  if (mx) return `${mx[3]}-${mx[2].padStart(2, '0')}-${mx[1].padStart(2, '0')}`;
  if (!/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|ene|abr|ago|dic)/i.test(raw)) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function parseFileDate(fileName?: string): string | null {
  const raw = fileName || '';
  const textual = parseLoanTapePeriodText(raw);
  if (textual) return textual;
  const normalized = normalize(raw);
  const monthByName: Record<string, number> = {
    ene: 1, enero: 1, jan: 1, january: 1,
    feb: 2, febrero: 2, february: 2,
    mar: 3, marzo: 3, march: 3,
    abr: 4, abril: 4, apr: 4, april: 4,
    may: 5, mayo: 5,
    jun: 6, junio: 6, june: 6,
    jul: 7, julio: 7, july: 7,
    ago: 8, agosto: 8, aug: 8, august: 8,
    sep: 9, sept: 9, septiembre: 9, september: 9,
    oct: 10, octubre: 10, october: 10,
    nov: 11, noviembre: 11, november: 11,
    dic: 12, diciembre: 12, dec: 12, december: 12,
  };
  const endOfMonth = (year: number, month: number) => {
    if (month < 1 || month > 12) return null;
    const date = new Date(year, month, 0);
    return `${date.getFullYear()}-${String(month).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  };
  const fullYear = (year: string) => {
    if (year.length === 4) return Number(year);
    const n = Number(year);
    return n >= 70 ? 1900 + n : 2000 + n;
  };
  const monthPattern = Object.keys(monthByName).join('|');
  let monthMatch = normalized.match(new RegExp(`\\b(${monthPattern})\\s*(\\d{2}|\\d{4})\\b`));
  if (!monthMatch) monthMatch = normalized.match(new RegExp(`\\b(\\d{2}|\\d{4})\\s*(${monthPattern})\\b`));
  if (monthMatch) {
    const monthToken = monthByName[monthMatch[1]] ? monthMatch[1] : monthMatch[2];
    const yearToken = monthByName[monthMatch[1]] ? monthMatch[2] : monthMatch[1];
    const byName = endOfMonth(fullYear(yearToken), monthByName[monthToken]);
    if (byName) return byName;
  }
  // "260931" (31 de septiembre) no existe: un día 29-31 que se pasa del mes se lleva al último día del mes
  // (la intención es el cierre de mes); nunca se devuelve una fecha inválida, que JS movería al mes siguiente.
  const validDay = (year: number, month: number, day: number): string | null => {
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const last = new Date(year, month, 0).getDate();
    const d = day > last ? last : day;
    return `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  };
  const ymd = raw.match(/(20\d{2})[-_. ]?(\d{2})[-_. ]?(\d{2})/);
  if (ymd) {
    const valid = validDay(Number(ymd[1]), Number(ymd[2]), Number(ymd[3]));
    if (valid) return valid;
  }
  const yymmdd = raw.match(/\b(\d{2})[-_. ]?(\d{2})[-_. ]?(\d{2})\b/);
  if (yymmdd) {
    const year = Number(yymmdd[1]) >= 70 ? 1900 + Number(yymmdd[1]) : 2000 + Number(yymmdd[1]);
    const valid = validDay(year, Number(yymmdd[2]), Number(yymmdd[3])) || validDay(year, Number(yymmdd[3]), Number(yymmdd[2]));
    if (valid) return valid;
  }
  return null;
}

type LoanTapePeriodInput = {
  extractedData: any;
  fileName: string;
  uploadDate: string;
};

export function loanTapeFileDates(tape: Pick<LoanTapePeriodInput, 'extractedData' | 'fileName'>): string[] {
  const data: any = tape.extractedData;
  const rows = Array.isArray(data?._standardized)
    ? data._standardized
    : Array.isArray(data?.rows)
      ? data.rows
      : [];
  const dates = Array.from(new Set(rows.map((row: any) => row?.file_date).filter(Boolean) as string[])).sort();
  const fromName = parseFileDate(tape.fileName);
  return dates.length ? dates : fromName ? [fromName] : [];
}

export function loanTapePeriodDate(tape: LoanTapePeriodInput): string {
  return loanTapeFileDates(tape).at(-1) || parseDate(tape.uploadDate) || tape.uploadDate || '';
}

export function sortLoanTapesByPeriod<T extends LoanTapePeriodInput>(tapes: T[]): T[] {
  return [...tapes].sort((a, b) => {
    const byPeriod = loanTapePeriodDate(b).localeCompare(loanTapePeriodDate(a));
    return byPeriod || (b.uploadDate || '').localeCompare(a.uploadDate || '');
  });
}

function parseRate(value: any): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = parseNumber(typeof value === 'string' ? value.replace('%', '') : value);
  if (n === null) return null;
  return n > 1 ? Math.round((n / 100) * 1e6) / 1e6 : n;
}

function valueSampleScore(target: StandardLoanField, values: any[]): number {
  const sample = values.filter(v => v !== null && v !== undefined && String(v).trim() !== '').slice(0, 50);
  if (!sample.length) return 0;
  const normalizedValues = sample.map(normalize);
  const numbers = sample.map(parseNumber).filter((v): v is number => v !== null && Number.isFinite(v));
  const dates = sample.map(parseDate).filter(Boolean);
  const textValues = normalizedValues.filter(Boolean);
  const uniquePct = new Set(textValues).size / Math.max(textValues.length, 1);
  const numberPct = numbers.length / sample.length;
  const datePct = dates.length / sample.length;
  const avgAbs = numbers.length ? numbers.reduce((a, b) => a + Math.abs(b), 0) / numbers.length : 0;
  const intPct = numbers.length ? numbers.filter(n => Math.abs(n - Math.round(n)) < 0.000001).length / numbers.length : 0;
  const withinRatePct = numbers.length ? numbers.filter(n => n >= 0 && n <= 100).length / numbers.length : 0;
  const hasWords = (words: string[]) => textValues.some(v => words.some(word => v.includes(word)));

  if (target === 'start_date' || target === 'end_date' || target === 'file_date') return datePct >= 0.7 ? 35 : datePct >= 0.3 ? 12 : 0;
  if (target === 'currency') return hasWords(CURRENCY_WORDS) ? 35 : 0;
  if (target === 'loan_status') return hasWords(STATUS_WORDS) ? 30 : 0;
  if (target === 'loan_type') return hasWords(PRODUCT_WORDS) ? 25 : 0;
  if (target === 'state') return textValues.some(v => MEXICAN_STATES.has(v)) ? 30 : 0;
  if (target === 'days_overdue') return numberPct >= 0.75 && intPct >= 0.9 && avgAbs <= 3650 ? 25 : 0;
  if (target === 'interest_rate') return numberPct >= 0.7 && withinRatePct >= 0.9 && avgAbs <= 100 ? 18 : 0;
  if (target === 'amount' || target === 'outstanding_balance') return numberPct >= 0.7 && avgAbs >= 1000 ? 18 : numberPct >= 0.7 ? 8 : 0;
  if (target === 'loan_id') return uniquePct >= 0.8 ? 16 : 0;
  if (target === 'client') return textValues.length / sample.length >= 0.6 && uniquePct >= 0.15 ? 12 : 0;
  if (target === 'industry') return textValues.length / sample.length >= 0.6 ? 8 : 0;
  return 0;
}

function headerHeuristicScore(target: StandardLoanField, norm: string): number {
  if (!norm) return 0;
  const looksMonetary = /(capital|interes|saldo|monto|importe|pesos|balance|principal|cartera|condonacion|moratori|cobrad|generad|pagad|devengad|ordinari)/.test(norm);
  // "Condonación de Intereses", "Intereses Moratorios Cobrados" are amounts, not a rate; "Saldo vencido" is the overdue part, not the balance.
  const interestAmount = /(condonacion|cobrad|generad|moratori|vigente|vencid|devengad|pagad|por cobrar|acumulad)/.test(norm);
  const overdueAmount = /(vencid|mora|moros|condonacion|cobrad|pagad|historic|interes)/.test(norm) && !/capital/.test(norm);
  if (target === 'loan_id' && /(folio|contrato|credito|cuenta|operacion|referencia)/.test(norm) && /(no|num|numero|id|clave|codigo|cuenta|folio)/.test(norm)) return 35;
  if (target === 'loan_id' && /(prestamo|credito)/.test(norm) && /(intermediario|numero|num|no)/.test(norm)) return 40;
  if (target === 'loan_id' && /^(id|no|num|numero|folio)$/.test(norm)) return 70;
  if (target === 'outstanding_balance' && /^total$/.test(norm)) return 45;
  if (target === 'client' && /(cliente|acreditado|deudor|razon social|empresa|nombre)/.test(norm) && !/(credito|contrato|producto|estatus|estado)/.test(norm)) return 35;
  if (target === 'amount' && /(monto|importe|limite|linea|autorizad|otorgad|dispuest|original)/.test(norm) && !/(saldo|insoluto|vencid|vigente|actual)/.test(norm)) return 35;
  if (target === 'outstanding_balance' && /(saldo|insoluto|balance|capital|principal|cartera)/.test(norm) && !/(tasa|dias)/.test(norm) && !overdueAmount) return 40;
  if (target === 'interest_rate' && /(tasa|rate|tir|tna)/.test(norm)) return 40;
  if (target === 'interest_rate' && /interes/.test(norm) && !interestAmount) return 40;
  if (target === 'loan_status' && /(estatus|status|situacion|condicion|clasificacion|estado credito|estado del activo)/.test(norm)) return 35;
  if (target === 'start_date' && /(fecha|date)/.test(norm) && /(inicio|apertura|otorg|disposicion|alta|originacion)/.test(norm)) return 40;
  if (target === 'end_date' && /(dias|meses)/.test(norm) && /(vencid|mora|atras)/.test(norm)) return 0;
  if (target === 'end_date' && /(fecha|date|vencimiento|maturity|due)/.test(norm) && /(venc|fin|maturity|due|pago final)/.test(norm)) return 40;
  if (target === 'loan_type' && /(producto|tipo|modalidad|subproducto|segmento|programa|plan|esquema)/.test(norm)) return 35;
  if (target === 'days_overdue' && looksMonetary) return 0;
  // "No. pagos vencidos" / "cuotas vencidas" cuentan PAGOS, no días: tomarlos como DPD deja 3 pagos atrasados en "3 días" (vigente).
  if (target === 'days_overdue' && /(pagos|cuotas|mensualidades|amortizaciones|exhibiciones|rentas)/.test(norm) && !/(dias|dpd)/.test(norm)) return 0;
  if (target === 'days_overdue' && /(dpd|dias|mora|atras|vencid|delinquent)/.test(norm)) return 45;
  if (target === 'currency' && /(moneda|divisa|currency)/.test(norm)) return 45;
  if (target === 'industry' && /(giro|sector|industria|actividad|ramo)/.test(norm)) return 35;
  if (target === 'state' && /(estado|entidad|provincia|region|plaza|localidad)/.test(norm) && !/(credito|estatus|status|situacion|condicion)/.test(norm)) return 25;
  if (target === 'file_date' && /(corte|reporte|archivo|periodo)/.test(norm) && /(fecha|date|corte|periodo)/.test(norm)) return 40;
  return 0;
}

function headerMatchScore(target: StandardLoanField, norm: string): { score: number; confidence: MappingNote['confidence']; reasoning: string } {
  if (!norm) return { score: 0, confidence: 'low', reasoning: '' };
  const terms = SYNONYMS[target].map(normalize);
  if (terms.includes(norm)) return { score: 100, confidence: 'high', reasoning: 'Header matched exact loan tape synonym' };
  if (terms.some(t => t && (norm.includes(t) || (norm.length >= 4 && t.includes(norm))))) return { score: 75, confidence: 'medium', reasoning: 'Header matched fuzzy loan tape synonym' };
  const heuristic = headerHeuristicScore(target, norm);
  return heuristic ? { score: heuristic, confidence: 'low', reasoning: 'Header matched semantic loan tape pattern' } : { score: 0, confidence: 'low', reasoning: '' };
}

// How many distinct loan-tape fields a candidate header row names. Used to find the real header under title/summary banners.
export function scoreHeaderRow(cells: any[]): number {
  const targets = Object.keys(SYNONYMS) as StandardLoanField[];
  const hit = new Set<StandardLoanField>();
  for (const c of cells) {
    const norm = normalize(c);
    if (!norm || norm.length > 60) continue;
    for (const t of targets) {
      if (hit.has(t)) continue;
      if (headerMatchScore(t, norm).score >= 40) { hit.add(t); break; }
    }
  }
  return hit.size;
}

function pickColumns(headers: string[], rows: any[] = [], overrides: MappingOverrides = {}) {
  const mapping: Partial<Record<StandardLoanField, string>> = {};
  const notes: MappingNote[] = [];
  const used = new Set<string>();
  const normalized = headers.map(h => ({ header: h, norm: normalize(h) }));

  // Correcciones del analista primero: fijan el campo y sacan la columna del concurso automático.
  const forced: Partial<Record<StandardLoanField, string>> = {};
  normalized.forEach(h => {
    const o = overrides[h.norm];
    if (!o) return;
    used.add(h.header);
    if (o !== 'ignore' && !forced[o]) forced[o] = h.header;
  });

  const capitalVigente = forced.outstanding_balance ? undefined : normalized.find(h => !used.has(h.header) && /capital.*vigente/.test(h.norm) && !/interes/.test(h.norm))?.header;
  const capitalVencido = forced.outstanding_balance ? undefined : normalized.find(h => !used.has(h.header) && /capital.*(vencid|moros|mosor)/.test(h.norm) && !/interes/.test(h.norm))?.header;
  const installmentHeader = normalized.find(h => /^(renta|pago|mensualidad|cuota|amortizacion)( mensual| periodic[oa])?( con iva| sin iva)?$|^renta mensual|^pago mensual|^mensualidad/.test(h.norm))?.header;
  const overdueAmountHeader = normalized.find(h => /^(monto|saldo|importe) (en )?(mora|vencid[oa])$/.test(h.norm))?.header;

  const targetOrder: StandardLoanField[] = [
    'days_overdue', 'outstanding_balance', 'amount', 'interest_rate', 'start_date', 'end_date',
    'loan_id', 'client', 'loan_status', 'loan_type', 'currency', 'industry', 'state', 'file_date',
  ];

  for (const target of targetOrder) {
    if (forced[target]) {
      mapping[target] = forced[target];
      notes.push({ source_header: forced[target] as string, target_term: target, confidence: 'high', reasoning: 'Mapeo corregido por el analista' });
      continue;
    }
    if (target === 'file_date') continue;
    if (target === 'outstanding_balance' && capitalVigente && capitalVencido) continue;
    const candidates = normalized
      .filter(h => !used.has(h.header))
      .map(h => {
        const headerScore = headerMatchScore(target, h.norm);
        const values = rows.map(row => row?.[h.header]);
        const valueScore = valueSampleScore(target, values);
        // "id_cliente" y "nombre_cliente" son sinónimos exactos de client: gana el nombre. Un identificador
        // numérico solo sirve de respaldo cuando no hay ninguna columna con nombres.
        let clientAdjust = 0;
        let idFallbackScore = 0;
        if (target === 'client') {
          const idLike = (/(^| )(id|clave|codigo|cod|num|numero|no)( |$)/.test(h.norm) && !/(nombre|razon|name|acreditado)/.test(h.norm)) || /^rfc( |$)|(^| )rfc$/.test(h.norm);
          const sample = values.filter(v => v !== null && v !== undefined && String(v).trim() !== '').slice(0, 50);
          const mostlyNumeric = sample.length > 0 && sample.filter(v => /^[\d.,\s-]+$/.test(String(v))).length / sample.length >= 0.9;
          if (idLike) clientAdjust -= 60;
          if (mostlyNumeric) clientAdjust -= 40;
          if (idLike || mostlyNumeric) idFallbackScore = headerScore.score + valueScore;
        }
        // Una fecha de corte / reporte describe el archivo, no al crédito: nunca es inicio ni vencimiento.
        const cutoffAsLoanDate = (target === 'start_date' || target === 'end_date') && /(corte|reporte|archivo)/.test(h.norm) ? -1000 : 0;
        return { ...h, score: headerScore.score + valueScore + clientAdjust + cutoffAsLoanDate, headerScore, valueScore, idFallbackScore };
      })
      .filter(h => h.score >= 30)
      .sort((a, b) => b.score - a.score);

    let best = candidates[0];
    if (!best && target === 'client') {
      // No column with names: an explicit client identifier still lets us group by acreditado (concentration, migration).
      best = normalized
        .filter(h => !used.has(h.header))
        .map(h => {
          const headerScore = headerMatchScore(target, h.norm);
          const idLike = /(^| )(id|clave|codigo|cod|num|numero|no)( |$)/.test(h.norm);
          return { ...h, score: headerScore.score, headerScore, valueScore: 0, idFallbackScore: idLike ? headerScore.score : 0 };
        })
        .filter(h => h.idFallbackScore >= 75)
        .sort((a, b) => b.idFallbackScore - a.idFallbackScore)[0];
    }
    if (best) {
      mapping[target] = best.header;
      used.add(best.header);
      notes.push({
        source_header: best.header,
        target_term: target,
        confidence: best.headerScore.confidence === 'high' || best.score >= 85 ? 'high' : best.score >= 55 ? 'medium' : 'low',
        reasoning: best.headerScore.reasoning || `Column inferred from value pattern (${best.valueScore} score)`,
      });
    }
  }

  // Fecha de corte explícita en el archivo (p. ej. "Fecha de corte"): manda sobre el nombre del archivo. Solo se
  // acepta si el encabezado lo dice y la columna es una fecha casi constante (un corte, no fechas por crédito).
  const cutoffColumn = forced.file_date ? undefined : normalized
    .filter(h => !used.has(h.header) && headerMatchScore('file_date', h.norm).score >= 40)
    .find(h => {
      const values = rows.map(row => row?.[h.header]).filter(v => v !== null && v !== undefined && String(v).trim() !== '');
      const dates = values.map(parseDate).filter(Boolean) as string[];
      return values.length > 0 && dates.length / values.length >= 0.9 && new Set(dates).size <= 2;
    });
  if (cutoffColumn) {
    mapping.file_date = cutoffColumn.header;
    used.add(cutoffColumn.header);
    notes.push({ source_header: cutoffColumn.header, target_term: 'file_date', confidence: 'high', reasoning: 'Fecha de corte explícita en el archivo (prevalece sobre el nombre del archivo)' });
  }

  if (capitalVigente && capitalVencido) {
    notes.push({ source_header: `${capitalVigente} + ${capitalVencido}`, target_term: 'outstanding_balance', confidence: 'high', reasoning: 'Prioritized sum of capital vigente and capital vencido' });
  }

  return { mapping, notes, capitalVigente, capitalVencido, overdueAmountHeader, installmentHeader, lockedDpd: !!forced.days_overdue };
}

export interface DpdValidation extends DpdConsistency {
  evidenceHeader: string;
  dpdHeader: string | null;
  strong: boolean;          // bucket numérico (bloquea / corrige) vs estatus genérico (solo advierte)
  switchedFrom?: string;
}

// Regla de negocio (portfolioRules.checkDpdConsistency): si el archivo trae su propio bucket / estatus de cobranza,
// la columna de días de atraso tiene que cuadrar con él. Si no cuadra, se prueba cada columna candidata y se queda la
// que sí cuadra; si ninguna, se reporta para bloquear el import en vez de publicar una calidad de cartera falsa.
function validateDpdColumn(headers: string[], rows: any[], mapping: Partial<Record<StandardLoanField, string>>, notes: MappingNote[], locked = false): DpdValidation | null {
  const evidenceHint = /(bucket|mora|atraso|retraso|cobranza|morosidad|dpd|antiguedad|vencid|estatus|status|estado|clasificacion|tramo|rango)/;
  const notEvidence = /(plazo|meses|residencia|producto|tasa|saldo|monto|importe|fecha|pagos|riesgo|modelo)/;
  const nonEmpty = (h: string) => rows.map(r => r?.[h]).filter(v => v !== null && v !== undefined && String(v).trim() !== '');
  const evidence = headers
    .filter(h => h !== mapping.days_overdue)
    .map(h => ({ h, norm: normalize(h) }))
    .filter(x => evidenceHint.test(x.norm) && !notEvidence.test(x.norm))
    .map(x => {
      const values = nonEmpty(x.h);
      const parsed = values.filter(v => typeof v === 'string' && dpdRangeFromText(v) !== null);
      const strongShare = parsed.length ? parsed.filter(isStrongDpdText).length / parsed.length : 0;
      return { h: x.h, coverage: values.length ? parsed.length / values.length : 0, strong: strongShare >= 0.5 };
    })
    .filter(x => x.coverage >= DPD_CONSISTENCY.minCoverage)
    .sort((a, b) => Number(b.strong) - Number(a.strong) || b.coverage - a.coverage)[0];
  if (!evidence) return null;
  const strong = evidence.strong;

  const balanceOf = (row: any) => (mapping.outstanding_balance ? parseNumber(row[mapping.outstanding_balance]) : null) ?? 1;
  const score = (h: string | undefined) => checkDpdConsistency(rows.map(row => ({
    range: dpdRangeFromText(row?.[evidence.h]),
    dpd: h ? parseNumber(row?.[h]) : null,
    balance: balanceOf(row),
  })));
  const current = mapping.days_overdue;
  const currentCheck = score(current);
  if (current && currentCheck.ok) return { ...currentCheck, evidenceHeader: evidence.h, dpdHeader: current, strong };
  // Evidencia débil (estatus genérico) o columna fijada por el analista: nunca se cambia, solo se reporta.
  if (!strong || locked) return current ? { ...currentCheck, evidenceHeader: evidence.h, dpdHeader: current, strong } : null;

  // Columnas numéricas que podrían ser días de atraso (no montos), excepto la evidencia misma.
  const alternatives = headers
    .filter(h => h !== current && h !== evidence.h && !Object.values(mapping).includes(h))
    .filter(h => {
      const vals = nonEmpty(h).slice(0, 200).map(parseNumber).filter((v): v is number => v !== null);
      return vals.length >= 10 && vals.every(v => v >= 0 && v <= 3650 && Math.abs(v - Math.round(v)) < 1e-6);
    })
    .map(h => ({ h, check: score(h) }))
    .filter(x => x.check.ok && x.check.compared >= DPD_CONSISTENCY.minCompared)
    .sort((a, b) => a.check.mismatchBalancePct - b.check.mismatchBalancePct);
  const best = alternatives[0];
  if (best) {
    mapping.days_overdue = best.h;
    const idx = notes.findIndex(n => n.target_term === 'days_overdue');
    const note: MappingNote = { source_header: best.h, target_term: 'days_overdue', confidence: 'high', reasoning: `Elegida porque cuadra con "${evidence.h}" del propio archivo (${current ? `"${current}" no cuadraba` : 'sin columna previa'})` };
    if (idx >= 0) notes[idx] = note; else notes.push(note);
    return { ...best.check, evidenceHeader: evidence.h, dpdHeader: best.h, strong, switchedFrom: current };
  }
  return current ? { ...currentCheck, evidenceHeader: evidence.h, dpdHeader: current, strong } : null;
}

export function standardizeLoanTape(rows: any[], fileName?: string, overrides: MappingOverrides = {}) {
  const headers = rows[0] ? Object.keys(rows[0]) : [];
  const { mapping, notes, capitalVigente, capitalVencido, overdueAmountHeader, installmentHeader, lockedDpd } = pickColumns(headers, rows, overrides);
  const dpdValidation = validateDpdColumn(headers, rows, mapping, notes, lockedDpd);
  const fallbackFileDate = parseFileDate(fileName);

  const standardized: StandardLoan[] = rows.map(row => {
    const get = (key: StandardLoanField) => mapping[key] ? row[mapping[key] as string] : null;
    const capitalA = capitalVigente ? parseNumber(row[capitalVigente]) : null;
    const capitalB = capitalVencido ? parseNumber(row[capitalVencido]) : null;
    const balance = capitalA !== null || capitalB !== null
      ? (capitalA || 0) + (capitalB || 0)
      : parseNumber(get('outstanding_balance'));
    const explicitDpd = parseNumber(get('days_overdue'));
    const overdueAmount = overdueAmountHeader ? parseNumber(row[overdueAmountHeader]) : null;
    const statusText = get('loan_status') ? String(get('loan_status')).trim() : null;
    const endDate = parseDate(get('end_date'));
    const rowFileDate = parseDate(get('file_date')) || fallbackFileDate;
    const overdueFlag: boolean | null = overdueAmount !== null ? overdueAmount > 0
      : capitalB !== null && capitalB > 0 ? true
      : statusText && /(vencid|mora|atras)/.test(normalize(statusText)) ? true
      : capitalA !== null ? false
      : null;
    const dpdInfo = resolveDpd({ reported: explicitDpd, overdueFlag, cutoff: rowFileDate, dueDate: endDate });
    const inferredDpd = dpdInfo.dpd;

    return {
      loan_id: get('loan_id') ? String(get('loan_id')).trim() : null,
      client: get('client') ? String(get('client')).trim() : null,
      amount: parseNumber(get('amount')),
      outstanding_balance: balance,
      interest_rate: parseRate(get('interest_rate')),
      loan_status: statusText,
      start_date: parseDate(get('start_date')),
      end_date: endDate,
      loan_type: get('loan_type') ? String(get('loan_type')).trim() : null,
      days_overdue: inferredDpd,
      dpd_source: dpdInfo.source,
      installment: installmentHeader ? parseNumber(row[installmentHeader]) : null,
      currency: get('currency') ? String(get('currency')).trim() : 'MXN',
      industry: get('industry') ? String(get('industry')).trim() : null,
      state: get('state') ? String(get('state')).trim() : null,
      file_date: rowFileDate,
    };
  // Un renglón es crédito solo si trae algo que lo identifique o lo mida (ID, cliente, monto o saldo). Fórmulas
  // copiadas hacia abajo ("Meses", "Segmentación") dejaban filas fantasma que heredaban la fecha del nombre del archivo.
  }).filter(row => [row.loan_id, row.client, row.amount, row.outstanding_balance].some(v => v !== null && v !== undefined && v !== ''));

  return { standardized, mappingReport: notes, dpdValidation };
}

export function activeRows(rows: StandardLoan[]) {
  return rows.filter(r => !PAID_STATUSES.includes(normalize(r.loan_status)));
}

export function latestRows(rows: StandardLoan[]) {
  const dates = Array.from(new Set(rows.map(r => r.file_date).filter(Boolean) as string[])).sort();
  const latest = dates[dates.length - 1] || null;
  return { latest, rows: latest ? rows.filter(r => r.file_date === latest) : rows };
}

export function latestAndPreviousRows(rows: StandardLoan[]) {
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

export function sum(rows: StandardLoan[]) {
  return rows.reduce((acc, r) => acc + (r.outstanding_balance || 0), 0);
}

export function pct(value: number, total: number) {
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

export function quality(rows: StandardLoan[]) {
  const total = sum(rows);
  const groups = {
    vigente: rows.filter(r => classifyDpd(r.days_overdue) === 'vigente'),
    atrasada: rows.filter(r => classifyDpd(r.days_overdue) === 'atrasada'),
    vencida: rows.filter(r => classifyDpd(r.days_overdue) === 'vencida'),
    sin_dato: rows.filter(r => classifyDpd(r.days_overdue) === 'sin_dato'),
  };
  return Object.fromEntries(Object.entries(groups).map(([k, v]) => {
    const balance = sum(v);
    return [k, { count: v.length, balance, pct: pct(balance, total) }];
  }));
}

export function dpdDistribution(rows: StandardLoan[]) {
  const total = sum(rows);
  const buckets = DPD_BUCKET_DEFS;
  const distribution: Array<{ bucket: string; count: number; balance: number; pct: number }> = buckets.map(b => {
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

export function groupBy(rows: StandardLoan[], field: StandardLoanField, limit = 10) {
  const total = sum(rows);
  const map = new Map<string, StandardLoan[]>();
  for (const row of rows) {
    const key = String(row[field] || '').trim();
    if (!key || ['total', 'top', 'otros'].includes(normalize(key))) continue;
    const bucket = map.get(key);
    if (bucket) bucket.push(row);
    else map.set(key, [row]);
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

export function weightedAverage(rows: StandardLoan[], field: 'days_overdue' | 'interest_rate') {
  const usable = rows.filter(row => row[field] !== null && Number.isFinite(row[field]) && (row.outstanding_balance || 0) > 0);
  const weight = sum(usable);
  if (!weight) return null;
  return usable.reduce((total, row) => total + Number(row[field]) * (row.outstanding_balance || 0), 0) / weight;
}

export function topShare(rows: StandardLoan[], count: number) {
  const total = sum(rows);
  const largest = [...rows]
    .sort((a, b) => (b.outstanding_balance || 0) - (a.outstanding_balance || 0))
    .slice(0, count);
  return pct(sum(largest), total);
}

export function loanTypeProfile(rows: StandardLoan[]) {
  const total = sum(rows);
  const map = new Map<string, StandardLoan[]>();
  for (const row of rows) {
    const key = String(row.loan_type || '').trim();
    if (!key) continue;
    const bucket = map.get(key);
    if (bucket) bucket.push(row);
    else map.set(key, [row]);
  }
  return Array.from(map.entries()).map(([name, items]) => {
    const balance = sum(items);
    const avg = (field: StandardLoanField) => {
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

function isSummaryRow(row: StandardLoan) {
  return Boolean(row.source_granularity && row.source_granularity !== 'loan');
}

function isSummaryOnly(rows: StandardLoan[]) {
  return rows.length > 0 && rows.every(isSummaryRow);
}

function summaryBuckets(rows: any[] | undefined, total: number) {
  return (rows || [])
    .filter(row => row && row.name && Number.isFinite(Number(row.balance)))
    .map(row => ({
      name: String(row.name).trim(),
      count: null,
      balance: Number(row.balance) || 0,
      pct: row.pct !== null && row.pct !== undefined ? Number(row.pct) : pct(Number(row.balance) || 0, total),
      severity: 'low',
    }));
}

export function buckets(rows: StandardLoan[], field: 'amount' | 'outstanding_balance') {
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
    const validationFields = r.source_granularity && r.source_granularity !== 'loan'
      ? ['outstanding_balance'] as StandardLoanField[]
      : ROW_VALIDATION_FIELDS;
    validationFields.forEach(field => {
      if (r[field] === null || r[field] === undefined || r[field] === '') {
        issues.push({
          loan_id: loanId,
          rule_id: 'missing',
          field,
          message: `Campo necesario para ciertos análisis sin mapear o vacío: ${field}`,
          severity: field === BASE_ANALYSIS_FIELD ? 'high' : 'medium',
        });
      }
    });
    if (r.amount !== null && r.amount <= 0) issues.push({ loan_id: loanId, rule_id: 'amount_positive', field: 'amount', message: 'amount debe ser mayor a cero cuando viene informado', severity: 'medium' });
    if (r.outstanding_balance !== null && r.outstanding_balance < 0) issues.push({ loan_id: loanId, rule_id: 'balance_non_negative', field: 'outstanding_balance', message: 'outstanding_balance no puede ser negativo', severity: 'high' });
    if (r.amount !== null && r.outstanding_balance !== null && r.outstanding_balance > r.amount) {
      const overAmount = r.outstanding_balance - r.amount;
      const tolerance = Math.max(100, Math.abs(r.amount) * 0.01);
      if (overAmount > tolerance) {
        issues.push({
          loan_id: loanId,
          rule_id: 'balance_lte_amount',
          field: 'outstanding_balance',
          message: 'outstanding_balance excede amount fuera de tolerancia; revisar si amount es linea original o si hubo capitalizacion.',
          severity: 'medium',
        });
      }
    }
    if (r.interest_rate !== null && r.interest_rate < 0) issues.push({ loan_id: loanId, rule_id: 'rate_non_negative', field: 'interest_rate', message: 'interest_rate no puede ser negativa', severity: 'medium' });
    if (r.days_overdue !== null && r.days_overdue < 0) issues.push({ loan_id: loanId, rule_id: 'dpd_non_negative', field: 'days_overdue', message: 'days_overdue no puede ser negativo', severity: 'high' });
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

function fieldCoverage(rows: StandardLoan[], mappingReport: MappingNote[], field: StandardLoanField) {
  const mapped = new Set(mappingReport.map(m => m.target_term)).has(field) || (field === 'currency' && rows.some(r => !!r.currency));
  const presentRows = rows.filter(r => r[field] !== null && r[field] !== undefined && r[field] !== '').length;
  const missingRows = rows.length - presentRows;
  const missingPct = rows.length ? missingRows / rows.length : 1;
  return { field, mapped, presentRows, missingRows, missingPct, usablePct: rows.length ? presentRows / rows.length : 0 };
}

function missingFieldProfile(rows: StandardLoan[], mappingReport: MappingNote[] = []) {
  const isSummaryOnly = rows.length > 0 && rows.every(row => row.source_granularity && row.source_granularity !== 'loan');
  return CRITICAL_FIELDS.map(field => {
    const coverage = fieldCoverage(rows, mappingReport, field);
    const missingPct = coverage.missingPct;
    const missingRows = coverage.missingRows;
    const isBase = field === BASE_ANALYSIS_FIELD;
    const isCore = !isSummaryOnly && (field === 'loan_id' || field === 'client' || field === 'days_overdue');
    const severity: Severity = isBase
      ? (!coverage.mapped || missingPct > 0.2 ? 'high' : missingRows > 0 ? 'medium' : 'low')
      : isCore
        ? (missingPct > 0.8 ? 'high' : !coverage.mapped || missingRows > 0 ? 'medium' : 'low')
        : (!coverage.mapped || missingPct > 0.5 ? 'medium' : missingRows > 0 ? 'medium' : 'low');
    return {
      field,
      mapped: coverage.mapped,
      missingRows,
      missingPct,
      severity,
      impact: FIELD_IMPACT[field],
    };
  }).sort((a, b) => {
    const rank = { high: 0, medium: 1, low: 2 };
    return rank[a.severity] - rank[b.severity] || b.missingPct - a.missingPct;
  });
}

function buildAnalysisCoverage(rows: StandardLoan[], mappingReport: MappingNote[] = []) {
  const coverage = Object.fromEntries(PROFILE_FIELDS.map(field => [field, fieldCoverage(rows, mappingReport, field)])) as Record<StandardLoanField, ReturnType<typeof fieldCoverage>>;
  const hasUsable = (field: StandardLoanField, minCoverage = 0.5) => coverage[field]?.usablePct >= minCoverage;

  return ANALYSIS_REQUIREMENTS.map(item => {
    const missingRequired = item.required.filter(field => !hasUsable(field, field === BASE_ANALYSIS_FIELD ? 0.8 : 0.5));
    const missingPartial = item.partial.filter(field => !hasUsable(field, 0.5));
    const status: CapabilityStatus = missingRequired.length
      ? 'blocked'
      : missingPartial.length
        ? 'partial'
        : 'available';
    const missing = [...missingRequired, ...missingPartial];
    return {
      key: item.key,
      label: item.label,
      status,
      missing,
      reason: missing.length ? `Limitado por: ${missing.join(', ')}` : 'Listo con los campos actuales.',
    };
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
  const highValidationCount = validation.filter(v => v.severity === 'high').length;
  const mediumValidationCount = validation.filter(v => v.severity === 'medium').length;
  const duplicateCount = validation.filter(v => v.rule_id === 'duplicate_loan_id').length;
  const analysisCoverage = buildAnalysisCoverage(rows, mappingReport);
  const availableAnalyses = analysisCoverage.filter(item => item.status !== 'blocked');
  const blockedAnalyses = analysisCoverage.filter(item => item.status === 'blocked');
  const fullAnalyses = analysisCoverage.filter(item => item.status === 'available');
  const partialAnalyses = analysisCoverage.filter(item => item.status === 'partial');
  const summaryOnly = isSummaryOnly(rows);
  const scoredCoreAnalyses = analysisCoverage.filter(item => CORE_ANALYSIS_KEYS.has(item.key));
  const coreCapabilityScore = scoredCoreAnalyses.reduce((score, item) => {
    if (item.status === 'available') return score + 1;
    if (item.status === 'partial') return score + 0.7;
    return score;
  }, 0) / Math.max(scoredCoreAnalyses.length, 1) * 100;
  const optionalCapabilityBonus = analysisCoverage
    .filter(item => !CORE_ANALYSIS_KEYS.has(item.key) && item.status !== 'blocked')
    .reduce((score, item) => score + (item.status === 'available' ? 1 : 0.5), 0);
  const summaryCapabilityScore = totalRows && summaryOnly
    ? (analysisCoverage.some(item => item.key === 'portfolio_balance' && item.status !== 'blocked') ? 55 : 0)
      + (analysisCoverage.some(item => item.key === 'product_mix' && item.status !== 'blocked') ? 45 : 0)
    : null;
  const capabilityScore = totalRows
    ? summaryCapabilityScore ?? Math.min(100, coreCapabilityScore + optionalCapabilityBonus)
    : 0;
  const qualityPenalty = Math.min(18, highValidationCount / Math.max(totalRows, 1) * 100)
    + (summaryOnly ? 0 : Math.min(8, mediumValidationCount / Math.max(totalRows, 1) * 20))
    + highMissing.filter(f => f.field === BASE_ANALYSIS_FIELD).length * 20;
  const readinessScore = Math.max(0, Math.min(100, Math.round(
    capabilityScore - qualityPenalty
  )));
  const canAnalyze = totalRows > 0 && availableAnalyses.length > 0;
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
    unmappedCriticalFields: missingFields.filter(f => !f.mapped && f.severity === 'high').map(f => f.field),
    missingFields,
    analysisCoverage,
    availableAnalyses,
    blockedAnalyses,
    validationCount: validation.length,
    highValidationCount,
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
    // Todo sale del cálculo vigente (portfolioRules); solo se conservan las verificaciones de congruencia con contrato.
    const analysis = storedAnalysis
      ? { ...localAnalysis, congruencyChecks: storedAnalysis.congruencyChecks?.length ? storedAnalysis.congruencyChecks : localAnalysis.congruencyChecks }
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
    const productRows = loanTypeProfile(latest).slice(0, 10).map(r => ({ ...r, balance: fmtMoney(r.balance), pct: fmtPct(r.pct), avg_interest_rate: r.avg_interest_rate === null ? 'N/D' : fmtPct(r.avg_interest_rate), avg_days_overdue: r.avg_days_overdue?.toFixed(1) ?? 'N/D' }));
    return `Perfil por producto:\n${answerRows(productRows, ['name', 'count', 'balance', 'pct', 'avg_interest_rate', 'avg_days_overdue'])}`;
  }
  return analysis?.executiveSummary || `Resumen: ${latest.length} registros activos, saldo ${fmtMoney(total)}. Preguntas útiles: "qué falta", "top concentración", "mora", "cambios vs mes anterior", "por producto".`;
}

export function anomalies(rows: StandardLoan[]) {
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
    (['start_date', 'end_date', 'loan_type', 'industry', 'currency', 'state', 'client'] as StandardLoanField[]).forEach(field => {
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
  const selectedSummary = selected && !Array.isArray(selected.extractedData) ? selected.extractedData?._summary : null;
  const selectedPeriod = selectedRows.map(row => row.file_date).filter(Boolean).sort().at(-1) || null;
  const analysisRows = selected && selectedPeriod
    ? allStandardized.filter(row => !row.file_date || row.file_date <= selectedPeriod)
    : allStandardized;
  const active = activeRows(analysisRows);
  const activeOrSelected = active.length ? active : selectedRows;
  const { previous, latestRows: latest, previousRows } = latestAndPreviousRows(activeOrSelected);
  const latestIsSummary = isSummaryOnly(latest);
  const q: any = quality(latest);
  const pq: any = quality(previousRows);
  const dpd = latestIsSummary ? [] : dpdDistribution(latest);
  const total = sum(latest);
  const previousTotal = sum(previousRows);
  const loanCount = latestIsSummary ? null : new Set(latest.map(r => r.loan_id).filter(Boolean)).size;
  const latestPeriod = latest[0]?.file_date || null;
  const registrosLatest = new Set(analysisRows.filter(r => r.file_date === latestPeriod).map(r => r.loan_id).filter(Boolean)).size;
  const previousLoanCount = new Set(previousRows.map(r => r.loan_id).filter(Boolean)).size;
  const clientCount = latestIsSummary ? null : new Set(latest.map(r => r.client).filter(Boolean)).size;
  const previousClientCount = new Set(previousRows.map(r => r.client).filter(Boolean)).size;
  const validation = validate(selectedRows);
  const concentrations = {
    by_client: latestIsSummary ? [] : groupBy(latest, 'client', 20),
    by_loan_type: loanTypeProfile(latest),
    by_state: summaryBuckets(selectedSummary?.by_state, total).length ? summaryBuckets(selectedSummary?.by_state, total) : groupBy(latest, 'state', 20),
    by_industry: groupBy(latest, 'industry', 20),
    buckets_outstanding: buckets(latest, 'outstanding_balance'),
    buckets_amount: buckets(latest, 'amount'),
  };
  const vencidaPct = latestIsSummary ? null : q.vencida?.pct || 0;
  const atrasadaPct = latestIsSummary ? null : q.atrasada?.pct || 0;
  const previousVencidaPct = pq.vencida?.pct || 0;
  const previousAtrasadaPct = pq.atrasada?.pct || 0;
  const maxClientPct = concentrations.by_client[0]?.pct || 0;
  const previousMaxClientPct = groupBy(previousRows, 'client', 1)[0]?.pct || 0;
  const weightedDpd = weightedAverage(latest, 'days_overdue');
  const previousWeightedDpd = weightedAverage(previousRows, 'days_overdue');
  const weightedRate = weightedAverage(latest, 'interest_rate');
  const previousWeightedRate = weightedAverage(previousRows, 'interest_rate');
  const top10Pct = latestIsSummary ? null : topShare(latest, 10); // los 10 CRÉDITOS más grandes
  const top10ClientsPct = latestIsSummary ? null : concentrations.by_client.slice(0, 10).reduce((a, c) => a + c.pct, 0); // los 10 CLIENTES más grandes
  const zeroDpdPct = latestIsSummary ? 0 : dpd.find(d => d.bucket === '0 dias')?.pct || 0;
  const previousTop10Pct = topShare(previousRows, 10);
  const missingDpdPct = latestIsSummary ? 0 : q.sin_dato?.pct || 0;
  const highValidation = validation.filter(item => item.severity === 'high');
  const validationPenalty = Math.min(15, highValidation.length / Math.max(selectedRows.length, 1) * 20);
  const riskScore = Math.min(100, Math.round(
    ((vencidaPct || 0) * 100 * 4)
    + ((atrasadaPct || 0) * 100 * 1.5)
    + (maxClientPct > 0.3 ? 15 : maxClientPct > RISK_THRESHOLDS.clientConcentrationAlert ? 8 : 0)
    + (missingDpdPct * 20)
    + validationPenalty
  ));
  const overallStatus = (vencidaPct || 0) > RISK_THRESHOLDS.vencidaAlert || riskScore >= 70 ? 'critical' : (vencidaPct || 0) >= RISK_THRESHOLDS.vencidaWarn || (atrasadaPct || 0) > RISK_THRESHOLDS.atrasadaWarn || riskScore >= 40 ? 'warning' : 'good';
  const dataProfile = buildLoanTapeDataProfile(selectedRows, selectedMappingReport);
  const anomalySet: any = latestIsSummary ? {} : anomalies(activeOrSelected);
  const trendDirection = previousRows.length
    ? trend(((vencidaPct || 0) * 2) + (atrasadaPct || 0) + maxClientPct, (previousVencidaPct * 2) + previousAtrasadaPct + previousMaxClientPct, true)
    : 'stable';

  const findings = [
    ...dataProfile.missingFields.filter(f => f.severity !== 'low').slice(0, 5).map(f => ({ severity: f.severity, category: 'Preparación de Datos', title: `${f.field} ${f.mapped ? 'incompleto' : 'sin mapear'}`, detail: f.mapped ? `${fmtPct(f.missingPct)} de filas sin dato.` : 'No encontré una columna equivalente en el archivo.', recommendation: f.impact })),
    ...highValidation.slice(0, 10).map(v => ({ severity: v.severity, category: 'Calidad de Datos', title: v.rule_id, detail: `${v.loan_id}: ${v.message}`, recommendation: 'Revisar mapeo o dato fuente.' })),
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
    ? ` El mayor cliente es ${topClient.name} con ${fmtPct(topClient.pct)} del saldo; los 10 clientes más grandes concentran ${fmtPct(top10ClientsPct || 0)} y los 10 créditos más grandes ${fmtPct(top10Pct || 0)}.`
    : '';
  const summaryText = latestIsSummary
    ? `Resumen agregado por producto${concentrations.by_state.length ? ' y estado' : ''}: ${latest.length} rubros por ${fmtMoney(total)}. No incluye crédito, cliente ni DPD; por eso no se calculan mora, roll-rate ni concentración por acreditado para este corte.`
    : null;

  return {
    overallStatus,
    riskScore,
    executiveSummary: summaryText || `Cartera de ${loanCount} créditos vivos (${liveLoansDetail(Math.max(registrosLatest, loanCount || 0), loanCount || 0)}) y ${clientCount} clientes por ${fmtMoney(total)}: vigente ${fmtPct(q.vigente?.pct || 0)} (0-${QUALITY_RULES.vigenteMaxDpd} DPD; ${fmtPct(zeroDpdPct)} al corriente), atrasada ${fmtPct(atrasadaPct || 0)}, vencida ${fmtPct(vencidaPct || 0)}${missingDpdPct ? ` y ${fmtPct(missingDpdPct)} sin DPD` : ''}.${concentrationText}${comparisonText}`,
    trendDirection,
    portfolioQuality: q,
    dpd_distribution: dpd,
    concentrations,
    anomalies: anomalySet,
    validation,
    metrics: withThresholds([
      { name: 'Saldo total outstanding', latestValue: fmtMoney(total), previousValue: previousRows.length ? fmtMoney(previousTotal) : undefined, change: fmtChange(total, previousTotal, 'money'), trend: trend(total, previousTotal), status: 'neutral', congruent: true },
      { name: 'Créditos vivos (sin liquidados)', latestValue: loanCount === null ? 'N/D' : String(loanCount), previousValue: previousRows.length && loanCount !== null ? String(previousLoanCount) : undefined, change: loanCount === null ? undefined : fmtChange(loanCount, previousLoanCount, 'number'), trend: loanCount === null ? 'stable' : trend(loanCount, previousLoanCount), status: 'good', congruent: true },
      { name: 'Numero de clientes', latestValue: clientCount === null ? 'N/D' : String(clientCount), previousValue: previousRows.length && clientCount !== null ? String(previousClientCount) : undefined, change: clientCount === null ? undefined : fmtChange(clientCount, previousClientCount, 'number'), trend: clientCount === null ? 'stable' : trend(clientCount, previousClientCount), status: 'good', congruent: true },
      { name: '% cartera vencida', latestValue: vencidaPct === null ? 'N/D' : fmtPct(vencidaPct), previousValue: previousRows.length && vencidaPct !== null ? fmtPct(previousVencidaPct) : undefined, change: vencidaPct === null ? undefined : fmtChange(vencidaPct, previousVencidaPct, 'pct'), trend: vencidaPct === null ? 'stable' : trend(vencidaPct, previousVencidaPct, true), status: vencidaPct !== null && vencidaPct > RISK_THRESHOLDS.vencidaAlert ? 'critical' : vencidaPct !== null && vencidaPct >= RISK_THRESHOLDS.vencidaWarn ? 'warning' : 'good', congruent: true },
      { name: '% cartera atrasada', latestValue: atrasadaPct === null ? 'N/D' : fmtPct(atrasadaPct), previousValue: previousRows.length && atrasadaPct !== null ? fmtPct(previousAtrasadaPct) : undefined, change: atrasadaPct === null ? undefined : fmtChange(atrasadaPct, previousAtrasadaPct, 'pct'), trend: atrasadaPct === null ? 'stable' : trend(atrasadaPct, previousAtrasadaPct, true), status: atrasadaPct !== null && atrasadaPct > RISK_THRESHOLDS.atrasadaWarn ? 'warning' : 'good', congruent: true },
      { name: 'Concentracion max cliente', latestValue: fmtPct(maxClientPct), previousValue: previousRows.length ? fmtPct(previousMaxClientPct) : undefined, change: fmtChange(maxClientPct, previousMaxClientPct, 'pct'), trend: trend(maxClientPct, previousMaxClientPct, true), status: maxClientPct > RISK_THRESHOLDS.clientConcentrationAlert ? 'critical' : maxClientPct > RISK_THRESHOLDS.clientConcentrationWarn ? 'warning' : 'good', congruent: true },
      { name: 'Concentracion Top 10 clientes', latestValue: top10ClientsPct === null ? 'N/D' : fmtPct(top10ClientsPct), previousValue: undefined, change: undefined, trend: 'stable', status: top10ClientsPct !== null && top10ClientsPct > RISK_THRESHOLDS.top10Alert ? 'critical' : top10ClientsPct !== null && top10ClientsPct > RISK_THRESHOLDS.top10Warn ? 'warning' : 'good', congruent: true },
      { name: 'Concentracion Top 10 creditos', latestValue: top10Pct === null ? 'N/D' : fmtPct(top10Pct), previousValue: previousRows.length && top10Pct !== null ? fmtPct(previousTop10Pct) : undefined, change: top10Pct === null ? undefined : fmtChange(top10Pct, previousTop10Pct, 'pct'), trend: top10Pct === null ? 'stable' : trend(top10Pct, previousTop10Pct, true), status: top10Pct !== null && top10Pct > RISK_THRESHOLDS.top10Alert ? 'critical' : top10Pct !== null && top10Pct > RISK_THRESHOLDS.top10Warn ? 'warning' : 'good', congruent: true },
      { name: 'DPD ponderado por saldo', latestValue: weightedDpd === null ? 'N/D' : `${weightedDpd.toFixed(1)} dias`, previousValue: previousWeightedDpd === null ? undefined : `${previousWeightedDpd.toFixed(1)} dias`, change: weightedDpd !== null && previousWeightedDpd !== null ? fmtChange(weightedDpd, previousWeightedDpd, 'number') : undefined, trend: weightedDpd !== null && previousWeightedDpd !== null ? trend(weightedDpd, previousWeightedDpd, true) : 'stable', status: weightedDpd !== null && weightedDpd > RISK_THRESHOLDS.waDpdAlert ? 'critical' : weightedDpd !== null && weightedDpd > RISK_THRESHOLDS.waDpdWarn ? 'warning' : 'good', congruent: true },
      { name: 'Tasa ponderada por saldo', latestValue: weightedRate === null ? 'N/D' : fmtPct(weightedRate), previousValue: previousWeightedRate === null ? undefined : fmtPct(previousWeightedRate), change: weightedRate !== null && previousWeightedRate !== null ? `${weightedRate - previousWeightedRate >= 0 ? '+' : ''}${((weightedRate - previousWeightedRate) * 100).toFixed(1)} pp` : undefined, trend: weightedRate !== null && previousWeightedRate !== null ? trend(weightedRate, previousWeightedRate) : 'stable', status: 'good', congruent: true },
    ].concat(latestIsSummary ? [] : imorMetricRows(latest, previousRows))),
    findings,
    congruencyChecks: [],
  };
}


// Analyses saved before a business-rule change keep the old classification inside `_analysis`. Whenever a saved analysis
// is read, its quality/risk fields are refreshed from the standardized rows with the CURRENT rules (portfolioRules), so
// no screen can show a stale "vigente". The summary text and findings are regenerated too, so no stale percentage survives.
// IMOR 90+ / 30+ total y por antigüedad (<16, 16-35, 36+ meses) contra el corte anterior.
function imorMetricRows(latest: StandardLoan[], previous: StandardLoan[]) {
  const cur = imorBreakdown(latest);
  const prev = previous.length ? imorBreakdown(previous) : [];
  const rows: any[] = [];
  cur.filter(r => r.label !== 'Sin fecha de originación').forEach(r => {
    const p = prev.find(x => x.label === r.label);
    (['imor90', 'imor30'] as const).forEach(k => {
      const v = r[k]; const pv = p ? p[k] : null;
      const name = `${k === 'imor90' ? 'IMOR 90+' : 'IMOR 30+'} · ${r.label === 'Total cartera' ? 'total' : r.label}`;
      rows.push({
        name, latestValue: v === null ? 'N/D' : fmtPct(v), previousValue: pv === null || pv === undefined ? undefined : fmtPct(pv),
        change: v !== null && pv !== null && pv !== undefined ? fmtChange(v, pv, 'pct') : undefined,
        trend: v !== null && pv !== null && pv !== undefined ? trend(v, pv, true) : 'stable',
        status: v === null ? 'neutral' : k === 'imor90' ? (v > RISK_THRESHOLDS.vencidaAlert ? 'critical' : v >= RISK_THRESHOLDS.vencidaWarn ? 'warning' : 'good') : (v > RISK_THRESHOLDS.atrasadaWarn ? 'warning' : 'good'),
        congruent: true,
      });
    });
  });
  return rows;
}

// "Umbral de alerta" de cada métrica: sale de portfolioRules (no hay límite contractual capturado por métrica).
const pctTxt = (v: number) => `${(v * 100).toLocaleString('es-MX', { maximumFractionDigits: 1 })}%`;
const METRIC_THRESHOLDS: Record<string, string> = {
  '% cartera vencida': `Atención ≥${pctTxt(RISK_THRESHOLDS.vencidaWarn)} · Alerta >${pctTxt(RISK_THRESHOLDS.vencidaAlert)}`,
  '% cartera atrasada': `Atención >${pctTxt(RISK_THRESHOLDS.atrasadaWarn)}`,
  'Concentracion max cliente': `Atención >${pctTxt(RISK_THRESHOLDS.clientConcentrationWarn)} · Alerta >${pctTxt(RISK_THRESHOLDS.clientConcentrationAlert)}`,
  'Concentracion Top 10 clientes': `Atención >${pctTxt(RISK_THRESHOLDS.top10Warn)} · Alerta >${pctTxt(RISK_THRESHOLDS.top10Alert)}`,
  'DPD ponderado por saldo': `Atención >${RISK_THRESHOLDS.waDpdWarn} días · Alerta >${RISK_THRESHOLDS.waDpdAlert} días`,
};
function withThresholds<T extends { name: string; contractLimit?: string }>(metrics: T[]): T[] {
  const byName = (name: string) => METRIC_THRESHOLDS[name]
    || (name.startsWith('IMOR 90+') ? METRIC_THRESHOLDS['% cartera vencida'] : name.startsWith('IMOR 30+') ? `Atención >${pctTxt(RISK_THRESHOLDS.atrasadaWarn)}` : undefined);
  return metrics.map(m => (byName(m.name) ? { ...m, contractLimit: byName(m.name) } : m));
}

// La tabla de métricas compara contra el corte inmediato anterior: por eso se calcula con TODOS los tapes del
// cliente (`context`), no solo con el tape seleccionado. Sin contexto, no hay "Anterior / Cambio / Tendencia".
const contextAnalysisCache = new WeakMap<object, Map<string, StructuredLoanTapeAnalysis>>();
export function storedAnalysisFor(tape: LoanTape_DB | null | undefined, context: LoanTape_DB[] = []): StructuredLoanTapeAnalysis | null {
  const stored = tape?.extractedData?._analysis as StructuredLoanTapeAnalysis | undefined;
  if (!tape || !stored) return null;
  if (!Array.isArray(tape.extractedData?._standardized)) return stored;
  const key = tape.extractedData as object;
  const peers = context.filter(t => t.id !== tape.id && Array.isArray(t.extractedData?._standardized));
  const ctxKey = peers.map(t => `${t.id}:${t.extractedData?._standardized?.length}`).sort().join('|');
  const byCtx = contextAnalysisCache.get(key) || new Map<string, StructuredLoanTapeAnalysis>();
  if (!contextAnalysisCache.has(key)) contextAnalysisCache.set(key, byCtx);
  const hit = byCtx.get(ctxKey);
  if (hit) return hit;
  const fresh = analyzeLoanTapesLocally([tape, ...peers], tape.id);
  // Todo número y texto sale del cálculo vigente (executiveSummary y findings incluidos); solo se conserva lo que no se calcula local.
  const merged: StructuredLoanTapeAnalysis = { ...fresh, congruencyChecks: stored.congruencyChecks?.length ? stored.congruencyChecks : fresh.congruencyChecks };
  byCtx.set(ctxKey, merged);
  return merged;
}
