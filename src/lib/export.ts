// FinMonitor Export Utility — v2
// Excel: ExcelJS | PDF/PNG: html2canvas + jsPDF

import ExcelJS from 'exceljs';
import html2canvas from 'html2canvas';
import jsPDF from 'jspdf';
import {
  Client, Transaction, Covenant_DB, FinancialStatement_DB, LoanTape_DB,
} from '../db/index';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SheetDef {
  name: string;
  rows: (string | number | null | undefined)[][];
  colWidths?: number[];
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function todayStamp(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
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
  return new Date(p.periodDate).toLocaleDateString('es-MX', { month: 'short', year: '2-digit' });
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
    body { margin: 0 !important; padding: 0 !important; background: #ffffff !important; }
    .export-page, .export-page * { font-family: Arial, Helvetica, sans-serif !important; }
    table td, table th { vertical-align: middle !important; line-height: 1.2 !important; }
    .shadow-2xl, .shadow-sm, .shadow-lg, .shadow-xl, .shadow-md { box-shadow: none !important; }
  `;
  clonedDoc.head.appendChild(style);
}

function canvasOpts(el: HTMLElement) {
  return {
    scale: 2, useCORS: true, logging: false, backgroundColor: '#ffffff',
    imageTimeout: 0, windowWidth: el.scrollWidth, windowHeight: el.scrollHeight,
    scrollX: 0, scrollY: 0, onclone: applyPdfStyles,
  } as const;
}

export async function exportToPng(el: HTMLElement, filename: string): Promise<void> {
  const canvas = await html2canvas(el, canvasOpts(el));
  downloadDataUrl(canvas.toDataURL('image/png'), `${filename}.png`);
}

async function renderPage(el: HTMLElement, pdf: jsPDF, addPage = false): Promise<void> {
  const PW = 210, PH = 297;
  const canvas = await html2canvas(el, canvasOpts(el));
  const imgData = canvas.toDataURL('image/jpeg', 0.95);
  const imgH = (canvas.height * PW) / canvas.width;
  if (addPage) pdf.addPage();
  let fW = PW, fH = imgH, x = 0, y = 0;
  if (fH > PH) { fH = PH; fW = PH * (canvas.width / canvas.height); x = (PW - fW) / 2; }
  pdf.addImage(imgData, 'JPEG', x, y, fW, fH);
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
  title:      { bg: '312E81', fg: 'FFFFFF', bold: true,  sz: 12, h: 24 },
  subheading: { bg: '1E293B', fg: 'FFFFFF', bold: true,  sz: 10, h: 20 },
  headers:    { bg: '334155', fg: 'F8FAFC', bold: true,  sz: 9,  h: 17 },
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

  for (const sheet of sheets) {
    const ws = wb.addWorksheet(sheet.name.slice(0, 31));
    const maxCols = Math.max(1, ...sheet.rows.map(r => r.length));
    const nCols = Math.max(maxCols, sheet.colWidths?.length ?? 0);

    ws.columns = Array.from({ length: nCols }, (_, i) => ({
      width: sheet.colWidths?.[i] ?? (i === 0 ? 34 : 14),
    }));

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

      const exRow = ws.addRow(raw.map(c => c ?? ''));
      exRow.height = h;

      exRow.eachCell({ includeEmpty: true }, (cell, col) => {
        if (col > nCols) return;
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + bg } };
        cell.font = { name: 'Arial', size: sz, bold, color: { argb: 'FF' + fg } };
        const isNum = typeof cell.value === 'number';
        cell.alignment = {
          vertical: 'middle',
          horizontal: (kind === 'title' || kind === 'subheading' || !isNum) ? 'left' : 'right',
        };
        if (isNum && kind === 'data') {
          const lbl = (headerLabels[col - 1] ?? '').toUpperCase();
          const isPct = lbl.includes('%') || lbl.includes('VAR') || lbl.includes('VERT');
          cell.numFmt = isPct ? '0.0%' : '#,##0.00';
        }
        if (kind === 'headers') {
          cell.border = { bottom: { style: 'thin', color: { argb: 'FF6366F1' } } };
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
      ws.views = [{ state: 'frozen', ySplit: firstHeaderRow, xSplit: 0 }];
    }
  }

  const buf = await wb.xlsx.writeBuffer();
  downloadBlob(
    new Blob([buf as ArrayBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    `${todayStamp()} - ${filename}.xlsx`,
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
    ['Línea Total', client.totalCreditValue],
    ['Tipo de Crédito', (client.creditType || []).join(', ')],
    ['Nombre del Contrato', client.contractName || ''],
    ['Analista', client.analystName || ''],
    ['Frecuencia de Reporte', client.frequency || ''],
    [],
    ['B. TRANSACCIONES'],
    ['Nombre', 'Tipo', 'Monto', 'Moneda', 'Fecha Firma', 'Vencimiento'],
    ...transactions.map(t => [t.name, t.creditType, t.originalAmount, t.currency, fmtDate(t.signedAt), fmtDate(t.maturityAt)]),
    [],
    ['C. COVENANTS FINANCIEROS'],
    ['Covenant', 'Fórmula', 'Operador', 'Umbral'],
    ...financial.map(c => [c.name, c.formula, c.operator, c.threshold]),
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

// 2. BG — Monthly Balance Sheet time-series
export function buildBG(statements: FinancialStatement_DB[]): SheetDef {
  const sorted = [...statements].sort((a, b) => a.periodDate.localeCompare(b.periodDate));
  const n = sorted.length;

  // Collect all balance sheet account names
  const accountSet = new Set<string>();
  for (const s of sorted) {
    for (const li of s.rawLineItems || []) {
      if (!li.statementType || li.statementType === 'balance_general') accountSet.add(li.name);
    }
  }
  const accounts = Array.from(accountSet);

  // Header rows (template-style)
  const counterRow: SheetDef['rows'][0] = ['CUENTA', 'MX$\'000',
    ...sorted.map((_, i) => i - n + 1)]; // counter: -(n-1) … 0
  const yearRow: SheetDef['rows'][0] = ['Año', '',
    ...sorted.map(periodYear)];
  const monthRow: SheetDef['rows'][0] = ['Mes', '',
    ...sorted.map(monthLabel)];
  const monthNumRow: SheetDef['rows'][0] = ['# Mes', '',
    ...sorted.map(periodMonth)];

  const dataRows: SheetDef['rows'] = accounts.map(acc => [
    acc, '',
    ...sorted.map(s => {
      const li = (s.rawLineItems || []).find(l => l.name === acc &&
        (!l.statementType || l.statementType === 'balance_general'));
      return li ? li.value : null;
    }),
  ]);

  // Mapped totals section
  const blank: SheetDef['rows'][0] = [''];
  const ratioRows: SheetDef['rows'] = [
    ['TOTALES MAPEADOS', ''],
    ['Activo Total', '', ...sorted.map(s => s.mappedData.totalAssets || null)],
    ['Pasivo Total', '', ...sorted.map(s => (s.mappedData.totalAssets - s.mappedData.equity) || null)],
    ['Capital Total', '', ...sorted.map(s => s.mappedData.equity || null)],
    ['Cartera Total (Deuda)', '', ...sorted.map(s => s.mappedData.totalDebt || null)],
    ['Activo Circulante', '', ...sorted.map(s => s.mappedData.currentAssets || null)],
    ['Pasivo Circulante', '', ...sorted.map(s => s.mappedData.currentLiabilities || null)],
  ];

  return {
    name: 'BG',
    rows: [counterRow, yearRow, monthRow, monthNumRow, blank, ...dataRows, blank, ...ratioRows],
    colWidths: [38, 12, ...Array(n).fill(14)],
  };
}

// 3. ER — Monthly Income Statement time-series
export function buildER(statements: FinancialStatement_DB[]): SheetDef {
  const sorted = [...statements].sort((a, b) => a.periodDate.localeCompare(b.periodDate));
  const n = sorted.length;

  const accountSet = new Set<string>();
  for (const s of sorted) {
    for (const li of s.rawLineItems || []) {
      if (li.statementType === 'estado_resultados') accountSet.add(li.name);
    }
  }
  const accounts = Array.from(accountSet);

  const counterRow: SheetDef['rows'][0] = ['CUENTA', 'MX$\'000', ...sorted.map((_, i) => i - n + 1)];
  const yearRow: SheetDef['rows'][0] = ['Año', '', ...sorted.map(periodYear)];
  const monthRow: SheetDef['rows'][0] = ['Mes', '', ...sorted.map(monthLabel)];
  const monthNumRow: SheetDef['rows'][0] = ['# Mes', '', ...sorted.map(periodMonth)];

  const dataRows: SheetDef['rows'] = accounts.length > 0
    ? accounts.map(acc => [
        acc, '',
        ...sorted.map(s => {
          const li = (s.rawLineItems || []).find(l => l.name === acc && l.statementType === 'estado_resultados');
          return li ? li.value : null;
        }),
      ])
    : [
        // fallback to mapped data if no ER line items tagged
        ['Ingresos por Intereses', '', ...sorted.map(s => s.mappedData.revenue || null)],
        ['Gastos por Intereses', '', ...sorted.map(s => s.mappedData.interestExpense || null)],
        ['EBITDA', '', ...sorted.map(s => s.mappedData.ebitda || null)],
        ['Resultado Neto', '', ...sorted.map(s => s.mappedData.netIncome || null)],
      ];

  return {
    name: 'ER',
    rows: [counterRow, yearRow, monthRow, monthNumRow, [''], ...dataRows],
    colWidths: [38, 12, ...Array(n).fill(14)],
  };
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
): SheetDef {
  const financial = covenants.filter(c => c.type === 'financial');
  const sorted = [...statements].sort((a, b) => a.periodDate.localeCompare(b.periodDate));

  if (financial.length === 0 || sorted.length === 0) {
    return { name: 'Monitoreo', rows: [['Sin covenants financieros definidos']] };
  }

  const periods = sorted.map(monthLabel);
  const rows: SheetDef['rows'] = [
    ['MONITOREO DE COVENANTS — ' + new Date().getFullYear()],
    [],
    ['COVENANT', 'FÓRMULA', 'OPERADOR', 'UMBRAL', ...periods],
    [],
  ];

  for (const cov of financial) {
    const values = sorted.map(s => evaluateCovValue(cov, s));
    rows.push([cov.name, cov.formula, cov.operator, cov.threshold ? parseFloat(cov.threshold) : null, ...values]);
    rows.push(['', '', '', 'UMBRAL', ...periods.map(() => cov.threshold ? parseFloat(cov.threshold) : null)]);
    rows.push([]); // spacer
  }

  return {
    name: 'Monitoreo',
    rows,
    colWidths: [30, 18, 10, 10, ...Array(sorted.length).fill(14)],
  };
}

function evaluateCovValue(cov: Covenant_DB, s: FinancialStatement_DB): number | null {
  const m = s.mappedData;
  const formula = cov.formula.toLowerCase();
  if (formula.includes('deuda') && formula.includes('ebitda')) return m.ebitda ? m.totalDebt / m.ebitda : null;
  if (formula.includes('dscr') || (formula.includes('ebitda') && formula.includes('interes'))) return m.interestExpense ? m.ebitda / m.interestExpense : null;
  if (formula.includes('corriente') || formula.includes('liquidez')) return m.currentLiabilities ? m.currentAssets / m.currentLiabilities : null;
  if (formula.includes('capital') || formula.includes('equity')) return m.totalAssets ? (m.equity / m.totalAssets) * 100 : null;
  if (formula.includes('capitalización') || formula.includes('capitalizacion')) return m.totalAssets ? m.equity / m.totalAssets : null;
  if (formula.includes('vencida')) return m.totalDebt && m.currentLiabilities ? m.currentLiabilities / m.totalDebt : null;
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
      t.name, t.creditType, t.originalAmount, t.currency,
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
export function buildLoanTape(tapes: LoanTape_DB[]): SheetDef {
  const rows: SheetDef['rows'] = [
    ['LOAN TAPES'],
    [],
    ['Nombre', 'Tipo', 'Fecha Carga', 'Archivo'],
    ...tapes.map(t => [t.name, t.tapeType, fmtDate(t.uploadDate), t.fileName || '']),
  ];

  // If the last tape has extractedData, try to append it
  const last = tapes[tapes.length - 1];
  if (last?.extractedData) {
    const data = last.extractedData;
    if (Array.isArray(data) && data.length > 0) {
      rows.push([]);
      rows.push(['DATOS EXTRAÍDOS — ' + last.name]);
      const keys = Object.keys(data[0]);
      rows.push(keys);
      for (const row of data) rows.push(keys.map(k => row[k] ?? null));
    }
  }

  return {
    name: 'Loan Tape',
    rows,
    colWidths: [30, 16, 14, 40],
  };
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
  statements: FinancialStatement_DB[], clientName: string, format: 'excel' | 'pdf', el?: HTMLElement,
): Promise<void> {
  if (format === 'excel') {
    await exportToExcel([
      buildBG(statements),
      buildER(statements),
      buildVariacion(statements, clientName),
      ...buildBlankShells(),
    ], `EFF_${clientName}`);
  } else {
    if (el) await exportToPdf([el], `EFF_${clientName}`);
  }
}

export async function exportLoanTape(
  tapes: LoanTape_DB[], clientName: string, format: 'excel' | 'pdf', el?: HTMLElement,
): Promise<void> {
  if (format === 'excel') {
    await exportToExcel([buildLoanTape(tapes)], `LoanTape_${clientName}`);
  } else {
    if (el) await exportToPdf([el], `LoanTape_${clientName}`);
  }
}

export async function exportCovenantsFinancieros(
  covenants: Covenant_DB[], statements: FinancialStatement_DB[], clientName: string, format: 'excel' | 'pdf', el?: HTMLElement,
): Promise<void> {
  if (format === 'excel') {
    await exportToExcel([buildMonitoreo(covenants, statements)], `Monitoreo_${clientName}`);
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
