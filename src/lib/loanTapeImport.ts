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
  parseNumber,
  normalize,
} from './loanTapeAnalytics';

export type SheetInput = { name: string; rows: any[][] };

type Field =
  | 'loan_id' | 'client' | 'amount' | 'capVig' | 'capVen' | 'outstanding_balance'
  | 'interest_rate' | 'start_date' | 'end_date' | 'loan_type' | 'days_overdue' | 'state';

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
];

export interface SheetReport {
  name: string;
  profile: string | null;               // 'SIAC' | 'CAUDEX' | 'GENERIC' | null
  dataRows: number;
  mappedRows: number;
  status: 'ok' | 'fallback' | 'skipped-empty' | 'unmapped';
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

export interface ImportResult {
  standardized: StandardLoan[];
  mappingReport: MappingNote[];
  reconciliation: ImportReconciliation;
}

const MOM_TOLERANCE = 0.4; // ±40% MoM balance swing → warn

function fileDateISO(fileName?: string): string | null {
  const s = String(fileName || '');
  let m = s.match(/(20\d{2})(\d{2})(\d{2})/); // YYYYMMDD
  let y: number, mo: number;
  if (m) { y = +m[1]; mo = +m[2]; }
  else {
    m = s.match(/(\d{2})(\d{2})(\d{2})/); // YYMMDD
    if (!m) return null;
    y = 2000 + +m[1]; mo = +m[2];
  }
  if (mo < 1 || mo > 12) return null;
  const end = new Date(y, mo, 0); // last day of month `mo`
  return `${end.getFullYear()}-${String(mo).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`;
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

function statusFromDpd(dpd: number | null): string | null {
  if (dpd === null) return null;
  if (dpd > 90) return 'Vencido';
  if (dpd > 30) return 'Atrasado';
  return 'Vigente';
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
  (['loan_id', 'client', 'amount', 'interest_rate', 'start_date', 'end_date', 'loan_type', 'days_overdue', 'state'] as const).forEach(f => push(f, f as Field, profile.columnMap[f as Field]));
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
    const dpd = parseNumber(g(row, 'days_overdue'));
    std.push({
      loan_id: String(lid).trim(),
      client: isBlank(g(row, 'client')) ? null : String(g(row, 'client')).trim(),
      amount: parseNumber(g(row, 'amount')),
      outstanding_balance: ob === null ? null : Math.round(ob * 100) / 100,
      interest_rate: parseRate(g(row, 'interest_rate')),
      loan_status: statusFromDpd(dpd),
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

// Generic fallback: re-key rows using a detected header row and run the synonym mapper.
function extractGeneric(rows: any[][], fileName: string): { std: StandardLoan[]; notes: MappingNote[]; headerIdx: number } {
  // pick the first row (within 8) that looks like a header: mostly non-numeric text, ≥3 labels
  let headerIdx = -1;
  for (let i = 0; i < Math.min(8, rows.length); i++) {
    const cells = rows[i].filter(c => !isBlank(c));
    const textish = cells.filter(c => typeof c === 'string' && parseNumber(c) === null).length;
    if (cells.length >= 3 && textish >= Math.ceil(cells.length * 0.6)) { headerIdx = i; break; }
  }
  if (headerIdx === -1) return { std: [], notes: [], headerIdx };
  const header = rows[headerIdx].map((c, i) => (isBlank(c) ? `col_${i}` : String(c)));
  const objs = rows.slice(headerIdx + 1)
    .filter(r => nonEmptyCells(r) > 0)
    .map(r => Object.fromEntries(header.map((h, i) => [h, r[i] ?? null])));
  const res = standardizeLoanTape(objs, fileName);
  return { std: res.standardized, notes: res.mappingReport, headerIdx };
}

export function importLoanTapeSheets(sheets: SheetInput[], fileName: string, opts: { previousTotal?: number | null } = {}): ImportResult {
  const fileDate = fileDateISO(fileName);
  const allStd: StandardLoan[] = [];
  const allNotes: MappingNote[] = [];
  const reports: SheetReport[] = [];

  for (const sheet of sheets) {
    const rows = sheet.rows || [];
    const dataRows = rows.filter(r => nonEmptyCells(r) >= 3).length;
    if (dataRows === 0) { reports.push({ name: sheet.name, profile: null, dataRows: 0, mappedRows: 0, status: 'skipped-empty' }); continue; }

    // try known profiles
    let matched: { profile: SheetProfile; headerIdx: number } | null = null;
    for (const p of PROFILES) {
      const hi = findHeaderRow(rows, p.headerProbe);
      if (hi !== -1) { matched = { profile: p, headerIdx: hi }; break; }
    }

    if (matched) {
      const { std, notes } = extractWithProfile(rows, matched.headerIdx, matched.profile, fileDate);
      allStd.push(...std); allNotes.push(...notes);
      reports.push({ name: sheet.name, profile: matched.profile.name, dataRows, mappedRows: std.length, status: std.length > 0 ? 'ok' : 'unmapped' });
      continue;
    }

    // generic fallback
    const gen = extractGeneric(rows, fileName);
    if (gen.std.length > 0) {
      const withDate = gen.std.map(s => ({ ...s, file_date: s.file_date || fileDate }));
      allStd.push(...withDate); allNotes.push(...gen.notes);
      reports.push({ name: sheet.name, profile: 'GENERIC', dataRows, mappedRows: gen.std.length, status: 'fallback' });
    } else {
      reports.push({ name: sheet.name, profile: null, dataRows, mappedRows: 0, status: 'unmapped' });
    }
  }

  const profile = buildLoanTapeDataProfile(allStd, allNotes);
  const totalBalance = allStd.reduce((a, s) => a + (s.outstanding_balance || 0), 0);
  const unmappedSheetsWithData = reports.filter(r => r.status === 'unmapped').map(r => r.name);
  const momDeltaPct = (opts.previousTotal && opts.previousTotal > 0) ? (totalBalance - opts.previousTotal) / opts.previousTotal : null;

  const messages: string[] = [];
  const okSheets = reports.filter(r => r.status === 'ok' || r.status === 'fallback');
  messages.push(`${okSheets.length} hoja(s) leída(s) (${okSheets.map(s => s.profile).join(', ') || '—'}) · ${allStd.length} créditos · $${totalBalance.toLocaleString('es-MX', { maximumFractionDigits: 0 })}`);

  let severity: ImportReconciliation['severity'] = 'ok';
  if (unmappedSheetsWithData.length) {
    severity = 'blocker';
    messages.push(`⚠ Hoja(s) con datos que NO se pudieron leer: ${unmappedSheetsWithData.join(', ')}. Puede faltar cartera en el total.`);
  } else {
    if (momDeltaPct !== null && Math.abs(momDeltaPct) > MOM_TOLERANCE) {
      severity = 'warning';
      messages.push(`⚠ El saldo cambió ${(momDeltaPct * 100).toFixed(0)}% vs. el corte anterior — revisa si es correcto.`);
    }
    if (profile.unmappedCriticalFields.length) {
      severity = severity === 'ok' ? 'warning' : severity;
      messages.push(`⚠ Campos críticos sin mapear: ${profile.unmappedCriticalFields.join(', ')}.`);
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
  };
}
