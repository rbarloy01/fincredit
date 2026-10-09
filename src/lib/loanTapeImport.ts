// Self-validating loan-tape importer: reads EVERY sheet of a workbook, detects the
// header row (which may not be row 1), maps columns via format profiles (SIAC, CAUDEX,
// …), falls back to the generic synonym mapper for unknown single-sheet formats, merges
// all sheets, and produces a reconciliation report that flags the failure that bit us
// once: a sheet full of data that no profile could read (→ understated portfolio).
//
// Pure & framework-free: the caller extracts each sheet as an array-of-arrays
// (`XLSX.utils.sheet_to_json(sheet, { header: 1 })`) and passes them here, so this
// module has no xlsx dependency and is trivially unit-testable.

import {
  type StandardLoan,
  type MappingNote,
  standardizeLoanTape,
  buildLoanTapeDataProfile,
  parseDate,
  parseLoanTapePeriodText,
  parseNumber,
  normalize,
  scoreHeaderRow,
  type DpdValidation,
  type MappingOverrides,
  activeRows,
} from './loanTapeAnalytics';
import { loanStatusFromDpd, DPD_PROXY_DAYS, statusDpdConflicts } from './portfolioRules';
import { buildSourceTable, type SourceTable } from './sourceColumns';
import { inferLoanIds } from './loanIdentity';

// push(...arr) revienta la pila con cientos de miles de filas (archivos que declaran A1:…1048576).
function appendAll<T>(target: T[], items: T[]) {
  for (const item of items) target.push(item);
}


export type SheetInput = { name: string; rows: any[][] };

type Field =
  | 'loan_id' | 'client' | 'amount' | 'capVig' | 'capVen' | 'outstanding_balance'
  | 'interest_rate' | 'start_date' | 'end_date' | 'loan_type' | 'days_overdue' | 'loan_status' | 'state';

interface SheetProfile {
  name: string;
  headerProbe: string[];                       // raw; ALL must appear in the header row
  columnMap: Partial<Record<Field, string[]>>; // raw candidate header names
}

const PROFILES: SheetProfile[] = [
  {
    name: 'SIAC',
    headerProbe: ['Clave de Cliente'],
    columnMap: {
      loan_id: ['No. de Crédito'], client: ['Nombre (s)', 'Nombre de Grupo'], amount: ['Monto'],
      capVig: ['Capital vigente'], capVen: ['Capital Vencido'], interest_rate: ['Tasa'],
      start_date: ['Fecha de otorgamiento'], end_date: ['Fecha de vencimiento'],
      loan_type: ['Tipo de contrato'], days_overdue: ['Días de Atraso'], state: ['Estado'],
    },
  },
  {
    name: 'CAUDEX',
    headerProbe: ['No. Cliente', 'Nombre Cliente'],
    columnMap: {
      loan_id: ['No. Cuenta'], client: ['Nombre Cliente'], amount: ['Importe Dispuesto'],
      capVig: ['Capital Vigente'], capVen: ['Capital Vencido'], interest_rate: ['Tasa Final', 'Tasa Base'],
      start_date: ['Fecha Apertura'], end_date: ['Fecha Vencimiento'],
      loan_type: ['Descripcion Producto'], days_overdue: ['Días de atraso', 'Dias Atraso'], state: ['Descripcion Estado'],
    },
  },
  {
    name: 'COFINE',
    headerProbe: ['Número de Préstamo Intermediario ', 'Saldo Total (pesos)', 'Días de Vencidos.'],
    columnMap: {
      loan_id: ['Número de Préstamo Intermediario ', 'Numero de Prestamo Intermediario', 'Número de Préstamo Intermediario'],
      client: ['Id cliente'],
      amount: ['Monto Otorgado  (pesos)', 'Monto Otorgado (pesos)'],
      capVig: ['Capital Vigente (pesos)'],
      capVen: ['Capital Mosoro y vencido (pesos)', 'Capital Moroso y vencido (pesos)', 'Capital Vencido (pesos)'],
      interest_rate: ['Tasa / Sobretasa Acreditado', 'Tasa base ANUAL de interés'],
      start_date: ['Fecha de  Otorgamiento (dd/mm/aaaa)', 'Fecha de Otorgamiento (dd/mm/aaaa)'],
      loan_type: ['Tipo de Crédito'],
      days_overdue: ['Días de Vencidos.', 'Dias de Vencidos', 'Días Vencidos'],
      loan_status: ['Estatus del Crédito'],
    },
  },
  {
    name: 'SYSCAP_LOAN_TAPE',
    headerProbe: ['#ID Cliente', 'Num. Contrato', 'Monto Dispuesto Actual', 'Días de Atraso'],
    columnMap: {
      loan_id: ['Num. Contrato'],
      client: ['#ID Cliente', 'Nombre de Cliente'],
      amount: ['Monto del Crédito'],
      outstanding_balance: ['Monto Dispuesto Actual'],
      interest_rate: ['Sobretasa a Acreditado (%)', 'Tasa de Interés Anual (%)'],
      start_date: ['Fecha Inicio del Crédito'],
      end_date: ['Fecha Fin del Crédito'],
      loan_type: ['Tipo de Crédito'],
      days_overdue: ['Días de Atraso'],
      loan_status: ['Estatus del Crédito'],
      state: ['Estado de Residencia del Cliente'],
    },
  },
];

export interface SheetReport {
  name: string;
  profile: string | null;               // 'SIAC' | 'CAUDEX' | 'GENERIC' | null
  dataRows: number;
  mappedRows: number;
  status: 'ok' | 'fallback' | 'skipped-empty' | 'unmapped' | 'ignored';
}

export interface ImportReconciliation {
  sheets: SheetReport[];
  unmappedSheetsWithData: string[];
  totalRows: number;
  totalBalance: number;
  momDeltaPct: number | null;
  validationCount: number;
  duplicateCount: number;
  unmappedCriticalFields: string[];
  severity: 'ok' | 'warning' | 'blocker';
  messages: string[];
}

export interface LoanTapeSummaryBucket {
  name: string;
  balance: number;
  pct: number | null;
}

export interface LoanTapeImportSummary {
  granularity: 'loan_level' | 'product_summary';
  by_product?: LoanTapeSummaryBucket[];
  by_state?: LoanTapeSummaryBucket[];
}

export interface ImportResult {
  standardized: StandardLoan[];
  mappingReport: MappingNote[];
  reconciliation: ImportReconciliation;
  summary?: LoanTapeImportSummary;
  // Columnas tal como las reporta el cliente (solo hojas de detalle leídas por el mapeador genérico).
  sourceTables?: SourceTable[];
}

const MOM_TOLERANCE = 0.4; // ±40% MoM balance swing → warn

function fileDateISO(fileName?: string): string | null {
  const s = String(fileName || '');
  const textual = parseLoanTapePeriodText(s);
  if (textual) return textual;
  const n = normalize(s);
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
    const end = new Date(year, month, 0);
    return `${end.getFullYear()}-${String(month).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`;
  };
  const fullYear = (rawYear: string) => {
    if (rawYear.length === 4) return Number(rawYear);
    const year = Number(rawYear);
    return year >= 70 ? 1900 + year : 2000 + year;
  };
  const monthPattern = Object.keys(monthByName).join('|');
  let monthMatch = n.match(new RegExp(`\\b(${monthPattern})\\s*(\\d{2}|\\d{4})\\b`));
  if (!monthMatch) monthMatch = n.match(new RegExp(`\\b(\\d{2}|\\d{4})\\s*(${monthPattern})\\b`));
  if (monthMatch) {
    const monthToken = monthByName[monthMatch[1]] ? monthMatch[1] : monthMatch[2];
    const yearToken = monthByName[monthMatch[1]] ? monthMatch[2] : monthMatch[1];
    const byName = endOfMonth(fullYear(yearToken), monthByName[monthToken]);
    if (byName) return byName;
  }
  let m = s.match(/(20\d{2})(\d{2})(\d{2})/); // YYYYMMDD
  let y: number, mo: number, d: number;
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else {
    m = s.match(/(\d{2})(\d{2})(\d{2})/); // YYMMDD
    if (!m) return null;
    y = 2000 + +m[1]; mo = +m[2]; d = +m[3];
  }
  if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return endOfMonth(y, mo);
  if (d >= 1 && d <= 12 && mo >= 1 && mo <= 31) return endOfMonth(y, d);
  return null;
}

function extractSheetCutoffDate(rows: any[][], sheetName?: string): string | null {
  const fromSheetName = parseLoanTapePeriodText(sheetName) || parseDate(sheetName);
  if (fromSheetName) return fromSheetName;

  for (const row of rows.slice(0, 30)) {
    const cells = (row || []).map(cell => String(cell ?? '').trim()).filter(Boolean);
    if (!cells.length) continue;
    const rowText = cells.join(' ');
    if (!/(fecha|corte|periodo|period|date)/i.test(rowText)) continue;
    for (const value of [rowText, ...cells]) {
      const parsed = parseDate(value) || parseLoanTapePeriodText(value);
      if (parsed) return parsed;
    }
  }
  return null;
}

function parseRate(raw: any): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'string' && raw.includes('%')) {
    const n = parseNumber(raw.replace('%', ''));
    return n === null ? null : Math.round((n / 100) * 1e6) / 1e6;
  }
  const n = parseNumber(raw);
  if (n === null) return null;
  return n > 1 ? Math.round((n / 100) * 1e6) / 1e6 : n;
}

function parsePct(raw: any): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = parseNumber(raw);
  if (n === null) return null;
  return String(raw).includes('%') || n > 1 ? Math.round((n / 100) * 1e6) / 1e6 : n;
}

function statusFromDpd(dpd: number | null): string | null {
  return loanStatusFromDpd(dpd);
}

function normalizeStatus(raw: any, dpd: number | null): string | null {
  if (!isBlank(raw)) return String(raw).trim();
  return statusFromDpd(dpd);
}

const isBlank = (v: any) => v === null || v === undefined || String(v).trim() === '';
const nonEmptyCells = (row: any[]) => row.filter(c => !isBlank(c)).length;

// Locate the header row for a profile (ALL probes present) within the first `scan` rows.
function findHeaderRow(rows: any[][], probes: string[], scan = 8): number {
  const wanted = probes.map(normalize);
  for (let i = 0; i < Math.min(scan, rows.length); i++) {
    const cells = new Set(rows[i].map(c => normalize(c)));
    if (wanted.every(w => cells.has(w))) return i;
  }
  return -1;
}

function buildColIndex(headerRow: any[]): Map<string, number> {
  const m = new Map<string, number>();
  headerRow.forEach((c, i) => { const n = normalize(c); if (n && !m.has(n)) m.set(n, i); });
  return m;
}

function findCol(colIdx: Map<string, number>, candidates?: string[]): number | undefined {
  if (!candidates) return undefined;
  for (const c of candidates) { const i = colIdx.get(normalize(c)); if (i !== undefined) return i; }
  return undefined;
}

function extractWithProfile(rows: any[][], headerIdx: number, profile: SheetProfile, fileDate: string | null): { std: StandardLoan[]; notes: MappingNote[] } {
  const colIdx = buildColIndex(rows[headerIdx]);
  const idx: Partial<Record<Field, number>> = {};
  (Object.keys(profile.columnMap) as Field[]).forEach(f => { idx[f] = findCol(colIdx, profile.columnMap[f]); });
  const notes: MappingNote[] = [];
  const push = (target: string, field: Field, srcs?: string[]) => {
    if (idx[field] !== undefined) notes.push({ source_header: (srcs || [])[0] || target, target_term: target, confidence: 'high', reasoning: `${profile.name}: ${field}` } as MappingNote);
  };
  (['loan_id', 'client', 'amount', 'outstanding_balance', 'interest_rate', 'start_date', 'end_date', 'loan_type', 'days_overdue', 'loan_status', 'state'] as const).forEach(f => push(f, f as Field, profile.columnMap[f as Field]));
  if (idx.capVig !== undefined || idx.capVen !== undefined) notes.push({ source_header: 'Capital vigente + Capital Vencido', target_term: 'outstanding_balance', confidence: 'high', reasoning: `${profile.name}: capVig+capVen` } as MappingNote);

  const g = (row: any[], f: Field) => (idx[f] !== undefined ? row[idx[f]!] : null);
  const std: StandardLoan[] = [];
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    const lid = g(row, 'loan_id');
    if (isBlank(lid) || normalize(lid) === 'nan') continue;
    const cvig = parseNumber(g(row, 'capVig')) || 0;
    const cven = parseNumber(g(row, 'capVen')) || 0;
    const ob = (idx.capVig !== undefined || idx.capVen !== undefined) ? cvig + cven : parseNumber(g(row, 'outstanding_balance'));
    const explicitDpd = parseNumber(g(row, 'days_overdue'));
    const dpd = explicitDpd !== null
      ? explicitDpd
      : cven > 0
        ? 91
        : cvig > 0
          ? 0
          : null;
    std.push({
      loan_id: String(lid).trim(),
      client: isBlank(g(row, 'client')) ? null : String(g(row, 'client')).trim(),
      amount: parseNumber(g(row, 'amount')),
      outstanding_balance: ob === null ? null : Math.round(ob * 100) / 100,
      interest_rate: parseRate(g(row, 'interest_rate')),
      loan_status: normalizeStatus(g(row, 'loan_status'), dpd),
      start_date: parseDate(g(row, 'start_date')),
      end_date: parseDate(g(row, 'end_date')),
      loan_type: isBlank(g(row, 'loan_type')) ? null : String(g(row, 'loan_type')).trim(),
      days_overdue: dpd,
      currency: 'MXN',
      industry: null,
      state: isBlank(g(row, 'state')) ? null : String(g(row, 'state')).trim(),
      file_date: fileDate,
    });
  }
  return { std, notes };
}

function findSummaryHeader(row: any[], nextRows: any[][] = []): { kind: 'product' | 'state'; labelIdx: number; balanceIdx: number; pctIdx: number | null } | null {
  for (let labelIdx = 0; labelIdx < row.length; labelIdx += 1) {
    const label = normalize(row[labelIdx]);
    const kind: 'product' | 'state' | null =
      /^(producto|tipo de credito|tipo credito|tipo de cartera|segmento|modalidad)$/.test(label) ? 'product' :
      /^(estado|entidad|geografia|geografico|plaza|region)$/.test(label) ? 'state' :
      null;
    if (!kind) continue;

    let balanceIdx = -1;
    let pctIdx: number | null = null;
    for (let index = labelIdx + 1; index < Math.min(row.length, labelIdx + 6); index += 1) {
      const header = normalize(row[index]);
      if (balanceIdx === -1 && /^(saldo|saldo total|cartera|balance|monto)$/.test(header)) balanceIdx = index;
      if (/%|porcentaje|participacion|share/.test(header)) pctIdx = index;
    }
    if (balanceIdx === -1 && /^(producto|estado)$/.test(label)) {
      const numericCandidates = [];
      for (let index = labelIdx + 1; index < Math.min(row.length, labelIdx + 6); index += 1) {
        // dates, days, terms and rates are numbers too, but never the balance
        if (/(fecha|date|dias|plazo|tasa|rate|vencimiento|%|porcentaje|participacion)/.test(normalize(row[index]))) continue;
        const hits = nextRows
          .filter(next => normalize(next?.[labelIdx]) !== 'total')
          .filter(next => parseNumber(next?.[index]) !== null)
          .length;
        if (hits >= 2) numericCandidates.push(index);
      }
      if (numericCandidates.length === 1) balanceIdx = numericCandidates[0];
    }
    if (balanceIdx !== -1) return { kind, labelIdx, balanceIdx, pctIdx };
  }
  return null;
}

function bucketDpd(header: any): number | null {
  const label = normalize(header);
  if (label === '0') return 0;
  if (/^1 a 30$|^1 30$/.test(label)) return 15;
  if (/^31 a 60$|^31 60$/.test(label)) return 45;
  if (/^61 a (89|90)$|^61 (89|90)$/.test(label)) return 75;
  if (/^90 a 120$|^91 a 120$|^90 120$|^91 120$/.test(label)) return 91;
  if (/^121 a 150$|^121 150$/.test(label)) return 135;
  if (/^151 a 180$|^151 180$/.test(label)) return 165;
  if (/mas de 180|mayor a 180|> 180/.test(label)) return 181;
  return null;
}

function isStageSubtotal(name: string) {
  return /cartera de credito etapa|cartera de cr[eé]dito etapa/i.test(name);
}

function extractDpdBucketBreakdown(rows: any[][], fileName: string, fileDate: string | null): { std: StandardLoan[]; notes: MappingNote[]; summary?: LoanTapeImportSummary } {
  const cutoff = fileDate || fileDateISO(fileName);
  const scaleText = normalize(rows.slice(0, 20).flat().join(' '));
  const balanceScale = /cifras en miles|miles de pesos|miles pesos|000 pesos/.test(scaleText) ? 1000 : 1;

  for (let i = 0; i < Math.min(rows.length, 80); i += 1) {
    const header = rows[i] || [];
    const productIdx = header.findIndex(cell => normalize(cell) === 'producto');
    if (productIdx === -1) continue;

    const bucketCols = header
      .map((cell, index) => ({ index, dpd: bucketDpd(cell) }))
      .filter((item): item is { index: number; dpd: number } => item.dpd !== null);
    if (bucketCols.length < 2) continue;

    const totalIdx = header.findIndex((cell, index) => index > productIdx && normalize(cell) === 'total');
    const std: StandardLoan[] = [];
    const byProduct: LoanTapeSummaryBucket[] = [];

    for (let r = i + 1; r < rows.length; r += 1) {
      const row = rows[r] || [];
      const name = String(row[productIdx] ?? '').trim();
      const normalizedName = normalize(name);
      if (!name) break;
      if (normalizedName === 'total') break;
      if (isStageSubtotal(name)) continue;

      const totalRaw = totalIdx === -1 ? null : parseNumber(row[totalIdx]);
      const bucketBalances = bucketCols
        .map(col => ({ ...col, balance: parseNumber(row[col.index]) }))
        .filter((item): item is { index: number; dpd: number; balance: number } => item.balance !== null && item.balance > 0);
      const total = totalRaw !== null
        ? totalRaw
        : bucketBalances.reduce((sum, item) => sum + item.balance, 0);
      if (!total && !bucketBalances.length) continue;

      const scaledTotal = balanceScale > 1 && Math.abs(total) < 10000000 ? total * balanceScale : total;
      byProduct.push({ name, balance: scaledTotal, pct: null });

      for (const item of bucketBalances) {
        const scaledBalance = balanceScale > 1 && Math.abs(item.balance) < 10000000 ? item.balance * balanceScale : item.balance;
        std.push({
          loan_id: null,
          client: null,
          amount: null,
          outstanding_balance: Math.round(scaledBalance * 100) / 100,
          interest_rate: null,
          loan_status: statusFromDpd(item.dpd),
          start_date: null,
          end_date: null,
          loan_type: name,
          days_overdue: item.dpd,
          currency: 'MXN',
          industry: null,
          state: null,
          file_date: cutoff,
          source_granularity: 'product_summary',
          source_share: null,
        });
      }
    }

    if (!std.length) continue;
    return {
      std,
      notes: [
        { source_header: 'Producto', target_term: 'loan_type', confidence: 'high', reasoning: 'COFINE DPD bucket summary: product bucket' },
        { source_header: 'Días de Atraso buckets', target_term: 'days_overdue', confidence: 'high', reasoning: 'COFINE DPD bucket summary: aging bucket' },
        { source_header: 'Bucket balance', target_term: 'outstanding_balance', confidence: 'high', reasoning: 'COFINE DPD bucket summary: balance by aging bucket' },
      ],
      summary: { granularity: 'product_summary', by_product: byProduct },
    };
  }
  return { std: [], notes: [] };
}

function extractSummaryBreakdown(rows: any[][], fileName: string, fileDate: string | null): { std: StandardLoan[]; notes: MappingNote[]; summary?: LoanTapeImportSummary } {
  const byProduct: LoanTapeSummaryBucket[] = [];
  const byState: LoanTapeSummaryBucket[] = [];
  const notes: MappingNote[] = [];
  const cutoff = fileDate || fileDateISO(fileName);
  const scaleText = normalize(rows.slice(0, 20).flat().join(' '));
  const balanceScale = /cifras en miles|miles de pesos|miles pesos|000 pesos/.test(scaleText) ? 1000 : 1;
  const parseBlock = (headerIdx: number, header: { kind: 'product' | 'state'; labelIdx: number; balanceIdx: number; pctIdx: number | null }) => {
    for (let r = headerIdx + 1; r < rows.length; r++) {
      const row = rows[r] || [];
      const name = String(row[header.labelIdx] ?? '').trim();
      if (!name) break;
      if (normalize(name) === 'total') break;
      const balance = parseNumber(row[header.balanceIdx]);
      if (balance === null) continue;
      const scaledBalance = balanceScale > 1 && Math.abs(balance) < 10000000 ? balance * balanceScale : balance;
      const item = { name, balance: scaledBalance, pct: header.pctIdx === null ? null : parsePct(row[header.pctIdx]) };
      if (header.kind === 'product') byProduct.push(item);
      else byState.push(item);
    }
  };

  for (let i = 0; i < Math.min(rows.length, 80); i++) {
    const header = findSummaryHeader(rows[i] || [], rows.slice(i + 1, i + 8));
    if (header) parseBlock(i, header);
  }

  if (!byProduct.length && !byState.length) return { std: [], notes: [] };
  if (byProduct.length) {
    notes.push(
      { source_header: 'Producto', target_term: 'loan_type', confidence: 'high', reasoning: 'Summary breakdown: product bucket' },
      { source_header: 'Saldo', target_term: 'outstanding_balance', confidence: 'high', reasoning: 'Summary breakdown: balance by product' },
    );
  }
  const std = byProduct.map(item => ({
    loan_id: null,
    client: null,
    amount: null,
    outstanding_balance: Math.round(item.balance * 100) / 100,
    interest_rate: null,
    loan_status: null,
    start_date: null,
    end_date: null,
    loan_type: item.name,
    days_overdue: null,
    currency: 'MXN',
    industry: null,
    state: null,
    file_date: cutoff,
    source_granularity: 'product_summary' as const,
    source_share: item.pct,
  }));
  return {
    std,
    notes,
    summary: {
      granularity: 'product_summary',
      by_product: byProduct,
      by_state: byState.length ? byState : undefined,
    },
  };
}

// Generic fallback: re-key rows using a detected header row and run the synonym mapper.
function extractGeneric(rows: any[][], fileName: string, overrides: MappingOverrides = {}): { std: StandardLoan[]; notes: MappingNote[]; headerIdx: number; dpdValidation?: DpdValidation | null; header?: string[]; dataRows?: any[][] } {
  // pick the first row (within 8) that looks like a header: mostly non-numeric text, ≥3 labels
  // Reports often start with a title or a banner of totals: take the row that names the MOST loan-tape fields, and fall back
  // to the first text-like row when none stands out.
  let headerIdx = -1;
  let bestScore = 1;
  for (let i = 0; i < Math.min(15, rows.length); i++) {
    const cells = rows[i].filter(c => !isBlank(c));
    const textish = cells.filter(c => typeof c === 'string' && parseNumber(c) === null).length;
    if (cells.length < 3 || textish < Math.ceil(cells.length * 0.6)) continue;
    const score = scoreHeaderRow(cells);
    if (score > bestScore) { bestScore = score; headerIdx = i; }
  }
  if (headerIdx === -1) {
    for (let i = 0; i < Math.min(8, rows.length); i++) {
      const cells = rows[i].filter(c => !isBlank(c));
      const textish = cells.filter(c => typeof c === 'string' && parseNumber(c) === null).length;
      if (cells.length >= 3 && textish >= Math.ceil(cells.length * 0.6)) { headerIdx = i; break; }
    }
  }
  if (headerIdx === -1) return { std: [], notes: [], headerIdx };
  const header = rows[headerIdx].map((c, i) => (isBlank(c) ? `col_${i}` : String(c)));
  const dataRows = rows.slice(headerIdx + 1)
    .filter(r => nonEmptyCells(r) > 0)
    .filter(r => {
      // totals, sub-totals and export footers ("Filtros aplicados: …") are not loans
      const first = normalize(r.find(c => !isBlank(c)));
      return !/^(total|totales|gran total|subtotal|suma|filtros aplicados)/.test(first);
    });
  const objs = dataRows.map(r => Object.fromEntries(header.map((h, i) => [h, r[i] ?? null])));
  const res = standardizeLoanTape(objs, fileName, overrides);
  return { std: res.standardized, notes: res.mappingReport, headerIdx, dpdValidation: res.dpdValidation, header, dataRows };
}

function isReferenceSheet(sheetName: string) {
  return /(diccionario|catalogo|cat[aá]logo|industrias|sectores|estados)/i.test(sheetName);
}

// A workbook may carry the loan list plus dashboards, pivots and projections that are ALSO read as tables. Importing them all
// piles summary rows on top of the loans (and double counts balances), so keep the loan-level sheets and say what was ignored.
function selectGenericSheets(cands: Array<{ name: string; std: StandardLoan[]; notes: MappingNote[] }>) {
  if (cands.length <= 1) return { keep: cands, messages: [] as string[] };
  const fieldsOf = (c: { notes: MappingNote[] }) => new Set(c.notes.map(n => n.target_term));
  const isCore = (c: { notes: MappingNote[] }) => { const f = fieldsOf(c); return f.has('outstanding_balance') && (f.has('loan_id') || f.has('client')); };
  const bySize = [...cands].sort((a, b) => b.std.length - a.std.length);
  const core = bySize.filter(isCore);
  const keep: typeof cands = [];
  const seenBalances = new Set<number>();
  const balancesOf = (c: { std: StandardLoan[] }) => c.std.map(r => Math.round((r.outstanding_balance || 0) * 100)).filter(v => v > 0);
  for (const c of core.length ? core : bySize.slice(0, 1)) {
    const bals = balancesOf(c);
    const overlap = bals.length ? bals.filter(v => seenBalances.has(v)).length / bals.length : 0;
    if (keep.length && overlap >= 0.6) continue; // same loans again (projection / copy of the main sheet)
    keep.push(c); bals.forEach(v => seenBalances.add(v));
  }
  const dropped = cands.filter(c => !keep.includes(c)).map(c => c.name);
  return { keep, messages: dropped.length ? [`Se ignoraron hojas que no son la lista de créditos (resumen, pivote o duplicado): ${dropped.join(', ')}.`] : [] };
}

// Values that cannot be real (rate above 300%, 10+ years past due) mean the wrong column was mapped: drop them instead of
// letting them poison weighted rates and DPD buckets.
function sanitizeLoans(rows: StandardLoan[]) {
  let rateFixes = 0, dpdFixes = 0;
  const std = rows.map(r => {
    let next = r;
    if (typeof r.interest_rate === 'number' && (r.interest_rate > 3 || r.interest_rate < 0)) { next = { ...next, interest_rate: null }; rateFixes += 1; }
    if (typeof r.days_overdue === 'number' && (r.days_overdue > 3650 || r.days_overdue < 0)) { next = { ...next, days_overdue: null }; dpdFixes += 1; }
    return next;
  });
  return { std, rateFixes, dpdFixes };
}

export function importLoanTapeSheets(sheets: SheetInput[], fileName: string, opts: { previousTotal?: number | null; mappingOverrides?: MappingOverrides } = {}): ImportResult {
  const fileDate = fileDateISO(fileName);
  const prefersSummaryWorkflow = /cofine/.test(normalize(fileName)) && /desglose|antiguedad/.test(normalize(fileName));
  const allStd: StandardLoan[] = [];
  const allNotes: MappingNote[] = [];
  const reports: SheetReport[] = [];
  let summary: LoanTapeImportSummary | undefined;
  const genericCandidates: Array<{ name: string; std: StandardLoan[]; notes: MappingNote[]; dpdValidation?: DpdValidation | null; source?: SourceTable | null }> = [];

  for (const sheet of sheets) {
    const rows = sheet.rows || [];
    const sheetDate = extractSheetCutoffDate(rows, sheet.name) || fileDate;
    const dataRows = rows.filter(r => nonEmptyCells(r) >= 2).length;
    if (dataRows === 0) { reports.push({ name: sheet.name, profile: null, dataRows: 0, mappedRows: 0, status: 'skipped-empty' }); continue; }
    if (isReferenceSheet(sheet.name)) { reports.push({ name: sheet.name, profile: 'REFERENCE', dataRows, mappedRows: 0, status: 'skipped-empty' }); continue; }

    // try known profiles
    let matched: { profile: SheetProfile; headerIdx: number } | null = null;
    for (const p of PROFILES) {
      const hi = findHeaderRow(rows, p.headerProbe);
      if (hi !== -1) { matched = { profile: p, headerIdx: hi }; break; }
    }

    if (matched) {
      const { std, notes } = extractWithProfile(rows, matched.headerIdx, matched.profile, sheetDate);
      appendAll(allStd, std); allNotes.push(...notes);
      reports.push({ name: sheet.name, profile: matched.profile.name, dataRows, mappedRows: std.length, status: std.length > 0 ? 'ok' : 'unmapped' });
      continue;
    }

    const bucketResult = extractDpdBucketBreakdown(rows, fileName, sheetDate);
    if (bucketResult.std.length > 0) {
      appendAll(allStd, bucketResult.std); allNotes.push(...bucketResult.notes);
      summary = bucketResult.summary;
      reports.push({ name: sheet.name, profile: 'COFINE_DPD_BUCKET_SUMMARY', dataRows, mappedRows: bucketResult.std.length, status: 'fallback' });
      continue;
    }

    const summaryResult = extractSummaryBreakdown(rows, fileName, sheetDate);
    if (summaryResult.std.length > 0) {
      const hasBucketRows = allStd.some(row => row.source_granularity === 'product_summary' && row.days_overdue !== null);
      const rowsToAdd = hasBucketRows
        ? summaryResult.std.filter(row => !allStd.some(existing => normalize(existing.loan_type) === normalize(row.loan_type)))
        : summaryResult.std;
      appendAll(allStd, rowsToAdd);
      allNotes.push(...summaryResult.notes);
      summary = summaryResult.summary;
      reports.push({ name: sheet.name, profile: hasBucketRows ? 'COFINE_PRODUCT_SUMMARY_CONTEXT' : 'COFINE_PRODUCT_SUMMARY', dataRows, mappedRows: rowsToAdd.length, status: 'fallback' });
      continue;
    }

    if (prefersSummaryWorkflow && /(bucket|venc|antiguedad|cartera)/.test(normalize(sheet.name))) {
      reports.push({ name: sheet.name, profile: 'COFINE_SUMMARY_CONTEXT', dataRows, mappedRows: 0, status: 'fallback' });
      continue;
    }

    // generic fallback
    const gen = extractGeneric(rows, fileName, opts.mappingOverrides || {});
    if (gen.std.length > 0) {
      const withDate = gen.std.map(s => ({ ...s, file_date: s.file_date || sheetDate }));
      genericCandidates.push({ name: sheet.name, std: withDate, notes: gen.notes, dpdValidation: gen.dpdValidation, source: gen.header && gen.dataRows ? buildSourceTable(sheet.name, gen.header, gen.dataRows) : null });
      reports.push({ name: sheet.name, profile: 'GENERIC', dataRows, mappedRows: gen.std.length, status: 'fallback' });
    } else {
      reports.push({ name: sheet.name, profile: null, dataRows, mappedRows: 0, status: 'unmapped' });
    }
  }

  const kept = selectGenericSheets(genericCandidates);
  for (const c of genericCandidates) {
    if (kept.keep.includes(c)) { appendAll(allStd, c.std); allNotes.push(...c.notes); continue; }
    const rep = reports.find(r => r.name === c.name && r.status === 'fallback');
    if (rep) { rep.status = 'ignored'; rep.mappedRows = 0; }
  }
  const { std: cleanStd, rateFixes, dpdFixes } = sanitizeLoans(allStd);
  const identity = inferLoanIds(cleanStd);
  allStd.length = 0; appendAll(allStd, identity.rows);

  const profile = buildLoanTapeDataProfile(allStd, allNotes);
  const totalBalance = allStd.reduce((a, s) => a + (s.outstanding_balance || 0), 0);
  const unmappedSheetsWithData = reports.filter(r => r.status === 'unmapped').map(r => r.name);
  const momDeltaPct = (opts.previousTotal && opts.previousTotal > 0) ? (totalBalance - opts.previousTotal) / opts.previousTotal : null;

  const messages: string[] = [];
  const okSheets = reports.filter(r => r.status === 'ok' || r.status === 'fallback');
  if (summary?.granularity === 'product_summary') {
    messages.push(`${okSheets.length} hoja(s) leída(s) (${okSheets.map(s => s.profile).join(', ') || '—'}) · ${allStd.length} rubros de resumen · $${totalBalance.toLocaleString('es-MX', { maximumFractionDigits: 0 })}`);
    messages.push('Archivo resumido por producto/estado: se analizan saldo, mezcla y geografía; crédito, cliente y mora no se inventan.');
  } else {
    messages.push(`${okSheets.length} hoja(s) leída(s) (${okSheets.map(s => s.profile).join(', ') || '—'}) · ${allStd.length} registros · $${totalBalance.toLocaleString('es-MX', { maximumFractionDigits: 0 })}`);
  }

  let severity: ImportReconciliation['severity'] = 'ok';
  if (kept.messages.length) messages.push(...kept.messages);
  if (identity.report.method === 'inferred') messages.push(`ID de crédito inferido: ${identity.report.note} (confianza ${identity.report.confidence}).`);

  // Regla de negocio: el DPD tiene que cuadrar con el bucket / estatus de cobranza que trae el propio archivo.
  for (const c of genericCandidates.filter(c => kept.keep.includes(c))) {
    const v = c.dpdValidation;
    if (!v) continue;
    const pctTxt = `${(Math.max(v.mismatchPct, v.mismatchBalancePct) * 100).toFixed(1)}%`;
    if (!v.ok && !v.strong) {
      if (severity === 'ok') severity = 'warning';
      messages.push(`⚠ Los días de atraso ("${v.dpdHeader}") no coinciden con el estatus "${v.evidenceHeader}" en ${v.mismatches} de ${v.compared} créditos (${pctTxt}). Puede ser la definición de estatus del cliente; confírmalo antes de usar la calidad de cartera.`);
    } else if (!v.ok) {
      severity = 'blocker';
      messages.push(`⛔ Los días de atraso ("${v.dpdHeader || 'sin columna'}") NO cuadran con "${v.evidenceHeader}" del mismo archivo: ${v.mismatches} de ${v.compared} créditos (${pctTxt}) caen fuera de su bucket. La calidad de cartera no es confiable; revisa qué columna trae los días de mora.`);
    } else if (v.switchedFrom !== undefined) {
      if (severity === 'ok') severity = 'warning';
      messages.push(`Días de atraso tomados de "${v.dpdHeader}" porque ${v.switchedFrom ? `"${v.switchedFrom}" no cuadraba` : 'ninguna columna se reconocía'} con "${v.evidenceHeader}" (validado en ${v.compared} créditos).`);
    } else {
      messages.push(`✓ Días de atraso validados contra "${v.evidenceHeader}" (${v.compared} créditos, ${pctTxt} fuera de bucket).`);
    }
  }

  // Regla de negocio: el conteo cuadra a la vista (registros = vivos + liquidados) y se desglosa por estatus del archivo.
  if (summary?.granularity !== 'product_summary') {
    const live = activeRows(allStd);
    const paid = allStd.length - live.length;
    if (paid > 0) {
      const paidBal = allStd.filter(r => !live.includes(r)).reduce((a, r) => a + (r.outstanding_balance || 0), 0);
      messages.push(`${allStd.length} registros = ${live.length} créditos vivos + ${paid} liquidados (saldo $${paidBal.toLocaleString('es-MX', { maximumFractionDigits: 0 })}), que no cuentan en la cartera.`);
    }
    const byStatus = new Map<string, number>();
    allStd.forEach(r => { if (r.loan_status) byStatus.set(r.loan_status, (byStatus.get(r.loan_status) || 0) + 1); });
    if (byStatus.size > 1 && byStatus.size <= 12) {
      messages.push(`Estatus en el archivo: ${[...byStatus.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ')}.`);
    }
    const conflicts = statusDpdConflicts(live);
    if (conflicts.count) {
      if (severity === 'ok') severity = 'warning';
      messages.push(`⚠ ${conflicts.count} créditos con estatus de castigo/incobrable (${conflicts.statuses.join(', ')}) traen menos de 90 días de atraso ($${conflicts.balance.toLocaleString('es-MX', { maximumFractionDigits: 0 })}): se clasifican por días, como dice el archivo. Confirma con el cliente si deben ir a vencida.`);
    }
  }

  // Regla de negocio: la fecha de corte no puede ser anterior a las originaciones.
  const cutoffs = [...new Set(allStd.map(r => r.file_date).filter(Boolean))] as string[];
  const latestCut = cutoffs.sort().at(-1);
  if (latestCut) {
    const after = allStd.filter(r => r.start_date && r.start_date > latestCut);
    if (after.length) {
      if (severity === 'ok') severity = 'warning';
      messages.push(`⚠ ${after.length} créditos se originaron después de la fecha de corte (${latestCut}): la fecha de corte probablemente está mal.`);
    }
  }
  const nameCut = fileDate;
  if (nameCut && latestCut && nameCut.slice(0, 7) !== latestCut.slice(0, 7)) {
    if (severity === 'ok') severity = 'warning';
    messages.push(`⚠ El nombre del archivo indica ${nameCut.slice(0, 7)} pero la fecha de corte dentro del archivo es ${latestCut}: se usa la del archivo.`);
  }
  const proxyDpd = allStd.filter(r => r.dpd_source === 'proxy');
  if (proxyDpd.length) {
    const bal = proxyDpd.reduce((a, r) => a + (r.outstanding_balance || 0), 0);
    messages.push(`${proxyDpd.length} créditos ($${bal.toLocaleString('es-MX', { maximumFractionDigits: 0 })}) traen monto en mora sin días de atraso ni fecha que los derive: se clasifican como atrasada (${DPD_PROXY_DAYS} días, mínimo), no como vencida.`);
  }
  if (rateFixes) { if (severity === 'ok') severity = 'warning'; messages.push(`⚠ ${rateFixes} créditos traían una tasa inverosímil (>300%): se dejó sin dato. Revisa que la columna de tasa sea la correcta.`); }
  if (dpdFixes) { if (severity === 'ok') severity = 'warning'; messages.push(`⚠ ${dpdFixes} créditos traían días de atraso inverosímiles (>3,650): se dejó sin dato. Revisa que la columna de mora sea la correcta.`); }
  if (allStd.length && summary?.granularity !== 'product_summary' && totalBalance <= 0) {
    severity = 'blocker';
    messages.push('⚠ No se encontró una columna de saldo: el saldo total es $0. Sin saldo no se puede analizar la cartera; revisa los encabezados del archivo.');
  } else if (unmappedSheetsWithData.length) {
    severity = 'blocker';
    messages.push(`⚠ Hoja(s) con datos que NO se pudieron leer: ${unmappedSheetsWithData.join(', ')}. Puede faltar cartera en el total.`);
  } else {
    if (momDeltaPct !== null && Math.abs(momDeltaPct) > MOM_TOLERANCE) {
      if (severity === 'ok') severity = 'warning';
      messages.push(`⚠ El saldo cambió ${(momDeltaPct * 100).toFixed(0)}% vs. el corte anterior — revisa si es correcto.`);
    }
    if (profile.unmappedCriticalFields.length) {
      severity = severity === 'ok' ? 'warning' : severity;
      messages.push(`Campos sin mapear que limitan módulos específicos: ${profile.unmappedCriticalFields.join(', ')}.`);
    }
    if (allStd.length && profile.validationCount > allStd.length * 0.5) {
      severity = severity === 'ok' ? 'warning' : severity;
      messages.push(`⚠ ${profile.validationCount} incidencias de validación en ${allStd.length} créditos.`);
    }
  }

  return {
    standardized: allStd,
    mappingReport: allNotes,
    reconciliation: {
      sheets: reports,
      unmappedSheetsWithData,
      totalRows: allStd.length,
      totalBalance,
      momDeltaPct,
      validationCount: profile.validationCount,
      duplicateCount: profile.duplicateCount,
      unmappedCriticalFields: profile.unmappedCriticalFields,
      severity,
      messages,
    },
    summary,
    sourceTables: genericCandidates.filter(c => kept.keep.includes(c) && c.source).map(c => c.source as SourceTable),
  };
}

// Re-procesa un tape ya guardado a partir de sus columnas originales (`_source`) con el mapeo corregido por el
// analista: mismo pipeline y mismas validaciones que una carga nueva, sin volver a subir el archivo.
export function reimportFromSource(tape: { fileName: string; extractedData: any }, mappingOverrides: MappingOverrides): ImportResult | null {
  const tables: SourceTable[] = Array.isArray(tape.extractedData?._source) ? tape.extractedData._source : [];
  if (!tables.length) return null;
  const sheets = tables.map(t => ({ name: t.sheet, rows: [t.headers, ...t.rows] }));
  return importLoanTapeSheets(sheets, tape.fileName, { mappingOverrides });
}
