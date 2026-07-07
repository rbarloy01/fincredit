// FinMonitor Export Utility — v2
// Excel: ExcelJS | PDF/PNG: html2canvas + jsPDF

import ExcelJS from 'exceljs';
import html2canvas from 'html2canvas';
import jsPDF from 'jspdf';
import type {
  Client, Transaction, Covenant_DB, FinancialStatement_DB, LoanTape_DB,
} from '../db/index';
import {
  buildCovenantAnalystInsight,
  evaluateFormula,
  formulaLabel,
  getMetric,
  metricLabels,
  prioritizedLatestCovenantPerformance,
  rawAccountKey,
} from './financialMetrics';
import { buildLoanTapeExportContexts, type LoanTapeExportContext } from './loanTapeAnalytics';
import {
  normalizeLoanTapeAnalystState,
  type LoanTapeWorkspaceBlock,
} from './loanTapeWorkspace';
import { parseFinancialNumber, parseNullableFinancialNumber } from './numberParsing';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SheetDef {
  name: string;
  rows: (string | number | null | undefined)[][];
  colWidths?: number[];
  outlineColumns?: number[];
  wrapColumns?: number[];
}

export type VerticalBaseConfig = Record<string, string>;
export type TransactionNameMap = Record<string, string>;
export interface DefinedConcept {
  id: string;
  name: string;
  tokens: string[];
}

function formulaLabelsFromStatements(statements: FinancialStatement_DB[], concepts: DefinedConcept[] = []): Record<string, string> {
  const labels: Record<string, string> = { ...metricLabels };
  statements.forEach(stmt => {
    stmt.rawLineItems.forEach(item => {
      labels[`account:${rawAccountKey(item)}`] = item.name;
    });
  });
  concepts.forEach(concept => {
    labels[`concept:${concept.id}`] = concept.name;
  });
  return labels;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function todayStamp(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

function safeFilePart(value: string): string {
  return (value || 'Cliente')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'Cliente';
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function downloadDataUrl(dataUrl: string, filename: string) {
  const a = document.createElement('a');
  a.href = dataUrl; a.download = filename; a.click();
}

function fmtDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString('es-MX');
}

function periodYear(p: FinancialStatement_DB): number {
  return new Date(p.periodDate).getFullYear();
}

function periodMonth(p: FinancialStatement_DB): number {
  return new Date(p.periodDate).getMonth() + 1;
}

function monthLabel(p: FinancialStatement_DB): string {
  const d = new Date(p.periodDate);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  if (isNaN(d.getTime())) return p.period || '';
  return `${months[d.getMonth()]}-${d.getFullYear()}`;
}

// ── PDF / PNG helpers ─────────────────────────────────────────────────────────

export function applyPdfStyles(clonedDoc: Document) {
  // Inline computed styles from the live DOM so oklch/color-mix resolve to rgb()
  try {
    const origEls = Array.from(document.querySelectorAll('*')) as HTMLElement[];
    const cloneEls = Array.from(clonedDoc.querySelectorAll('*')) as HTMLElement[];
    const limit = Math.min(origEls.length, cloneEls.length);
    for (let i = 0; i < limit; i++) {
      const clone = cloneEls[i];
      if (!('style' in clone)) continue;
      const cs = window.getComputedStyle(origEls[i]);
      const bg = cs.backgroundColor;
      const fg = cs.color;
      if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
        (clone as HTMLElement).style.setProperty('background-color', bg, 'important');
      }
      if (fg && fg !== 'rgba(0, 0, 0, 0)') {
        (clone as HTMLElement).style.setProperty('color', fg, 'important');
      }
    }
  } catch (_) {}

  const style = clonedDoc.createElement('style');
  style.innerHTML = `
    * {
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
      box-sizing: border-box !important;
      transform: none !important;
      transition: none !important;
      animation: none !important;
    }
    html, body { margin: 0 !important; padding: 0 !important; background: #ffffff !important; }
    .export-page {
      width: 1120px !important;
      max-width: 1120px !important;
      min-width: 1120px !important;
      background: #ffffff !important;
      border-radius: 0 !important;
      overflow: visible !important;
    }
    .export-page, .export-page * { font-family: Arial, Helvetica, sans-serif !important; }
    .export-page .recharts-wrapper,
    .export-page .recharts-surface {
      overflow: visible !important;
    }
    .export-page svg {
      max-width: none !important;
    }
    table td, table th { vertical-align: middle !important; line-height: 1.2 !important; }
    .shadow-2xl, .shadow-sm, .shadow-lg, .shadow-xl, .shadow-md { box-shadow: none !important; }
  `;
  clonedDoc.head.appendChild(style);
}

function canvasOpts(el: HTMLElement) {
  const minExportWidth = el.classList.contains('export-page') ? 1120 : 1;
  const width = Math.max(el.scrollWidth, el.offsetWidth, el.getBoundingClientRect().width, minExportWidth);
  const height = Math.max(el.scrollHeight, el.offsetHeight, el.getBoundingClientRect().height, 1);
  return {
    scale: 2, useCORS: true, logging: false, backgroundColor: '#ffffff',
    imageTimeout: 0,
    width,
    height,
    windowWidth: width,
    windowHeight: height,
    scrollX: 0,
    scrollY: 0,
    onclone: (clonedDoc: Document) => {
      applyPdfStyles(clonedDoc);
      const clonedEl = el.id ? clonedDoc.getElementById(el.id) : null;
      if (clonedEl) {
        clonedEl.style.width = `${width}px`;
        clonedEl.style.minWidth = `${width}px`;
        clonedEl.style.maxWidth = `${width}px`;
      }
    },
  } as const;
}

export async function exportToPng(el: HTMLElement, filename: string): Promise<void> {
  const canvas = await html2canvas(el, canvasOpts(el));
  downloadDataUrl(canvas.toDataURL('image/png'), `${filename}.png`);
}

async function renderPage(el: HTMLElement, pdf: jsPDF, addPage = false): Promise<void> {
  const PW = 210, PH = 297;
  const canvas = await html2canvas(el, canvasOpts(el));
  const pagePxHeight = Math.floor((canvas.width * PH) / PW);
  let sourceY = 0;
  let firstSlice = true;

  while (sourceY < canvas.height) {
    const sliceHeight = Math.min(pagePxHeight, canvas.height - sourceY);
    if (sliceHeight <= 0) break;
    const pageCanvas = document.createElement('canvas');
    pageCanvas.width = canvas.width;
    pageCanvas.height = sliceHeight;
    const ctx = pageCanvas.getContext('2d');
    if (!ctx) break;

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
    ctx.drawImage(canvas, 0, sourceY, canvas.width, sliceHeight, 0, 0, canvas.width, sliceHeight);

    if (addPage || !firstSlice) pdf.addPage();
    const imgData = pageCanvas.toDataURL('image/jpeg', 0.95);
    const imgH = (sliceHeight * PW) / canvas.width;
    pdf.addImage(imgData, 'JPEG', 0, 0, PW, imgH);

    sourceY += sliceHeight;
    firstSlice = false;
  }
}

export async function exportToPdf(pages: HTMLElement[], filename: string): Promise<void> {
  if (!pages.length) return;
  const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
  for (let i = 0; i < pages.length; i++) await renderPage(pages[i], pdf, i > 0);
  pdf.save(`${todayStamp()} - ${filename}.pdf`);
}

// ── Excel writer (ExcelJS) ────────────────────────────────────────────────────

type RowKind = 'title' | 'subheading' | 'headers' | 'data' | 'blank';

const XL = {
  title:      { bg: '0F172A', fg: 'FFFFFF', bold: true,  sz: 14, h: 28 },
  subheading: { bg: 'EEF2FF', fg: '312E81', bold: true,  sz: 10, h: 22 },
  headers:    { bg: '312E81', fg: 'F8FAFC', bold: true,  sz: 9,  h: 19 },
  data:       { bg: 'FFFFFF', fg: '1E293B', bold: false, sz: 9,  h: 15 },
  blank:      { bg: 'FFFFFF', fg: '1E293B', bold: false, sz: 9,  h: 5  },
};

function rowKind(row: SheetDef['rows'][number], ri: number, prev: RowKind): RowKind {
  if (row.every(c => c === null || c === undefined || c === '')) return 'blank';
  const first = row[0];
  const solo = row.slice(1).every(c => c === null || c === undefined || c === '');
  if (ri === 0 && solo && typeof first === 'string') return 'title';
  if (solo && typeof first === 'string' && (prev === 'blank' || prev === 'title')) return 'subheading';
  const filled = row.filter(c => c !== null && c !== undefined && c !== '');
  if (filled.length >= 3 && filled.every(c => typeof c === 'string') &&
      (prev === 'blank' || prev === 'subheading' || prev === 'title')) return 'headers';
  return 'data';
}

export async function exportToExcel(sheets: SheetDef[], filename: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'FinMonitor';
  wb.created = new Date();
  wb.calcProperties.fullCalcOnLoad = true;

  for (const sheet of sheets) {
    const ws = wb.addWorksheet(sheet.name.slice(0, 31));
    ws.properties.tabColor = { argb: sheet.name.includes('Dashboard') ? 'FF312E81' : 'FF64748B' };
    const maxCols = Math.max(1, ...sheet.rows.map(r => r.length));
    const nCols = Math.max(maxCols, sheet.colWidths?.length ?? 0);

    ws.columns = Array.from({ length: nCols }, (_, i) => ({
      width: sheet.colWidths?.[i] ?? (i === 0 ? 34 : 14),
    }));
    ws.properties.outlineProperties = { summaryBelow: false, summaryRight: false };
    (sheet.outlineColumns || []).forEach(col => {
      if (col >= 1 && col <= nCols) ws.getColumn(col).outlineLevel = 1;
    });

    let prev: RowKind = 'blank';
    let headerLabels: string[] = [];
    let firstHeaderRow = -1;

    for (let ri = 0; ri < sheet.rows.length; ri++) {
      const raw = sheet.rows[ri];
      const kind = rowKind(raw, ri, prev);
      const { bg, fg, bold, sz, h } = XL[kind];

      if (kind === 'headers') {
        headerLabels = raw.map(c => String(c ?? ''));
        if (firstHeaderRow < 0) firstHeaderRow = ri + 1;
      }

      const exRow = ws.addRow(raw.map(c => {
        if (typeof c === 'string' && c.startsWith('=')) return { formula: c.slice(1), result: null } as any;
        return c ?? '';
      }));
      const wrappedLineCount = Math.max(1, ...(sheet.wrapColumns || []).map(col => {
        const value = String(raw[col - 1] ?? '');
        const width = sheet.colWidths?.[col - 1] ?? 14;
        return Math.ceil(value.length / Math.max(8, width * 1.25));
      }));
      exRow.height = kind === 'data' ? Math.min(72, Math.max(h, wrappedLineCount * 14)) : h;

      exRow.eachCell({ includeEmpty: true }, (cell, col) => {
        if (col > nCols) return;
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + bg } };
        cell.font = { name: 'Arial', size: sz, bold, color: { argb: 'FF' + fg } };
        const isNum = typeof cell.value === 'number' || (typeof cell.value === 'object' && !!(cell.value as any)?.formula);
        cell.alignment = {
          vertical: 'middle',
          horizontal: (kind === 'title' || kind === 'subheading' || !isNum) ? 'left' : 'right',
          wrapText: sheet.wrapColumns?.includes(col) || false,
        };
        if (isNum && kind === 'data') {
          const lbl = (headerLabels[col - 1] ?? '').toUpperCase();
          const isPct = lbl.includes('%') || lbl.includes('VAR') || lbl.includes('VERT') || lbl === 'ROA' || lbl === 'ROE';
          cell.numFmt = isPct ? '0.0%' : '#,##0;[Red](#,##0);-';
        }
        if (kind === 'headers') {
          cell.border = { bottom: { style: 'thin', color: { argb: 'FF6366F1' } } };
          cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
        }
        if (kind === 'data') {
          cell.border = { bottom: { style: 'hair', color: { argb: 'FFE2E8F0' } } };
        }
      });

      if ((kind === 'title' || kind === 'subheading') && nCols > 1) {
        ws.mergeCells(ri + 1, 1, ri + 1, nCols);
        const cell = ws.getCell(ri + 1, 1);
        cell.font = { name: 'Arial', size: sz, bold, color: { argb: 'FF' + fg } };
        cell.alignment = { vertical: 'middle', horizontal: 'left' };
      }

      prev = kind;
    }

    if (firstHeaderRow > 0) {
      ws.views = [{ state: 'frozen', ySplit: firstHeaderRow, xSplit: sheet.name.includes('Balance') || sheet.name.includes('Estado') ? 2 : 0 }];
      ws.autoFilter = { from: { row: firstHeaderRow, column: 1 }, to: { row: firstHeaderRow, column: nCols } };
    }
  }

  const buf = await wb.xlsx.writeBuffer();
  downloadBlob(
    new Blob([buf as ArrayBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    `${todayStamp()} - ${safeFilePart(filename)}.xlsx`,
  );
}

// ── Sheet builders ────────────────────────────────────────────────────────────

// 1. FICHA CONTRACTUAL — from client + transactions + covenants
export function buildFichaContractual(
  client: Client,
  transactions: Transaction[],
  covenants: Covenant_DB[],
): SheetDef {
  const financial = covenants.filter(c => c.type === 'financial');
  const rows: SheetDef['rows'] = [
    ['FICHA CONTRACTUAL — ' + client.name.toUpperCase()],
    [],
    ['A. DATOS GENERALES DEL CRÉDITO'],
    ['Cliente', client.name],
    ['RFC', client.taxId || ''],
    ['Industria', client.industry || ''],
    ['Moneda', client.currency || 'MXN'],
    ['Línea Total', parseFinancialNumber(client.totalCreditValue)],
    ['Tipo de Crédito', (client.creditType || []).join(', ')],
    ['Nombre del Contrato', client.contractName || ''],
    ['Analista', client.analystName || ''],
    ['Frecuencia de Reporte', client.frequency || ''],
    [],
    ['B. TRANSACCIONES'],
    ['Nombre', 'Tipo', 'Monto', 'Moneda', 'Fecha Firma', 'Vencimiento'],
    ...transactions.map(t => [t.name, t.creditType, parseFinancialNumber(t.originalAmount), t.currency, fmtDate(t.signedAt), fmtDate(t.maturityAt)]),
    [],
    ['C. COVENANTS FINANCIEROS'],
    ['Covenant', 'Fórmula legible', 'Operador', 'Umbral'],
    ...financial.map(c => [c.name, formulaLabel(c.formula || c.name, metricLabels), c.operator, parseNullableFinancialNumber(c.threshold)]),
    [],
    ['D. CALENDARIO DE DOCUMENTOS'],
    ['Documento', 'Periodicidad'],
    ['Loan Tape', 'Mensual — día 10'],
    ['Estados Financieros', 'Trimestral — 30 días después de cierre'],
    ['Buró de Crédito', 'Mensual — día 5'],
    ['Estados Financieros Anuales Auditados', 'Anual — 120 días después de cierre'],
  ];
  return {
    name: 'Ficha Contractual',
    rows,
    colWidths: [36, 24, 18, 18, 16, 16],
  };
}

function colName(n: number): string {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function normalizedPeriods(statements: FinancialStatement_DB[]) {
  const out = new Map<string, { label: string; stmt: FinancialStatement_DB }>();
  const sorted = [...statements].sort((a, b) => a.periodDate.localeCompare(b.periodDate));
  for (const stmt of sorted) {
    const base = monthLabel(stmt);
    const p = (stmt.period || '').toLowerCase();
    const suffix = /acum|acumul|ytd/.test(p) ? ' Acum' : /ltm|ttm/.test(p) ? ' LTM' : '';
    let label = `${base}${suffix}`;
    if (out.has(label) && suffix === '') {
      out.set(label, { label, stmt });
      continue;
    }
    if (out.has(label)) {
      let i = 2;
      while (out.has(`${label} ${i}`)) i++;
      label = `${label} ${i}`;
    }
    out.set(label, { label, stmt });
  }
  return Array.from(out.values());
}

function excelString(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

function covenantDataRef(refKey: string, periodHeaderCell: string) {
  return `N(IFERROR(INDEX('Datos Covenant'!$D:$ZZ,MATCH(${excelString(refKey)},'Datos Covenant'!$A:$A,0),MATCH(${periodHeaderCell},'Datos Covenant'!$D$1:$ZZ$1,0)),0))`;
}

function formulaToExcel(formula: string, periodHeaderCell: string): string {
  const f = (formula || '').trim();
  const ref = (key: string) => covenantDataRef(key, periodHeaderCell);
  if (f.startsWith('expr:')) {
    try {
      const tokens = JSON.parse(f.slice('expr:'.length)) as string[];
      const body = tokens.map(t => {
        if (t.startsWith('ref:')) return ref(t.slice(4));
        if (t.startsWith('num:')) return t.slice(4);
        return t;
      }).join('');
      return `=IFERROR(${body},"")`;
    } catch {
      return '=""';
    }
  }
  if (f.startsWith('ratio:')) {
    const [num, den] = f.slice('ratio:'.length).split('/');
    return num && den ? `=IFERROR(${ref(num)}/${ref(den)},"")` : '=""';
  }
  const low = f.toLowerCase();
  if (low.includes('deuda') && low.includes('ebitda')) return `=IFERROR(${ref('totalDebt')}/${ref('ebitda')},"")`;
  if (low.includes('dscr') || (low.includes('ebitda') && low.includes('interes'))) return `=IFERROR(${ref('ebitda')}/${ref('interestExpense')},"")`;
  if (low.includes('corriente') || low.includes('liquidez')) return `=IFERROR(${ref('currentAssets')}/${ref('currentLiabilities')},"")`;
  if (low.includes('roa')) return `=IFERROR(${ref('netIncome')}/${ref('totalAssets')},"")`;
  if (low.includes('roe')) return `=IFERROR(${ref('netIncome')}/${ref('equity')},"")`;
  if (low.includes('apalanc') || low.includes('equity') || low.includes('capital')) return `=IFERROR(${ref('totalDebt')}/${ref('equity')},"")`;
  return '=""';
}

function covenantDataRowMap(statements: FinancialStatement_DB[], concepts: DefinedConcept[] = []): Record<string, number> {
  const rows: Record<string, number> = {};
  let row = 2;
  [
    'revenue',
    'ebitda',
    'interestExpense',
    'netIncome',
    'currentAssets',
    'currentLiabilities',
    'totalDebt',
    'totalAssets',
    'equity',
  ].forEach(key => { rows[key] = row++; });

  const rawKeys = new Map<string, string>();
  const periods = normalizedPeriods(statements);
  periods.forEach(p => p.stmt.rawLineItems.forEach(item => rawKeys.set(`account:${rawAccountKey(item)}`, item.name)));
  Array.from(rawKeys.keys()).forEach(key => { rows[key] = row++; });
  concepts.forEach(concept => { rows[`concept:${concept.id}`] = row++; });
  return rows;
}

function formulaToExcelCellRefs(formula: string, dataCol: string, rowMap: Record<string, number>): string {
  const f = (formula || '').trim();
  const ref = (key: string) => {
    const row = rowMap[key];
    return row ? `'Datos Covenant'!${dataCol}$${row}` : '0';
  };
  if (f.startsWith('expr:')) {
    try {
      const tokens = JSON.parse(f.slice('expr:'.length)) as string[];
      const body = tokens.map(t => {
        if (t.startsWith('ref:')) return ref(t.slice(4));
        if (t.startsWith('num:')) return t.slice(4);
        return t;
      }).join('');
      return `=IFERROR(${body},"")`;
    } catch {
      return '=""';
    }
  }
  if (f.startsWith('ratio:')) {
    const [num, den] = f.slice('ratio:'.length).split('/');
    return num && den ? `=IFERROR(${ref(num)}/${ref(den)},"")` : '=""';
  }
  const low = f.toLowerCase();
  if (low.includes('deuda') && low.includes('ebitda')) return `=IFERROR(${ref('totalDebt')}/${ref('ebitda')},"")`;
  if (low.includes('dscr') || (low.includes('ebitda') && low.includes('interes'))) return `=IFERROR(${ref('ebitda')}/${ref('interestExpense')},"")`;
  if (low.includes('corriente') || low.includes('liquidez')) return `=IFERROR(${ref('currentAssets')}/${ref('currentLiabilities')},"")`;
  if (low.includes('roa')) return `=IFERROR(${ref('netIncome')}/${ref('totalAssets')},"")`;
  if (low.includes('roe')) return `=IFERROR(${ref('netIncome')}/${ref('equity')},"")`;
  if (low.includes('apalanc') || low.includes('equity') || low.includes('capital')) return `=IFERROR(${ref('totalDebt')}/${ref('equity')},"")`;
  return '=""';
}

function textFormula(value: string) {
  return value.startsWith('=') ? `'${value}` : value;
}

function covenantOperatorLabel(operator: Covenant_DB['operator']) {
  if (operator === 'gt') return '>';
  if (operator === 'gte') return '>=';
  if (operator === 'lt') return '<';
  if (operator === 'lte') return '<=';
  return '';
}

function covenantIsMinimum(operator: Covenant_DB['operator']) {
  return operator === 'gt' || operator === 'gte';
}

function covenantCompareFormula(actualCell: string, limitCell: string, operator: Covenant_DB['operator']) {
  const compare =
    operator === 'gt' ? `${actualCell}>${limitCell}` :
    operator === 'gte' ? `${actualCell}>=${limitCell}` :
    operator === 'lt' ? `${actualCell}<${limitCell}` :
    operator === 'lte' ? `${actualCell}<=${limitCell}` :
    'TRUE';
  return `=IF(OR(NOT(ISNUMBER(${actualCell})),NOT(ISNUMBER(${limitCell}))),"",IF(${compare},"CUMPLE","INCUMPLE"))`;
}

function covenantCushionFormula(actualCell: string, limitCell: string, operator: Covenant_DB['operator']) {
  const body = covenantIsMinimum(operator) ? `${actualCell}-${limitCell}` : `${limitCell}-${actualCell}`;
  return `=IF(OR(NOT(ISNUMBER(${actualCell})),NOT(ISNUMBER(${limitCell}))),"",${body})`;
}

function nrm(v: string) {
  return v.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function nkey(v: string) {
  return v.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '');
}

function rawValue(stmt: FinancialStatement_DB, account: string, type: 'balance_general' | 'estado_resultados') {
  return (stmt.rawLineItems || []).find(l => l.name === account && ((l.statementType || 'balance_general') === type))?.value ?? null;
}

function orderedAccounts(statements: FinancialStatement_DB[], type: 'balance_general' | 'estado_resultados') {
  const set = new Set<string>();
  statements.forEach(s => (s.rawLineItems || []).forEach(li => {
    const liType = li.statementType || 'balance_general';
    if (liType === type) set.add(li.name);
  }));
  return Array.from(set);
}

function mappedFieldFor(statements: FinancialStatement_DB[], key: string): string {
  for (const stmt of statements) {
    const found = (stmt.extraAccounts || []).find(a => a.key === key);
    if (found?.label) return found.label;
  }
  return '';
}

function exportSegment(item: FinancialStatement_DB['rawLineItems'][number]) {
  const type = item.statementType || 'otro';
  const path = nkey(item.sectionPath || '');
  const name = nkey(item.name || '');
  const isCapitalName = /(capitalsocial|capitalcontable|patrimonio|resultadoacumulado|utilidadretenida|resultadodelejercicio)/.test(name);
  const isPasivoName = /(pasivo|proveedor|acreedor|deuda|obligacion|prestamo|impuesto|seguro|social|imss|isr|iva|ptu|provision|cuentaporpagar|cxp)/.test(name);
  if (type === 'estado_resultados' || path.includes('estadoresultado')) return 'Estado de Resultados';
  if (type === 'flujo_efectivo' || path.includes('flujoefectivo')) return 'Flujo de Efectivo';
  if (path.includes('manual') || path.includes('auditoria')) {
    if (path.includes('activo')) return 'ACTIVO';
    if (path.includes('pasivo') && !isCapitalName) return 'PASIVO';
    if (path.includes('capital') || path.includes('patrimonio')) return isPasivoName && !isCapitalName ? 'PASIVO' : 'CAPITAL';
    if (path.includes('estadoresultado')) return 'Estado de Resultados';
    if (path.includes('flujoefectivo')) return 'Flujo de Efectivo';
    if (path.includes('otros')) return 'Otros';
  }
  // Liability wording takes precedence over a generic "capital" mention, as in
  // "Pasivo y capital". Only explicit equity account names belong in CAPITAL.
  if (isPasivoName && !isCapitalName) return 'PASIVO';
  if (isCapitalName || name.includes('capital')) return 'CAPITAL';
  if (/(activo|caja|banco|efectivo|cliente|cuentaporcobrar|inventario|propiedad|equipo|intangible)/.test(name)) return 'ACTIVO';
  if (path.includes('pasivo')) return 'PASIVO';
  if (path.includes('capital') || path.includes('patrimonio')) return 'CAPITAL';
  if (path.includes('activo')) return 'ACTIVO';
  if (type === 'balance_general') return 'Balance General sin clasificar';
  return 'Otros';
}

function accountSortRank(name: string, segment: string) {
  const n = nkey(name);
  if (segment === 'ACTIVO') {
    if (/(efectivo|caja|banco)/.test(n)) return 10;
    if (/(inversion|valores)/.test(n)) return 20;
    if (/(cliente|cuentaporcobrar|cxc|derechodecobro|cartera|credito|vigente|vencida)/.test(n)) return 30;
    if (/(estimacion|reserva|preventiva|deterioro)/.test(n)) return 35;
    if (/(inventario|iva|impuestoacreditable|pagosanticipados|anticipo)/.test(n)) return 40;
    if (/(propiedad|inmueble|mobiliario|equipo|activo fijo|activofijo)/.test(n)) return 60;
    if (/(intangible|software|deposito|garantia|diferido)/.test(n)) return 70;
    if (/(total|suma)/.test(n)) return 99;
    return 50;
  }
  if (segment === 'PASIVO') {
    if (/(proveedor|cuentaporpagar|cxp|acreedor)/.test(n)) return 10;
    if (/(impuesto|seguro|social|imss|isr|iva|ptu|provision)/.test(n)) return 20;
    if (/(deuda|prestamo|credito|banco|linea|bursatil|arrendamiento)/.test(n)) return 30;
    if (/(largo|nocorriente|nocirculante)/.test(n)) return 60;
    if (/(total|suma)/.test(n)) return 99;
    return 40;
  }
  if (segment === 'CAPITAL') {
    if (/(capitalsocial|capital)/.test(n)) return 10;
    if (/(prima|reserva)/.test(n)) return 20;
    if (/(resultado|utilidad|perdida|retenida|acumulada)/.test(n)) return 30;
    if (/(total|suma)/.test(n)) return 99;
    return 50;
  }
  if (segment === 'Estado de Resultados') {
    if (/(ingreso|venta)/.test(n) && !/(otro|gasto)/.test(n)) return 10;
    if (/(costo)/.test(n)) return 20;
    if (/(utilidadbruta|margenbruto)/.test(n)) return 30;
    if (/(gasto|administracion|venta|operativo|nomina|sueldo|depreciacion|amortizacion)/.test(n)) return 40;
    if (/(utilidadoperativa|resultadooperativo|ebitda)/.test(n)) return 50;
    if (/(otroingreso|otrosingresos|otrogasto|otrosgastos|financiamiento|interes)/.test(n)) return 60;
    if (/(antesdeimpuesto|antesdeisr)/.test(n)) return 70;
    if (/(impuesto|isr|ptu)/.test(n)) return 80;
    if (/(utilidadneta|resultadoneto|perdidaneta)/.test(n)) return 99;
    return 65;
  }
  return 50;
}

function rawValueByKey(stmt: FinancialStatement_DB, key: string) {
  const item = stmt.rawLineItems.find(i => `${i.statementType || 'otro'}||${i.name}` === key);
  return item?.value ?? null;
}

function verticalBaseValue(stmt: FinancialStatement_DB, segment: string, bases: VerticalBaseConfig = {}, concepts: DefinedConcept[] = []) {
  const find = (names: string[]) => stmt.rawLineItems.find(i => {
    const n = nkey(i.name);
    return names.some(name => n.includes(nkey(name)));
  })?.value ?? null;
  const totalAssets = stmt.mappedData.totalAssets || find(['suma del activo', 'total activo', 'activos totales']);
  if (segment === 'ACTIVO' || segment === 'PASIVO' || segment === 'CAPITAL' || segment === 'Balance General sin clasificar') {
    return totalAssets;
  }

  const customKey = bases[segment];
  if (customKey) {
    const concept = customKey.startsWith('concept:') ? concepts.find(c => c.id === customKey.slice('concept:'.length)) : undefined;
    const custom = concept ? evaluateFormula(`expr:${JSON.stringify(concept.tokens)}`, stmt) : rawValueByKey(stmt, customKey);
    if (custom !== null) return custom;
  }
  if (segment === 'Estado de Resultados') return stmt.mappedData.revenue || find(['total ingresos', 'ingresos', 'ventas']);
  return null;
}

function valueColForAnalysisPeriod(periodIndex: number) {
  return 3 + periodIndex * 2;
}

function verticalColForAnalysisPeriod(periodIndex: number) {
  return 4 + periodIndex * 2;
}

function horizontalDeltaCol(periodCount: number, priorPeriodIndex: number) {
  return 3 + periodCount * 2 + priorPeriodIndex * 2;
}

function isBalanceTotalAccount(name: string, segment: string) {
  if (segment === 'Estado de Resultados') return false;
  return /(total|suma)/.test(nkey(name));
}

function totalLabelForSection(section: string) {
  if (section === 'ACTIVO') return 'TOTAL ACTIVO';
  if (section === 'PASIVO') return 'TOTAL PASIVO';
  if (section === 'CAPITAL') return 'TOTAL CAPITAL CONTABLE';
  if (section === 'Estado de Resultados') return 'INGRESOS TOTALES';
  return `TOTAL ${section.toUpperCase()}`;
}

function sumFormulaForRows(rowNumbers: number[], valueCol: number) {
  if (!rowNumbers.length) return null;
  return `=SUM(${rowNumbers.map(row => `${colName(valueCol)}${row}`).join(',')})`;
}

function totalValueForSection(
  stmt: FinancialStatement_DB,
  section: string,
  valueCol: number,
  detailRows: number[],
  bases: VerticalBaseConfig = {},
  concepts: DefinedConcept[] = [],
) {
  const detailSum = sumFormulaForRows(detailRows, valueCol);
  const base = verticalBaseValue(stmt, section, bases, concepts);

  if (section === 'ACTIVO' || section === 'Estado de Resultados') return base ?? detailSum;
  if (section === 'CAPITAL') return stmt.mappedData.equity || detailSum;
  if (section === 'PASIVO') {
    const totalAssets = verticalBaseValue(stmt, 'ACTIVO', bases, concepts);
    const equity = stmt.mappedData.equity || null;
    if (totalAssets !== null && equity !== null) return totalAssets - equity;
    return detailSum;
  }

  return detailSum ?? base;
}

function addVerticalBaseRow(
  rows: SheetDef['rows'],
  section: string,
  periods: Array<{ label: string; stmt: FinancialStatement_DB }>,
  detailRows: number[],
  denominatorRowNumber?: number,
  bases: VerticalBaseConfig = {},
  concepts: DefinedConcept[] = [],
) {
  const rowNumber = rows.length + 1;
  const row: SheetDef['rows'][0] = [totalLabelForSection(section), section];
  const denominatorRow = denominatorRowNumber || rowNumber;
  periods.forEach((p, i) => {
    const valueCol = valueColForAnalysisPeriod(i);
    row.push(totalValueForSection(p.stmt, section, valueCol, detailRows, bases, concepts));
    row.push(`=IFERROR(${colName(valueCol)}${rowNumber}/${colName(valueCol)}$${denominatorRow},"")`);
  });
  periods.slice(1).forEach((_, i) => {
    const prevValueCol = valueColForAnalysisPeriod(i);
    const valueCol = valueColForAnalysisPeriod(i + 1);
    row.push(`=IFERROR(${colName(valueCol)}${rowNumber}-${colName(prevValueCol)}${rowNumber},"")`);
    row.push(`=IFERROR((${colName(valueCol)}${rowNumber}-${colName(prevValueCol)}${rowNumber})/ABS(${colName(prevValueCol)}${rowNumber}),"")`);
  });
  rows.push(row);
  return rowNumber;
}

function addAnalysisRow(rows: SheetDef['rows'], label: string, section: string, key: string, periods: Array<{ label: string; stmt: FinancialStatement_DB }>, baseRowNumber: number) {
  const rowNumber = rows.length + 1;
  const row: SheetDef['rows'][0] = [label, section];
  const values = periods.map(p => rawValueByKey(p.stmt, key));
  values.forEach((value, i) => {
    const valueCol = valueColForAnalysisPeriod(i);
    row.push(value);
    row.push(`=IFERROR(IF(${colName(valueCol)}${rowNumber}="","",${colName(valueCol)}${rowNumber}/${colName(valueCol)}$${baseRowNumber}),"")`);
  });
  periods.slice(1).forEach((_, i) => {
    const prevValueCol = valueColForAnalysisPeriod(i);
    const valueCol = valueColForAnalysisPeriod(i + 1);
    row.push(`=IFERROR(${colName(valueCol)}${rowNumber}-${colName(prevValueCol)}${rowNumber},"")`);
    row.push(`=IFERROR((${colName(valueCol)}${rowNumber}-${colName(prevValueCol)}${rowNumber})/ABS(${colName(prevValueCol)}${rowNumber}),"")`);
  });
  rows.push(row);
  return rowNumber;
}

function addBalanceCheckRows(rows: SheetDef['rows'], periods: Array<{ label: string; stmt: FinancialStatement_DB }>, totalRows: Record<string, number>) {
  const assetRow = totalRows.ACTIVO;
  const liabilityRow = totalRows.PASIVO;
  const equityRow = totalRows.CAPITAL;
  if (!assetRow || !liabilityRow || !equityRow) return;

  rows.push([]);

  const liabilityEquityRowNumber = rows.length + 1;
  const liabilityEquityRow: SheetDef['rows'][0] = ['TOTAL PASIVO + CAPITAL', 'Balance General'];
  periods.forEach((_, i) => {
    const valueCol = valueColForAnalysisPeriod(i);
    liabilityEquityRow.push(`=${colName(valueCol)}${liabilityRow}+${colName(valueCol)}${equityRow}`);
    liabilityEquityRow.push(`=IFERROR(${colName(valueCol)}${liabilityEquityRowNumber}/${colName(valueCol)}$${assetRow},"")`);
  });
  periods.slice(1).forEach((_, i) => {
    const prevValueCol = valueColForAnalysisPeriod(i);
    const valueCol = valueColForAnalysisPeriod(i + 1);
    liabilityEquityRow.push(`=IFERROR(${colName(valueCol)}${liabilityEquityRowNumber}-${colName(prevValueCol)}${liabilityEquityRowNumber},"")`);
    liabilityEquityRow.push(`=IFERROR((${colName(valueCol)}${liabilityEquityRowNumber}-${colName(prevValueCol)}${liabilityEquityRowNumber})/ABS(${colName(prevValueCol)}${liabilityEquityRowNumber}),"")`);
  });
  rows.push(liabilityEquityRow);

  const differenceRowNumber = rows.length + 1;
  const differenceRow: SheetDef['rows'][0] = ['DIFERENCIA ACTIVO - PASIVO + CAPITAL', 'Balance General'];
  periods.forEach((_, i) => {
    const valueCol = valueColForAnalysisPeriod(i);
    differenceRow.push(`=${colName(valueCol)}${assetRow}-${colName(valueCol)}${liabilityEquityRowNumber}`);
    differenceRow.push(`=IFERROR(${colName(valueCol)}${differenceRowNumber}/${colName(valueCol)}$${assetRow},"")`);
  });
  periods.slice(1).forEach((_, i) => {
    const prevValueCol = valueColForAnalysisPeriod(i);
    const valueCol = valueColForAnalysisPeriod(i + 1);
    differenceRow.push(`=IFERROR(${colName(valueCol)}${differenceRowNumber}-${colName(prevValueCol)}${differenceRowNumber},"")`);
    differenceRow.push(`=IFERROR((${colName(valueCol)}${differenceRowNumber}-${colName(prevValueCol)}${differenceRowNumber})/ABS(${colName(prevValueCol)}${differenceRowNumber}),"")`);
  });
  rows.push(differenceRow);
}

function buildSegmentedAnalysisSheet(
  statements: FinancialStatement_DB[],
  name: string,
  segments: string[],
  bases: VerticalBaseConfig = {},
  concepts: DefinedConcept[] = [],
  footerRows: SheetDef['rows'] = [],
): SheetDef {
  const periods = normalizedPeriods(statements);
  const keys = new Map<string, { name: string; segment: string; sourceOrder: number }>();
  let sourceOrder = 0;
  periods.forEach(p => p.stmt.rawLineItems.forEach(item => {
    const segment = exportSegment(item);
    if (!segments.includes(segment)) return;
    const key = `${item.statementType || 'otro'}||${item.name}`;
    if (!keys.has(key)) keys.set(key, { name: item.name, segment, sourceOrder: sourceOrder++ });
  }));
  const rows: SheetDef['rows'] = [statementHeaders(periods)];
  const totalRows: Record<string, number> = {};
  segments.forEach(segment => {
    const items = Array.from(keys.entries())
      .filter(([, meta]) => meta.segment === segment)
      .filter(([, meta]) => !isBalanceTotalAccount(meta.name, segment))
      .sort((a, b) => segment === 'Estado de Resultados'
        ? a[1].sourceOrder - b[1].sourceOrder
        : accountSortRank(a[1].name, segment) - accountSortRank(b[1].name, segment)
          || a[1].sourceOrder - b[1].sourceOrder);
    if (!items.length) return;
    rows.push([segment]);
    const detailBaseRow = name === 'Balance General' && segment !== 'ACTIVO' && totalRows.ACTIVO
      ? totalRows.ACTIVO
      : rows.length + items.length + 1;
    const detailRows = items.map(([key, meta]) => addAnalysisRow(rows, meta.name, segment, key, periods, detailBaseRow));
    const denominatorRow = name === 'Balance General' && segment !== 'ACTIVO' && totalRows.ACTIVO
      ? totalRows.ACTIVO
      : undefined;
    totalRows[segment] = addVerticalBaseRow(rows, segment, periods, detailRows, denominatorRow, bases, concepts);
  });
  if (name === 'Balance General') addBalanceCheckRows(rows, periods, totalRows);
  if (footerRows.length > 0) {
    rows.push([], [], [], [], [], ...footerRows);
  }
  const nCols = rows[0].length;
  return { name, rows, colWidths: statementColWidths(periods.length), outlineColumns: statementOutlineColumns(nCols) };
}

function statementHeaders(periods: Array<{ label: string; stmt: FinancialStatement_DB }>) {
  return [
    'Cuenta',
    'Sección',
    ...periods.flatMap(p => [p.label, `% Vertical ${p.label}`]),
    ...periods.slice(1).flatMap(p => [`Δ ${p.label}`, `Δ% ${p.label}`]),
  ];
}

function addStatementRow(rows: SheetDef['rows'], label: string, section: string, periods: Array<{ label: string; stmt: FinancialStatement_DB }>, valueFn: (stmt: FinancialStatement_DB) => number | null, baseRowByPeriod: number[]) {
  const rowNumber = rows.length + 1;
  const row: SheetDef['rows'][0] = [label, section];
  periods.forEach((p, i) => {
    const valueCol = 3 + i * 2;
    row.push(valueFn(p.stmt));
    row.push(`=IFERROR(IF(${colName(valueCol)}${rowNumber}="","",${colName(valueCol)}${rowNumber}/${colName(valueCol)}${baseRowByPeriod[i]}),"")`);
  });
  periods.slice(1).forEach((_, i) => {
    const prevValueCol = 3 + i * 2;
    const valueCol = 5 + i * 2;
    row.push(`=IFERROR(${colName(valueCol)}${rowNumber}-${colName(prevValueCol)}${rowNumber},"")`);
    row.push(`=IFERROR((${colName(valueCol)}${rowNumber}-${colName(prevValueCol)}${rowNumber})/ABS(${colName(prevValueCol)}${rowNumber}),"")`);
  });
  rows.push(row);
}

function statementColWidths(periods: number) {
  return [38, 20, ...Array(periods).flatMap(() => [15, 10]), ...Array(Math.max(0, periods - 1)).flatMap(() => [14, 10])];
}

function statementOutlineColumns(nCols: number) {
  return Array.from({ length: Math.max(0, nCols - 2) }, (_, i) => i + 3);
}

export function buildEFFDashboard(statements: FinancialStatement_DB[], clientName: string): SheetDef {
  const periods = normalizedPeriods(statements);
  const latest = periods.at(-1)?.stmt;
  const rows: SheetDef['rows'] = [
    [`FINMONITOR EFF — ${clientName || 'Cliente'}`],
    [],
    ['Resumen SaaS', 'Valor'],
    ['Periodos cargados', periods.length],
    ['Último periodo', periods.at(-1)?.label || 'N/A'],
    ['Archivos fuente', new Set(statements.map(s => s.fileName).filter(Boolean)).size],
    [],
    ['KPIs últimos estados', 'Valor'],
    ['Ingresos', latest?.mappedData.revenue ?? null],
    ['EBITDA / Utilidad operativa', latest?.mappedData.ebitda ?? null],
    ['Utilidad neta', latest?.mappedData.netIncome ?? null],
    ['Activo total', latest?.mappedData.totalAssets ?? null],
    ['Deuda total', latest?.mappedData.totalDebt ?? null],
    ['Capital', latest?.mappedData.equity ?? null],
    [],
    ['Periodos incluidos'],
    ['Etiqueta', 'Fecha', 'Archivo'],
    ...periods.map(p => [p.label, p.stmt.periodDate, p.stmt.fileName || '']),
    [],
    ['Notas'],
    ['Las hojas BG/ER tienen una columna de valor por mes, % vertical por mes, y Δ / Δ% entre meses consecutivos.'],
    ['Las columnas de análisis están agrupadas con outline para colapsar/expandir desde Excel.'],
  ];
  return { name: 'Dashboard EFF', rows, colWidths: [34, 22, 42] };
}

export function buildDefinedConcepts(statements: FinancialStatement_DB[], concepts: DefinedConcept[]): SheetDef {
  const periods = normalizedPeriods(statements);
  if (!concepts.length) return { name: 'Conceptos Definidos', rows: [['Sin conceptos definidos']] };
  const labels: Record<string, string> = {};
  periods.forEach(p => p.stmt.rawLineItems.forEach(item => {
    labels[`account:${item.statementType || 'otro'}::${item.name}`] = item.name;
  }));
  const rows: SheetDef['rows'] = [
    ['CONCEPTOS DEFINIDOS'],
    [],
    ['Concepto', 'Fórmula', ...periods.map(p => p.label)],
  ];
  concepts.forEach(concept => {
    const formula = `expr:${JSON.stringify(concept.tokens)}`;
    rows.push([
      concept.name,
      formulaLabel(formula, labels),
      ...periods.map(p => evaluateFormula(formula, p.stmt)),
    ]);
  });
  return { name: 'Conceptos Definidos', rows, colWidths: [30, 60, ...Array(periods.length).fill(14)] };
}

export function buildCovenantDataSheet(statements: FinancialStatement_DB[], concepts: DefinedConcept[] = []): SheetDef {
  const periods = normalizedPeriods(statements);
  const rows: SheetDef['rows'] = [
    ['Referencia interna (no editar)', 'Tipo', 'Nombre visible', ...periods.map(p => p.label)],
  ];
  const metrics = [
    ['revenue', 'Ingresos'],
    ['ebitda', 'EBITDA'],
    ['interestExpense', 'Gasto financiero'],
    ['netIncome', 'Utilidad neta'],
    ['currentAssets', 'Activo corriente'],
    ['currentLiabilities', 'Pasivo corriente'],
    ['totalDebt', 'Deuda total'],
    ['totalAssets', 'Total activo'],
    ['equity', 'Capital'],
  ];
  metrics.forEach(([key, label]) => {
    rows.push([key, 'Métrica', label, ...periods.map(p => getMetric(p.stmt, key))]);
  });

  const rawKeys = new Map<string, string>();
  periods.forEach(p => p.stmt.rawLineItems.forEach(item => rawKeys.set(`account:${rawAccountKey(item)}`, item.name)));
  Array.from(rawKeys.entries()).forEach(([key, label]) => {
    rows.push([
      key,
      'Cuenta extraída',
      label,
      ...periods.map(p => {
        const item = p.stmt.rawLineItems.find(i => `account:${rawAccountKey(i)}` === key);
        return item?.value ?? null;
      }),
    ]);
  });

  concepts.forEach(concept => {
    rows.push([
      `concept:${concept.id}`,
      'Concepto definido',
      concept.name,
      ...periods.map((_, i) => formulaToExcel(`expr:${JSON.stringify(concept.tokens)}`, `${colName(4 + i)}$1`)),
    ]);
  });

  return {
    name: 'Datos Covenant',
    rows,
    colWidths: [42, 18, 36, ...Array(periods.length).fill(14)],
  };
}

// 2. Balance General — ordered monthly time-series
export function buildBG(statements: FinancialStatement_DB[], bases: VerticalBaseConfig = {}, concepts: DefinedConcept[] = [], covenants: Covenant_DB[] = []): SheetDef {
  const periods = normalizedPeriods(statements);
  const calculated = covenants
    .filter(c => c.type === 'financial')
    .map(c => ({ covenant: c, values: periods.map(p => evaluateCovValue(c, p.stmt)) }))
    .filter(row => row.values.some(value => value !== null));
  const footerRows: SheetDef['rows'] = calculated.length
    ? [
        ['COVENANTS CALCULADOS'],
        ['Covenant', 'Resultado', ...periods.flatMap(p => [p.label, ''])],
        ...calculated.map(({ covenant, values }) => [
          covenant.name,
          'Valor',
          ...values.flatMap(value => [value, null]),
        ]),
      ]
    : [];
  return buildSegmentedAnalysisSheet(statements, 'Balance General', ['ACTIVO', 'PASIVO', 'CAPITAL', 'Balance General sin clasificar'], bases, concepts, footerRows);
}

// 3. Estado de Resultados — ordered monthly time-series
export function buildER(statements: FinancialStatement_DB[], bases: VerticalBaseConfig = {}, concepts: DefinedConcept[] = []): SheetDef {
  return buildSegmentedAnalysisSheet(statements, 'Estado de Resultados', ['Estado de Resultados'], bases, concepts);
}

// 4. VARIACION A CIERRES — YoY comparison from two most recent December periods
export function buildVariacion(statements: FinancialStatement_DB[], clientName = ''): SheetDef {
  const sorted = [...statements].sort((a, b) => a.periodDate.localeCompare(b.periodDate));
  const decPeriods = sorted.filter(s => periodMonth(s) === 12);

  // fallback: use last two if no December periods
  const [prev, curr] = decPeriods.length >= 2
    ? decPeriods.slice(-2)
    : sorted.length >= 2 ? sorted.slice(-2) : [undefined, sorted[sorted.length - 1]];

  if (!curr) return { name: 'VARIACION A CIERRES', rows: [['Sin datos suficientes']] };

  const prevLabel = prev ? monthLabel(prev) : '—';
  const currLabel = monthLabel(curr);

  // Build account map using rawLineItems
  const accountSet = new Set<string>();
  for (const s of [prev, curr].filter(Boolean) as FinancialStatement_DB[]) {
    for (const li of s.rawLineItems || []) accountSet.add(li.name);
  }
  const accounts = Array.from(accountSet);

  const rows: SheetDef['rows'] = [
    ['VARIACION A CIERRES — ' + (clientName || curr.clientId).toUpperCase()],
    [],
    ['CUENTA', prevLabel, '% VERT', currLabel, '% VERT', 'VAR %'],
  ];

  // Balance sheet section
  rows.push(['BALANCE GENERAL']);
  const bgAccounts = accounts.filter(acc => {
    const inPrev = (prev?.rawLineItems || []).find(l => l.name === acc && (!l.statementType || l.statementType === 'balance_general'));
    const inCurr = (curr.rawLineItems || []).find(l => l.name === acc && (!l.statementType || l.statementType === 'balance_general'));
    return inPrev || inCurr;
  });

  const totalAssetsPrev = prev?.mappedData.totalAssets || 0;
  const totalAssetsCurr = curr.mappedData.totalAssets || 0;

  for (const acc of bgAccounts) {
    const vPrev = (prev?.rawLineItems || []).find(l => l.name === acc)?.value ?? null;
    const vCurr = (curr.rawLineItems || []).find(l => l.name === acc)?.value ?? null;
    const vertPrev = vPrev !== null && totalAssetsPrev ? vPrev / totalAssetsPrev : null;
    const vertCurr = vCurr !== null && totalAssetsCurr ? vCurr / totalAssetsCurr : null;
    const varPct = vPrev && vCurr ? (vCurr - vPrev) / Math.abs(vPrev) : null;
    rows.push([acc, vPrev, vertPrev, vCurr, vertCurr, varPct]);
  }

  // Mapped totals
  rows.push([], ['ESTADO DE RESULTADOS']);
  const erLines: [string, keyof FinancialStatement_DB['mappedData']][] = [
    ['Ingresos por Intereses', 'revenue'],
    ['Gastos por Intereses', 'interestExpense'],
    ['EBITDA', 'ebitda'],
    ['Resultado Neto', 'netIncome'],
    ['Activo Total', 'totalAssets'],
    ['Capital Contable', 'equity'],
    ['Deuda Total', 'totalDebt'],
  ];
  const revPrev = prev?.mappedData.revenue || 0;
  const revCurr = curr.mappedData.revenue || 0;
  for (const [label, key] of erLines) {
    const vPrev = prev?.mappedData[key] ?? null;
    const vCurr = curr.mappedData[key] ?? null;
    const vertPrev = vPrev !== null && revPrev ? (vPrev as number) / revPrev : null;
    const vertCurr = vCurr !== null && revCurr ? (vCurr as number) / revCurr : null;
    const varPct = vPrev && vCurr ? ((vCurr as number) - (vPrev as number)) / Math.abs(vPrev as number) : null;
    rows.push([label, vPrev, vertPrev, vCurr, vertCurr, varPct]);
  }

  return {
    name: 'VARIACION A CIERRES',
    rows,
    colWidths: [36, 16, 10, 16, 10, 10],
  };
}

// 5. MONITOREO — Dynamic covenant time-series
export function buildMonitoreo(
  covenants: Covenant_DB[],
  statements: FinancialStatement_DB[],
  concepts: DefinedConcept[] = [],
  transactionNames: TransactionNameMap = {},
): SheetDef {
  const financial = covenants.filter(c => c.type === 'financial');
  const periods = normalizedPeriods(statements);
  const labels = formulaLabelsFromStatements(statements, concepts);
  const rowMap = covenantDataRowMap(statements, concepts);

  if (financial.length === 0 || periods.length === 0) {
    return { name: 'Monitoreo', rows: [['Sin covenants financieros definidos']] };
  }

  const rows: SheetDef['rows'] = [
    ['MONITOREO DE COVENANTS — ' + new Date().getFullYear()],
    [],
    ['COVENANT', 'FACILITY', 'FÓRMULA LEGIBLE', 'OPERADOR', 'UMBRAL', ...periods.map(p => p.label)],
    [],
  ];

  for (const cov of financial) {
    const valueRow = rows.length + 1;
    const formula = cov.formula || cov.name;
    const values = periods.map((p, i) => formulaToExcelCellRefs(cov.formulaByPeriod?.[p.stmt.period] || formula, colName(4 + i), rowMap));
    const threshold = parseNullableFinancialNumber(cov.threshold);
    const facility = cov.transactionId ? transactionNames[cov.transactionId] || 'Facility sin nombre' : 'General / legacy';
    rows.push([cov.name, facility, formulaLabel(formula, labels), cov.operator, threshold, ...values]);
    rows.push(['', '', 'Cálculo automático con referencias internas; no editar las celdas de valor', '', 'UMBRAL', ...periods.map(() => threshold)]);
    if (cov.operator !== 'none' && threshold !== null) {
      rows.push([
        '',
        '',
        'Cumplimiento',
        '',
        '',
        ...periods.map((_, i) => {
          const cell = `${colName(6 + i)}${valueRow}`;
          const op =
            cov.operator === 'gt' ? '>' :
            cov.operator === 'gte' ? '>=' :
            cov.operator === 'lt' ? '<' :
            '<=';
          return `=IFERROR(IF(${cell}${op}${threshold},"CUMPLE","INCUMPLE"),"")`;
        }),
      ]);
    }
    rows.push([]); // spacer
  }

  return {
    name: 'Monitoreo',
    rows,
    colWidths: [30, 24, 46, 10, 10, ...Array(periods.length).fill(14)],
  };
}

export function buildCovenantsCalculados(
  covenants: Covenant_DB[],
  statements: FinancialStatement_DB[],
  concepts: DefinedConcept[] = [],
  transactionNames: TransactionNameMap = {},
): SheetDef {
  const financial = covenants.filter(c => c.type === 'financial');
  const periods = normalizedPeriods(statements);
  const labels = formulaLabelsFromStatements(statements, concepts);
  const rowMap = covenantDataRowMap(statements, concepts);

  if (financial.length === 0 || periods.length === 0) {
    return { name: 'Covenants Calculados', rows: [['Sin covenants financieros definidos']] };
  }

  const rows: SheetDef['rows'] = [
    ['COVENANTS CALCULADOS'],
    ['Cada covenant muestra Real, Límite, Holgura y Cumple. Las celdas de periodos son fórmulas auditables.'],
    [],
    ['Covenant', 'Facility', 'Línea', 'Fórmula / criterio', 'Fuente', ...periods.map(p => p.label)],
  ];
  const statusRowNumbers: number[] = [];

  financial.forEach(cov => {
    const formula = cov.formula || cov.name;
    const threshold = parseNullableFinancialNumber(cov.threshold);
    const facility = cov.transactionId ? transactionNames[cov.transactionId] || 'Facility sin nombre' : 'General / legacy';
    const opLabel = covenantOperatorLabel(cov.operator);
    const realRow = rows.length + 1;
    const limitRow = realRow + 1;
    const cushionRow = realRow + 2;
    const statusRow = realRow + 3;
    statusRowNumbers.push(statusRow);
    const valueFormulas = periods.map((p, i) => formulaToExcelCellRefs(cov.formulaByPeriod?.[p.stmt.period] || formula, colName(4 + i), rowMap));
    const cushionFormulas = periods.map((_, i) => {
      const col = colName(6 + i);
      return cov.operator === 'none' || threshold === null ? '=""' : covenantCushionFormula(`${col}${realRow}`, `${col}${limitRow}`, cov.operator);
    });
    const statusFormulas = periods.map((_, i) => {
      const col = colName(6 + i);
      return cov.operator === 'none' || threshold === null ? '=""' : covenantCompareFormula(`${col}${realRow}`, `${col}${limitRow}`, cov.operator);
    });

    rows.push([
      cov.name,
      facility,
      'Real',
      textFormula(formulaLabel(formula, labels)),
      'Datos Covenant',
      ...valueFormulas,
    ]);
    rows.push([
      cov.name,
      facility,
      `Límite ${opLabel || 'N/A'}`,
      textFormula(opLabel ? (covenantIsMinimum(cov.operator) ? '=Mínimo requerido' : '=Máximo permitido') : '=Sin límite contractual'),
      'Umbral covenant',
      ...periods.map(() => threshold),
    ]);
    rows.push([
      cov.name,
      facility,
      'Holgura',
      textFormula(covenantIsMinimum(cov.operator) ? '=Real - Límite' : '=Límite - Real'),
      'Cálculo',
      ...cushionFormulas,
    ]);
    rows.push([
      cov.name,
      facility,
      'Cumple',
      textFormula(opLabel ? `=IF(Real${opLabel}Límite,"CUMPLE","INCUMPLE")` : '=Sin prueba'),
      'Cálculo',
      ...statusFormulas,
    ]);
    rows.push([
      cov.name,
      facility,
      'Fórmula Real visible',
      'Texto visible',
      'Auditoría',
      ...valueFormulas.map(textFormula),
    ]);
    rows.push([
      cov.name,
      facility,
      'Fórmula Holgura visible',
      'Texto visible',
      'Auditoría',
      ...cushionFormulas.map(textFormula),
    ]);
    rows.push([
      cov.name,
      facility,
      'Fórmula Cumple visible',
      'Texto visible',
      'Auditoría',
      ...statusFormulas.map(textFormula),
    ]);
    rows.push([]);
  });

  rows.push(
    [],
    ['RESUMEN DE INCUMPLIMIENTOS POR PERIODO'],
    ['Métrica', '', '', 'Fórmula', 'Notas', ...periods.map(p => p.label)],
    [
      'Incumplimientos',
      '',
      '',
      textFormula('=COUNTIF(statuses,"INCUMPLE")'),
      'Cuenta covenants incumplidos por fecha',
      ...periods.map((_, i) => {
        const col = colName(6 + i);
        const statusCells = statusRowNumbers.map(rowNumber => `${col}${rowNumber}`);
        return `=${statusCells.map(cell => `COUNTIF(${cell},"INCUMPLE")`).join('+')}`;
      }),
    ],
  );

  return {
    name: 'Covenants Calculados',
    rows,
    colWidths: [32, 24, 16, 48, 22, ...Array(periods.length).fill(14)],
    wrapColumns: [1, 2, 4, 5],
  };
}

export function buildCovenantTrendAnalysis(
  covenants: Covenant_DB[],
  statements: FinancialStatement_DB[],
  clientName: string,
  contractCovenantKeys: string[] = [],
  transactionNames: TransactionNameMap = {},
): SheetDef {
  const performance = prioritizedLatestCovenantPerformance(
    covenants.filter(c => c.type === 'financial'),
    statements,
    contractCovenantKeys,
  );
  const covenantById = new Map(covenants.map(cov => [cov.id, cov]));
  const insight = buildCovenantAnalystInsight(performance);
  const rows: SheetDef['rows'] = [
    [`ANÁLISIS DE TENDENCIA DE COVENANTS — ${clientName.toUpperCase()}`],
    [],
    ['INSIGHT PARA EL ANALISTA'],
    [insight.headline],
    ...insight.bullets.map(bullet => [`• ${bullet}`]),
    [],
    ['PRIORIDAD', 'CONTRATO', 'FACILITY', 'COVENANT', 'ÚLTIMO PERIODO', 'VALOR ACTUAL', 'VALOR ANTERIOR', 'CAMBIO', 'CAMBIO %', 'TENDENCIA', 'ESTADO', 'LÍMITE'],
    ...performance.map((row, index) => [
      index + 1,
      row.isContractCovenant ? 'SÍ' : 'NO',
      covenantById.get(row.covenantId)?.transactionId
        ? transactionNames[covenantById.get(row.covenantId)!.transactionId!] || 'Facility sin nombre'
        : 'General / legacy',
      row.covenantName,
      row.period,
      row.value,
      row.previousValue,
      row.delta,
      row.deltaPct,
      row.movementLabel,
      row.status.toUpperCase(),
      row.operator === 'none' ? 'N/A' : `${row.operator} ${row.threshold}`,
    ]),
  ];
  return {
    name: 'Análisis Covenant',
    rows,
    colWidths: [10, 11, 24, 32, 16, 15, 15, 14, 12, 15, 14, 16],
  };
}

function evaluateCovValue(cov: Covenant_DB, s: FinancialStatement_DB): number | null {
  const formula = cov.formulaByPeriod?.[s.period] || cov.formula || cov.name;
  const computed = evaluateFormula(formula, s);
  if (computed !== null) return computed;
  const m = s.mappedData;
  const low = formula.toLowerCase();
  if (low.includes('deuda') && low.includes('ebitda')) return m.ebitda ? m.totalDebt / m.ebitda : null;
  if (low.includes('dscr') || (low.includes('ebitda') && low.includes('interes'))) return m.interestExpense ? m.ebitda / m.interestExpense : null;
  if (low.includes('corriente') || low.includes('liquidez')) return m.currentLiabilities ? m.currentAssets / m.currentLiabilities : null;
  if (low.includes('capital') || low.includes('equity')) return m.totalAssets ? (m.equity / m.totalAssets) * 100 : null;
  if (low.includes('capitalización') || low.includes('capitalizacion')) return m.totalAssets ? m.equity / m.totalAssets : null;
  if (low.includes('vencida')) return m.totalDebt && m.currentLiabilities ? m.currentLiabilities / m.totalDebt : null;
  return null;
}

// 6. OBLIGACIONES — templated (matches OBLIGACIONES DE HACER Y NO HACER.xlsx exactly)
async function exportHacerNoHacerExcel(covenants: Covenant_DB[], clientName: string): Promise<void> {
  const hacer = covenants.filter(c => c.type === 'hacer');
  const noHacer = covenants.filter(c => c.type === 'noHacer');

  const wb = new ExcelJS.Workbook();
  wb.creator = 'FinMonitor';
  wb.created = new Date();
  const ws = wb.addWorksheet('Obligaciones');

  ws.columns = [
    { width: 2.0 },   // A — margin
    { width: 5.0 },   // B — número
    { width: 109.0 }, // C — contenido
    { width: 22.0 },  // D — frecuencia / condiciones
    { width: 2.0 },   // E — margin
  ];

  const BLUE      = 'FF1E1ECC';
  const LT_BLUE   = 'FFEBF3FF';
  const GRAY_NUM  = 'FFF2F2F2';
  const WHITE     = 'FFFFFFFF';

  const thinLine = { style: 'thin' as const, color: { argb: 'FFBFBFBF' } };
  const allBorders = { left: thinLine, right: thinLine, top: thinLine, bottom: thinLine };

  const put = (row: number, col: number, value: string | number | null, opts: {
    bg?: string; fg?: string; bold?: boolean; sz?: number;
    align?: 'left' | 'center' | 'right'; bdr?: boolean; wrap?: boolean;
  } = {}) => {
    const cell = ws.getCell(row, col);
    cell.value = value;
    cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: opts.bg ?? WHITE } };
    cell.font  = { name: 'Arial', size: opts.sz ?? 9, bold: opts.bold ?? false, color: { argb: opts.fg ?? 'FF000000' } };
    cell.alignment = { horizontal: opts.align ?? 'left', vertical: 'middle', wrapText: opts.wrap ?? false };
    if (opts.bdr) cell.border = allBorders;
  };

  let r = 1;

  // spacer rows 1–3
  ws.mergeCells(r, 1, r, 5); ws.getRow(r).height = 4.5;  r++;
  ws.getRow(r).height = 24.0; r++;
  ws.mergeCells(r, 1, r, 5); ws.getRow(r).height = 4.5;  r++;

  // Title — B4:E4
  ws.mergeCells(r, 2, r, 5);
  put(r, 2, 'OBLIGACIONES DE HACER Y NO HACER', { bg: BLUE, fg: 'FFFFFFFF', bold: true, sz: 9, bdr: true });
  ws.getRow(r).height = 21.75; r++;

  // Subtitle — B5:E5
  ws.mergeCells(r, 2, r, 5);
  const dateStr = new Date().toLocaleDateString('es-MX', { day: '2-digit', month: 'long', year: 'numeric' });
  put(r, 2, `Documento informativo · ${clientName} · ${dateStr}`, { bg: LT_BLUE, sz: 8, bdr: true });
  ws.getRow(r).height = 13.5; r++;

  // spacer row 6
  ws.getRow(r).height = 7.5; r++;

  // Disclaimer — B7:D7
  ws.mergeCells(r, 2, r, 4);
  put(r, 2,
    'Este documento es un resumen ejecutivo sobre las obligaciones contractuales. ' +
    'Las obligaciones completas, sus definiciones y consecuencias de incumplimiento constan en el Contrato de Crédito respectivo.',
    { bg: WHITE, sz: 8, bdr: true, wrap: true });
  ws.getRow(r).height = 19.5; r++;

  // spacer row 8
  ws.getRow(r).height = 7.5; r++;

  // ── I. HACER ────────────────────────────────────────────────────────────────
  ws.mergeCells(r, 2, r, 4);
  put(r, 2, '  I.  OBLIGACIONES DE HACER', { bg: BLUE, fg: 'FFFFFFFF', bold: true, sz: 9, bdr: true });
  ws.getRow(r).height = 13.5; r++;

  put(r, 2, '#',                  { bg: BLUE, fg: 'FFFFFFFF', bold: true, sz: 8, bdr: true, align: 'center' });
  put(r, 3, 'Obligación',         { bg: BLUE, fg: 'FFFFFFFF', bold: true, sz: 8, bdr: true, align: 'center' });
  put(r, 4, 'Frecuencia / Plazo', { bg: BLUE, fg: 'FFFFFFFF', bold: true, sz: 8, bdr: true, align: 'center' });
  ws.getRow(r).height = 13.5; r++;

  if (hacer.length === 0) {
    put(r, 2, '', { bdr: true });
    put(r, 3, 'Sin obligaciones de hacer registradas', { sz: 9, bdr: true });
    put(r, 4, '', { bdr: true });
    ws.getRow(r).height = 19.5; r++;
  }
  for (let i = 0; i < hacer.length; i++) {
    const bg = i % 2 === 0 ? LT_BLUE : WHITE;
    put(r, 2, String(i + 1), { bg: GRAY_NUM, bold: true, sz: 9, bdr: true, align: 'center' });
    put(r, 3, hacer[i].description || hacer[i].name, { bg, sz: 9, bdr: true, wrap: true });
    put(r, 4, '',                                    { bg, sz: 9, bdr: true });
    ws.getRow(r).height = 19.5; r++;
  }

  // spacer between sections
  ws.getRow(r).height = 15.75; r++;

  // ── II. NO HACER ────────────────────────────────────────────────────────────
  ws.mergeCells(r, 2, r, 4);
  put(r, 2, '  II.  OBLIGACIONES DE NO HACER', { bg: BLUE, fg: 'FFFFFFFF', bold: true, sz: 9, bdr: true });
  ws.getRow(r).height = 13.5; r++;

  put(r, 2, '#',                           { bg: BLUE, fg: 'FFFFFFFF', bold: true, sz: 8, bdr: true, align: 'center' });
  put(r, 3, 'Restricción',                 { bg: BLUE, fg: 'FFFFFFFF', bold: true, sz: 8, bdr: true, align: 'center' });
  put(r, 4, 'Condiciones / Excepciones',   { bg: BLUE, fg: 'FFFFFFFF', bold: true, sz: 8, bdr: true, align: 'center' });
  ws.getRow(r).height = 13.5; r++;

  if (noHacer.length === 0) {
    put(r, 2, '', { bdr: true });
    put(r, 3, 'Sin obligaciones de no hacer registradas', { sz: 9, bdr: true });
    put(r, 4, '', { bdr: true });
    ws.getRow(r).height = 19.5; r++;
  }
  for (let i = 0; i < noHacer.length; i++) {
    const bg = i % 2 === 0 ? LT_BLUE : WHITE;
    put(r, 2, String(i + 1), { bg: GRAY_NUM, bold: true, sz: 9, bdr: true, align: 'center' });
    put(r, 3, noHacer[i].description || noHacer[i].name, { bg, sz: 9, bdr: true, wrap: true });
    put(r, 4, '',                                        { bg, sz: 9, bdr: true });
    ws.getRow(r).height = 19.5; r++;
  }
  ws.getRow(r).height = 15.75;

  const buf = await wb.xlsx.writeBuffer();
  downloadBlob(
    new Blob([buf as ArrayBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    `${todayStamp()} - Obligaciones_${clientName}.xlsx`,
  );
}

// 7. TRANSACCIONES
export function buildTransacciones(transactions: Transaction[]): SheetDef {
  const rows: SheetDef['rows'] = [
    ['TRANSACCIONES'],
    [],
    ['Nombre', 'Tipo de Crédito', 'Monto', 'Moneda', 'Fecha', 'Firma', 'Vencimiento', 'Descripción'],
    ...transactions.map(t => [
      t.name, t.creditType, parseFinancialNumber(t.originalAmount), t.currency,
      fmtDate(t.date), fmtDate(t.signedAt), fmtDate(t.maturityAt), t.description,
    ]),
  ];
  return {
    name: 'Transacciones',
    rows,
    colWidths: [28, 20, 16, 10, 14, 14, 14, 40],
  };
}

// 8. LOAN TAPE
export function buildLoanTape(tapes: LoanTape_DB[], contexts = buildLoanTapeExportContexts(tapes)): SheetDef {
  const contextById = new Map(contexts.map(context => [context.tape.id, context]));
  const rows: SheetDef['rows'] = [
    ['LOAN TAPES'],
    [],
    ['Nombre', 'Tipo', 'Fecha Carga', 'Archivo', 'Preparación', 'Analizable', 'Campos críticos', 'Siguiente acción'],
    ...tapes.map(t => {
      const profile = contextById.get(t.id)?.profile;
      return [
        t.name,
        t.tapeType,
        fmtDate(t.uploadDate),
        t.fileName || '',
        profile?.readinessScore ?? null,
        profile?.canAnalyze ? 'Sí' : 'No',
        profile?.missingFields.filter(field => field.severity !== 'low').map(field => field.field).join(', ') || 'Ninguno',
        profile?.nextActions[0] || 'Sin acciones críticas',
      ];
    }),
  ];

  // Loan tapes are loaded newest-first; append legacy array data from the latest.
  const latest = tapes[0];
  if (latest?.extractedData) {
    const data = latest.extractedData;
    if (Array.isArray(data) && data.length > 0) {
      rows.push([]);
      rows.push(['DATOS EXTRAÍDOS — ' + latest.name]);
      const keys = Object.keys(data[0]);
      rows.push(keys);
      for (const row of data) rows.push(keys.map(k => row[k] ?? null));
    }
  }

  return {
    name: 'Loan Tape',
    rows,
    colWidths: [30, 16, 14, 32, 14, 12, 34, 60],
    wrapColumns: [7, 8],
  };
}

function rowsFromObjects(title: string, rowsIn?: any[], preferredKeys?: string[]): SheetDef['rows'] {
  const rows: SheetDef['rows'] = [[title], []];
  if (!rowsIn?.length) {
    rows.push(['Sin datos']);
    return rows;
  }
  const keys = preferredKeys?.length ? preferredKeys : Array.from(new Set(rowsIn.flatMap(row => Object.keys(row || {}))));
  rows.push(keys);
  rowsIn.forEach(row => rows.push(keys.map(k => row?.[k] ?? null)));
  return rows;
}

function portableValue(value: any): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'Sí' : 'No';
  return JSON.stringify(value);
}

function workspaceBlockColumns(block: LoanTapeWorkspaceBlock) {
  if (block.columns?.length) return block.columns;
  return Object.keys(block.data[0] || {}).map(key => ({ key, label: key }));
}

function buildLoanTapeAnalystSheet(tapes: LoanTape_DB[]): SheetDef {
  const rows: SheetDef['rows'] = [['ANÁLISIS GUARDADO DEL LOAN TAPE'], []];

  tapes.forEach((tape, tapeIndex) => {
    const state = normalizeLoanTapeAnalystState(tape.analystState);
    if (tapeIndex > 0) rows.push([]);
    rows.push([`${tape.name.toUpperCase()} — WORKSPACE`]);
    rows.push(['Archivo', tape.fileName || tape.name, 'Actualizado', state.updatedAt ? fmtDate(state.updatedAt) : 'N/D']);

    if (state.qa.question || state.qa.answer || state.qa.draft) {
      rows.push([]);
      rows.push(['Q&A GUARDADO']);
      rows.push(['Campo', 'Contenido']);
      if (state.qa.question) rows.push(['Pregunta', state.qa.question]);
      if (state.qa.answer) rows.push(['Respuesta', state.qa.answer]);
      if (state.qa.draft && state.qa.draft !== state.qa.question) rows.push(['Borrador', state.qa.draft]);
    }

    if (!state.workspaceBlocks.length) {
      rows.push([]);
      rows.push(['Sin bloques de análisis guardados']);
      return;
    }

    state.workspaceBlocks.forEach((block, blockIndex) => {
      const columns = workspaceBlockColumns(block);
      rows.push([]);
      rows.push([`BLOQUE ${blockIndex + 1} — ${block.title}`]);
      rows.push(['Tipo', block.type, 'Creado', fmtDate(block.createdAt)]);
      rows.push(['Prompt', block.prompt]);
      rows.push(['Descripción', block.description]);
      rows.push([]);
      rows.push(columns.map(column => column.label));
      block.data.forEach(item => rows.push(columns.map(column => portableValue(item[column.key]))));
    });
  });

  return {
    name: 'Analisis Guardado',
    rows,
    colWidths: [30, 30, 22, 22, 18, 18, 18, 18, 18, 18, 18, 18],
    wrapColumns: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  };
}

export function buildLoanTapeSheets(tapes: LoanTape_DB[]): SheetDef[] {
  const contexts = buildLoanTapeExportContexts(tapes);
  const summary = buildLoanTape(tapes, contexts);
  const allStandardized = contexts.flatMap(context => context.standardizedRows.map(row => ({ archivo: context.tape.fileName || context.tape.name, ...row })));
  const mapping = contexts.flatMap(context => context.mappingReport.map(row => ({ archivo: context.tape.fileName || context.tape.name, ...row })));
  const primaryContext = contexts[0];
  const analysis = primaryContext?.analysis || {} as any;
  const concentrations = analysis.concentrations || {};
  const anomalies = analysis.anomalies || {};

  return [
    summary,
    buildLoanTapeReadinessSheet(contexts),
    buildLoanTapeAnalystSheet(tapes),
    {
      name: 'Datos Estandarizados',
      rows: rowsFromObjects('DATOS ESTANDARIZADOS', allStandardized, ['archivo', 'loan_id', 'client', 'amount', 'outstanding_balance', 'interest_rate', 'loan_status', 'start_date', 'end_date', 'loan_type', 'days_overdue', 'currency', 'industry', 'state', 'file_date']),
      colWidths: [32, 18, 28, 16, 18, 14, 16, 14, 14, 20, 12, 10, 18, 18, 14],
    },
    {
      name: 'Mapeo',
      rows: rowsFromObjects('MAPEO DE COLUMNAS', mapping, ['archivo', 'source_header', 'target_term', 'confidence', 'reasoning']),
      colWidths: [32, 28, 22, 14, 42],
    },
    {
      name: 'Validacion',
      rows: rowsFromObjects('VALIDACION DE DATOS', analysis.validation, ['loan_id', 'rule_id', 'field', 'message', 'severity']),
      colWidths: [20, 22, 20, 55, 14],
    },
    {
      name: 'Concentraciones',
      rows: [
        ...rowsFromObjects('CONCENTRACION POR CLIENTE', concentrations.by_client, ['name', 'count', 'balance', 'pct']),
        [],
        ...rowsFromObjects('CONCENTRACION POR PRODUCTO', concentrations.by_loan_type, ['name', 'count', 'balance', 'pct', 'avg_interest_rate', 'avg_term_months', 'avg_days_overdue', 'min_amount', 'max_amount', 'avg_amount']),
        [],
        ...rowsFromObjects('CONCENTRACION POR ESTADO', concentrations.by_state, ['name', 'count', 'balance', 'pct']),
        [],
        ...rowsFromObjects('CONCENTRACION POR INDUSTRIA', concentrations.by_industry, ['name', 'count', 'balance', 'pct']),
      ],
      colWidths: [28, 14, 18, 12, 14, 14, 14, 16, 16, 16],
    },
    {
      name: 'Anomalias',
      rows: [
        ...rowsFromObjects('NUEVOS CREDITOS', anomalies.new_loans, ['loan_id', 'outstanding_balance', 'start_date', 'category', 'percentage']),
        [],
        ...rowsFromObjects('CREDITOS QUE DESAPARECEN', anomalies.disappeared_loans, ['loan_id', 'outstanding_balance', 'end_date', 'category', 'days_overdue_prev', 'percentage']),
        [],
        ...rowsFromObjects('VENCIDOS AUN ACTIVOS', anomalies.ended_loans, ['loan_id', 'outstanding_balance', 'end_date', 'days_overdue']),
        [],
        ...rowsFromObjects('DPD DETERIORO', anomalies.dpd_deterioration, ['loan_id', 'days_overdue_prev', 'days_overdue_latest']),
        [],
        ...rowsFromObjects('DPD MEJORA', anomalies.dpd_improvement, ['loan_id', 'days_overdue_prev', 'days_overdue_latest']),
        [],
        ...rowsFromObjects('DPD INCONSISTENTE', anomalies.dpd_inconsistency, ['loan_id', 'days_overdue_prev', 'days_overdue_latest', 'delta_days_overdue', 'category']),
        [],
        ...rowsFromObjects('CAMBIOS DE CONDICION', anomalies.condition_changes, ['loan_id', 'field_changed', 'value_prev', 'value_latest']),
      ],
      colWidths: [22, 18, 14, 24, 18, 14],
    },
  ];
}

function buildLoanTapeReadinessSheet(contexts: LoanTapeExportContext[]): SheetDef {
  const rows: SheetDef['rows'] = [['PREPARACIÓN Y CONTEXTO ANALÍTICO DEL LOAN TAPE'], []];

  contexts.forEach((context, contextIndex) => {
    const { tape, profile, analysis } = context;
    if (contextIndex > 0) rows.push([]);
    rows.push([`${tape.name.toUpperCase()} — DIAGNÓSTICO`]);
    rows.push(['Indicador', 'Valor', 'Contexto']);
    rows.push(
      ['Score de preparación', profile.readinessScore, 'Escala 0-100 calculada por completitud y validaciones'],
      ['Se puede analizar', profile.canAnalyze ? 'Sí' : 'No', profile.canAnalyze ? 'Hay campos suficientes para análisis local' : 'Faltan campos base para conclusiones confiables'],
      ['Registros', profile.totalRows, `Último corte: ${profile.latestFileDate || 'No identificado'} · ${profile.latestRows} registros en el corte`],
      ['Campos mapeados', profile.mappedFields.length, profile.mappedFields.join(', ') || 'Ninguno'],
      ['Alertas de validación', profile.validationCount, `${profile.duplicateCount} duplicado(s) detectado(s)`],
      ['Riesgo local', analysis.riskScore, `Estado: ${analysis.overallStatus || 'N/D'} · Tendencia: ${analysis.trendDirection || 'N/D'}`],
    );
    rows.push([]);
    rows.push(['CAMPOS CRÍTICOS FALTANTES']);
    rows.push(['Campo', 'Mapeado', 'Filas vacías', '% vacío', 'Severidad', 'Impacto']);
    const missing = profile.missingFields.filter(field => field.severity !== 'low');
    if (missing.length) {
      missing.forEach(field => rows.push([
        field.field,
        field.mapped ? 'Sí' : 'No',
        field.missingRows,
        field.missingPct,
        field.severity,
        field.impact,
      ]));
    } else {
      rows.push(['Ninguno', 'Sí', 0, 0, 'low', 'No hay campos críticos faltantes relevantes.']);
    }
    rows.push([]);
    rows.push(['SIGUIENTES ACCIONES']);
    rows.push(['Prioridad', 'Acción', 'Fuente']);
    (profile.nextActions.length ? profile.nextActions : ['Sin acciones críticas pendientes.']).forEach((action, index) => {
      rows.push([index + 1, action, 'Perfil local determinístico']);
    });
    rows.push([]);
    rows.push(['CONTEXTO DE ANÁLISIS LOCAL']);
    rows.push(['Resumen', analysis.executiveSummary || 'Sin resumen local', '']);
    rows.push(['Métrica', 'Valor actual', 'Valor anterior', 'Cambio', 'Tendencia', 'Estado']);
    (analysis.metrics || []).forEach(metric => rows.push([
      metric.name,
      metric.latestValue,
      metric.previousValue || '',
      metric.change || '',
      metric.trend || '',
      metric.status || '',
    ]));
    rows.push([]);
    rows.push(['HALLAZGOS LOCALES RELEVANTES']);
    rows.push(['Severidad', 'Categoría', 'Hallazgo', 'Detalle', 'Recomendación']);
    const findings = (analysis.findings || []).slice(0, 12);
    if (findings.length) {
      findings.forEach(finding => rows.push([
        finding.severity,
        finding.category,
        finding.title,
        finding.detail,
        finding.recommendation,
      ]));
    } else {
      rows.push(['low', 'Análisis local', 'Sin hallazgos adicionales', '', '']);
    }
  });

  return {
    name: 'Preparacion',
    rows,
    colWidths: [28, 24, 24, 18, 22, 64],
    wrapColumns: [1, 2, 3, 4, 5, 6],
  };
}

function loanTapePdfPage(title: string, subtitle: string): HTMLDivElement {
  const page = document.createElement('div');
  page.className = 'export-page';
  Object.assign(page.style, {
    width: '794px',
    minHeight: '1123px',
    padding: '54px',
    boxSizing: 'border-box',
    background: '#ffffff',
    color: '#1e293b',
    fontFamily: 'Arial, Helvetica, sans-serif',
  });
  const heading = document.createElement('h1');
  heading.textContent = title;
  Object.assign(heading.style, { margin: '0', fontSize: '28px', color: '#0f172a' });
  const subheading = document.createElement('p');
  subheading.textContent = subtitle;
  Object.assign(subheading.style, { margin: '8px 0 28px', fontSize: '12px', color: '#64748b' });
  page.append(heading, subheading);
  return page;
}

function appendPdfSection(page: HTMLElement, title: string, rows: Array<[string, string]>, accent = '#312e81') {
  const section = document.createElement('section');
  section.style.marginBottom = '24px';
  const heading = document.createElement('h2');
  heading.textContent = title;
  Object.assign(heading.style, {
    margin: '0 0 10px',
    padding: '9px 12px',
    fontSize: '12px',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    color: '#ffffff',
    background: accent,
  });
  section.appendChild(heading);
  rows.forEach(([label, value], index) => {
    const row = document.createElement('div');
    Object.assign(row.style, {
      display: 'grid',
      gridTemplateColumns: '190px 1fr',
      gap: '14px',
      padding: '9px 10px',
      fontSize: '11px',
      lineHeight: '1.35',
      background: index % 2 ? '#f8fafc' : '#ffffff',
      borderBottom: '1px solid #e2e8f0',
    });
    const labelEl = document.createElement('strong');
    labelEl.textContent = label;
    const valueEl = document.createElement('span');
    valueEl.textContent = value;
    row.append(labelEl, valueEl);
    section.appendChild(row);
  });
  page.appendChild(section);
}

function workspaceBlockPdfRows(block: LoanTapeWorkspaceBlock) {
  const columns = workspaceBlockColumns(block);
  return block.data.map((item, index) => {
    const values = columns.map(column => `${column.label}: ${portableValue(item[column.key]) ?? '—'}`);
    return [`${index + 1}`, values.join(' · ')] as [string, string];
  });
}

function buildLoanTapePdfPages(tapes: LoanTape_DB[], clientName: string): HTMLDivElement[] {
  const contexts = buildLoanTapeExportContexts(tapes);
  return contexts.flatMap(context => {
    const { tape, profile, analysis } = context;
    const subtitle = `${clientName || 'Cliente'} · ${tape.fileName || tape.name} · Exportado ${new Date().toLocaleDateString('es-MX')}`;
    const overview = loanTapePdfPage(`Loan Tape — ${tape.name}`, subtitle);
    appendPdfSection(overview, 'Preparación para análisis', [
      ['Score de preparación', `${profile.readinessScore}/100`],
      ['Se puede analizar', profile.canAnalyze ? 'Sí' : 'No'],
      ['Registros', String(profile.totalRows)],
      ['Último corte', profile.latestFileDate || 'No identificado'],
      ['Campos mapeados', profile.mappedFields.join(', ') || 'Ninguno'],
      ['Validaciones', `${profile.validationCount} alerta(s), ${profile.duplicateCount} duplicado(s)`],
    ]);
    appendPdfSection(overview, 'Campos críticos faltantes',
      (profile.missingFields.filter(field => field.severity !== 'low').slice(0, 9).map(field => [
        `${field.field} · ${field.severity}`,
        `${field.mapped ? `${(field.missingPct * 100).toFixed(1)}% vacío` : 'No mapeado'}. ${field.impact}`,
      ]) as Array<[string, string]>).concat(
        profile.missingFields.every(field => field.severity === 'low')
          ? [['Estado', 'No hay campos críticos faltantes relevantes.']]
          : [],
      ),
      '#be123c',
    );
    appendPdfSection(overview, 'Siguientes acciones',
      (profile.nextActions.length ? profile.nextActions : ['Sin acciones críticas pendientes.'])
        .map((action, index) => [`${index + 1}`, action]),
      '#b45309',
    );

    const local = loanTapePdfPage(`Contexto analítico local — ${tape.name}`, subtitle);
    appendPdfSection(local, 'Lectura ejecutiva', [
      ['Estado / riesgo', `${analysis.overallStatus || 'N/D'} · ${analysis.riskScore ?? 'N/D'}/100`],
      ['Tendencia', analysis.trendDirection || 'N/D'],
      ['Resumen', analysis.executiveSummary || 'Sin resumen local'],
    ]);
    appendPdfSection(local, 'Métricas locales',
      (analysis.metrics || []).slice(0, 8).map(metric => [
        metric.name,
        `${metric.latestValue}${metric.previousValue ? ` · anterior ${metric.previousValue}` : ''}${metric.change ? ` · cambio ${metric.change}` : ''}`,
      ]),
    );
    appendPdfSection(local, 'Hallazgos y recomendaciones',
      (analysis.findings || []).slice(0, 10).map(finding => [
        `${finding.severity} · ${finding.category}`,
        `${finding.title}. ${finding.detail}${finding.recommendation ? ` Recomendación: ${finding.recommendation}` : ''}`,
      ]),
      '#0f766e',
    );

    const analystState = normalizeLoanTapeAnalystState(tape.analystState);
    const analystPages: HTMLDivElement[] = [];
    if (analystState.qa.question || analystState.qa.answer || analystState.qa.draft) {
      const qaPage = loanTapePdfPage(`Q&A guardado — ${tape.name}`, subtitle);
      appendPdfSection(qaPage, 'Consulta del analista', [
        ...(analystState.qa.question ? [['Pregunta', analystState.qa.question] as [string, string]] : []),
        ...(analystState.qa.answer ? [['Respuesta', analystState.qa.answer] as [string, string]] : []),
        ...(analystState.qa.draft && analystState.qa.draft !== analystState.qa.question
          ? [['Borrador', analystState.qa.draft] as [string, string]]
          : []),
      ], '#4338ca');
      analystPages.push(qaPage);
    }

    analystState.workspaceBlocks.forEach((block, blockIndex) => {
      const dataRows = workspaceBlockPdfRows(block);
      const chunks = dataRows.length
        ? Array.from({ length: Math.ceil(dataRows.length / 12) }, (_, index) => dataRows.slice(index * 12, (index + 1) * 12))
        : [[]];
      chunks.forEach((chunk, chunkIndex) => {
        const page = loanTapePdfPage(
          `${block.title}${chunks.length > 1 ? ` — ${chunkIndex + 1}/${chunks.length}` : ''}`,
          subtitle,
        );
        appendPdfSection(page, `Bloque ${blockIndex + 1} · ${block.type}`, [
          ['Prompt', block.prompt],
          ['Descripción', block.description],
          ['Creado', fmtDate(block.createdAt)],
        ], '#4338ca');
        appendPdfSection(page, 'Datos guardados',
          chunk.length ? chunk : [['Estado', 'El bloque no contiene filas.']],
          '#0f766e',
        );
        analystPages.push(page);
      });
    });

    return [overview, local, ...analystPages];
  });
}

// 9. BLANK TEMPLATE SHELLS (GR, CF, Fondeo, Cartera)
export function buildBlankShells(): SheetDef[] {
  return [
    {
      name: 'GR',
      rows: [['ESTADOS FINANCIEROS ANUALES — Plantilla'], [], ['Completar manualmente con datos anuales auditados.']],
      colWidths: [40],
    },
    {
      name: 'CF',
      rows: [['FLUJO DE EFECTIVO — Plantilla'], [], ['Completar manualmente.']],
      colWidths: [40],
    },
    {
      name: 'Fondeo',
      rows: [['ESTRUCTURA DE FONDEO — Plantilla'], [], ['Completar manualmente con líneas de crédito vigentes.']],
      colWidths: [40],
    },
    {
      name: 'Cartera',
      rows: [['PROYECCIONES DE CARTERA — Plantilla'], [], ['Completar manualmente con datos de cartera.']],
      colWidths: [40],
    },
  ];
}

// ── Panel export entry points ─────────────────────────────────────────────────

export async function exportResumen(
  client: Client, transactions: Transaction[], covenants: Covenant_DB[], format: 'excel' | 'pdf', el?: HTMLElement,
): Promise<void> {
  if (format === 'excel') {
    await exportToExcel([buildFichaContractual(client, transactions, covenants)], `Ficha_${client.name}`);
  } else {
    if (el) await exportToPdf([el], `Ficha_${client.name}`);
  }
}

export async function exportTransacciones(
  transactions: Transaction[], clientName: string, format: 'excel' | 'pdf', el?: HTMLElement,
): Promise<void> {
  if (format === 'excel') {
    await exportToExcel([buildTransacciones(transactions)], `Transacciones_${clientName}`);
  } else {
    if (el) await exportToPdf([el], `Transacciones_${clientName}`);
  }
}

export async function exportEstadosFinancieros(
  statements: FinancialStatement_DB[], clientName: string, format: 'excel' | 'pdf', el?: HTMLElement, covenants: Covenant_DB[] = [], verticalBases: VerticalBaseConfig = {}, concepts: DefinedConcept[] = [],
): Promise<void> {
  if (format === 'excel') {
    await exportToExcel([
      buildEFFDashboard(statements, clientName),
      buildBG(statements, verticalBases, concepts, covenants),
      buildER(statements, verticalBases, concepts),
      buildDefinedConcepts(statements, concepts),
      buildCovenantDataSheet(statements, concepts),
      buildMonitoreo(covenants, statements, concepts),
      buildCovenantsCalculados(covenants, statements, concepts),
      buildVariacion(statements, clientName),
      ...buildBlankShells(),
    ], `EFF_${clientName}`);
  } else {
    if (el) await exportToPdf([el], `EFF_${clientName}`);
  }
}

export async function exportLoanTape(
  tapes: LoanTape_DB[], clientName: string, format: 'excel' | 'pdf', _el?: HTMLElement,
): Promise<void> {
  if (format === 'excel') {
    await exportToExcel(buildLoanTapeSheets(tapes), `LoanTape_${clientName}`);
  } else {
    const pages = buildLoanTapePdfPages(tapes, clientName);
    pages.forEach(page => {
      page.style.position = 'fixed';
      page.style.left = '0';
      page.style.top = '0';
      page.style.zIndex = '-1';
      page.style.pointerEvents = 'none';
      document.body.appendChild(page);
    });
    try {
      await exportToPdf(pages, `LoanTape_${clientName}`);
    } finally {
      pages.forEach(page => page.remove());
    }
  }
}

export async function exportCovenantsFinancieros(
  covenants: Covenant_DB[], statements: FinancialStatement_DB[], clientName: string, format: 'excel' | 'pdf', el?: HTMLElement, contractCovenantKeys: string[] = [], transactions: Transaction[] = [],
): Promise<void> {
  if (format === 'excel') {
    let concepts: DefinedConcept[] = [];
    const clientId = statements[0]?.clientId || covenants[0]?.clientId || '';
    try { concepts = JSON.parse(localStorage.getItem(`finmonitor_defined_concepts_${clientId}`) || '[]'); } catch {}
    const transactionNames = Object.fromEntries(transactions.map(tx => [tx.id, tx.name || tx.creditType || 'Facility sin nombre']));
    await exportToExcel([
      buildCovenantTrendAnalysis(covenants, statements, clientName, contractCovenantKeys, transactionNames),
      buildCovenantDataSheet(statements, concepts),
      buildMonitoreo(covenants, statements, concepts, transactionNames),
      buildCovenantsCalculados(covenants, statements, concepts, transactionNames),
    ], `Monitoreo_${clientName}`);
  } else {
    if (el) await exportToPdf([el], `Monitoreo_${clientName}`);
  }
}

export async function exportHacerNoHacer(
  covenants: Covenant_DB[], clientName: string, format: 'excel' | 'pdf', el?: HTMLElement,
): Promise<void> {
  if (format === 'excel') {
    await exportHacerNoHacerExcel(covenants, clientName);
  } else {
    if (el) await exportToPdf([el], `Obligaciones_${clientName}`);
  }
}
