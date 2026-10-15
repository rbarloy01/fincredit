// Aforo: colateral elegible ÷ saldo de la deuda, contra el mínimo del contrato.
//
// Fuentes, en orden: 1) reporte de cartera CEDIDA (si el cliente lo entrega); 2) se cruza crédito por crédito contra el
// LOAN TAPE del mismo corte (por ID; sin ID, por huella — loanIdentity.pairLoans); el loan tape manda en saldo y mora;
// 3) sin cartera cedida, el colateral es el loan tape completo. Reglas de elegibilidad configurables por facility
// (se irán afinando con el analista). Se guarda por cliente en client_settings (sin migración).

import { db, type Client } from '../db/index';
import type { StandardLoan } from './loanTapeAnalytics';
import { activeRows } from './loanTapeAnalytics';
import { pairLoans } from './loanIdentity';

export const aforoKey = (clientId: string) => `finmonitor_aforo_${clientId}`;

export interface AforoTerms {
  requiredRatio: number | null;     // 1.3 = 130%
  maxDpdEligible: number;           // días de atraso máximos para ser elegible
  excludeNotInTape: boolean;        // crédito cedido que no aparece en el loan tape → no elegible
  balanceTolerancePct: number;      // diferencia de saldo cedido vs. loan tape que se marca
}

export const defaultAforoTerms = (): AforoTerms => ({ requiredRatio: null, maxDpdEligible: 90, excludeNotInTape: true, balanceTolerancePct: 0.01 });

export type CompactLoan = Pick<StandardLoan, 'loan_id' | 'client' | 'outstanding_balance' | 'days_overdue' | 'amount' | 'start_date' | 'end_date'>;

export interface AforoCut {
  id: string;
  transactionId: string;            // '' = general del cliente
  cutoff: string;                   // YYYY-MM-DD
  debtBalance: number;
  ceded?: { fileName: string; rows: CompactLoan[] };
  notes?: string;
  createdAt: string;
  createdBy?: string;
  snapshot?: { ratio: number | null; eligible: number; required: number | null; status: AforoStatus };
}

export interface AforoStore { terms: Record<string, AforoTerms>; cuts: AforoCut[] }

export type LoanAforoStatus = 'elegible' | 'no_elegible_mora' | 'no_en_loan_tape' | 'sin_saldo';
export type AforoStatus = 'cumple' | 'incumple' | 'sin_requerido' | 'sin_deuda';

export interface AforoLoanRow {
  loanId: string;
  client: string;
  cededBalance: number | null;
  tapeBalance: number | null;
  collateral: number;               // saldo que cuenta como colateral (loan tape si se encontró, si no el cedido)
  dpd: number | null;
  status: LoanAforoStatus;
  balanceDiff: number | null;       // cedido − loan tape
  flagBalance: boolean;
}

export interface AforoResult {
  mode: 'cedida' | 'loan_tape';
  rows: AforoLoanRow[];
  totals: { loans: number; collateral: number; eligible: number; ineligibleDpd: number; notInTape: number; balanceDiffs: number };
  matched: number;
  matchedByFingerprint: number;
  ratio: number | null;
  required: number | null;
  requiredCollateral: number | null;
  excess: number | null;            // + exceso / − faltante de colateral elegible
  status: AforoStatus;
  tapeAvailable: boolean;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// "1.3", "1.3x", "130%", "130" → 1.3
export function parseRequiredRatio(input: string): number | null {
  const raw = String(input || '').trim().replace(/x$/i, '').replace(',', '.');
  if (!raw) return null;
  const pct = raw.endsWith('%');
  const n = Number(raw.replace('%', ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  return pct || n > 10 ? n / 100 : n;
}

export function computeAforo(cut: AforoCut, terms: AforoTerms, tapeRowsAll: StandardLoan[]): AforoResult {
  const tapeRows = activeRows(tapeRowsAll).filter(r => !cut.cutoff || r.file_date === cut.cutoff);
  const tapeAvailable = tapeRows.length > 0;
  const rows: AforoLoanRow[] = [];
  let matched = 0, matchedByFingerprint = 0;

  const statusFor = (dpd: number | null, inTape: boolean, balance: number): LoanAforoStatus => {
    if (balance <= 0) return 'sin_saldo';
    if (!inTape && terms.excludeNotInTape && tapeAvailable) return 'no_en_loan_tape';
    if (dpd !== null && dpd > terms.maxDpdEligible) return 'no_elegible_mora';
    return 'elegible';
  };

  if (cut.ceded?.rows.length) {
    const ceded = cut.ceded.rows as StandardLoan[];
    const pairing = pairLoans(ceded, tapeRows);
    matched = pairing.pairs.size; matchedByFingerprint = pairing.byFingerprint;
    ceded.forEach(c => {
      const t = pairing.pairs.get(c);
      const cededBalance = num(c.outstanding_balance);
      const tapeBalance = t ? num(t.outstanding_balance) : null;
      const collateral = Math.max(0, tapeBalance ?? cededBalance ?? 0);
      const dpd = t ? num(t.days_overdue) : num(c.days_overdue);
      const diff = cededBalance !== null && tapeBalance !== null ? cededBalance - tapeBalance : null;
      rows.push({
        loanId: String(c.loan_id ?? t?.loan_id ?? '—'), client: String(c.client ?? t?.client ?? ''),
        cededBalance, tapeBalance, collateral, dpd, balanceDiff: diff,
        flagBalance: diff !== null && Math.abs(diff) > Math.max(1, Math.abs(tapeBalance || 0) * terms.balanceTolerancePct),
        status: statusFor(dpd, !!t, collateral),
      });
    });
  } else {
    tapeRows.forEach(t => {
      const collateral = Math.max(0, num(t.outstanding_balance) ?? 0);
      rows.push({
        loanId: String(t.loan_id ?? '—'), client: String(t.client ?? ''), cededBalance: null, tapeBalance: num(t.outstanding_balance),
        collateral, dpd: num(t.days_overdue), balanceDiff: null, flagBalance: false, status: statusFor(num(t.days_overdue), true, collateral),
      });
    });
  }

  const sumBy = (pred: (r: AforoLoanRow) => boolean) => rows.filter(pred).reduce((a, r) => a + r.collateral, 0);
  const eligible = sumBy(r => r.status === 'elegible');
  const totals = {
    loans: rows.length,
    collateral: sumBy(() => true),
    eligible,
    ineligibleDpd: sumBy(r => r.status === 'no_elegible_mora'),
    notInTape: sumBy(r => r.status === 'no_en_loan_tape'),
    balanceDiffs: rows.filter(r => r.flagBalance).length,
  };
  const debt = cut.debtBalance;
  const ratio = debt > 0 ? eligible / debt : null;
  const required = terms.requiredRatio;
  const requiredCollateral = required !== null && debt > 0 ? required * debt : null;
  const excess = requiredCollateral !== null ? eligible - requiredCollateral : null;
  const status: AforoStatus = debt <= 0 ? 'sin_deuda' : required === null ? 'sin_requerido' : (ratio as number) + 1e-9 >= required ? 'cumple' : 'incumple';
  return { mode: cut.ceded?.rows.length ? 'cedida' : 'loan_tape', rows, totals, matched, matchedByFingerprint, ratio, required, requiredCollateral, excess, status, tapeAvailable };
}

export const compactLoans = (rows: StandardLoan[]): CompactLoan[] =>
  rows.map(r => ({ loan_id: r.loan_id, client: r.client, outstanding_balance: r.outstanding_balance, days_overdue: r.days_overdue, amount: r.amount, start_date: r.start_date, end_date: r.end_date }));

export async function loadAforo(clientId: string): Promise<AforoStore> {
  const s = await db.getClientSetting<AforoStore>(clientId, aforoKey(clientId), { terms: {}, cuts: [] });
  return { terms: s?.terms || {}, cuts: Array.isArray(s?.cuts) ? s.cuts : [] };
}

export async function saveAforo(clientId: string, store: AforoStore): Promise<void> {
  await db.setClientSetting(clientId, aforoKey(clientId), store);
}

// El histórico de aforo del reporte de monitoreo (client.aforoHistory) se alimenta de los cortes calculados.
export function aforoHistoryEntry(cut: AforoCut, result: AforoResult): Client['aforoHistory'][number] {
  return {
    month: cut.cutoff.slice(0, 7),
    value: result.ratio === null ? 'N/D' : `${(result.ratio * 100).toFixed(2)}%`,
    status: result.status === 'cumple' ? 'good' : result.status === 'incumple' ? 'bad' : 'warning',
    ...(cut.transactionId ? { transactionId: cut.transactionId } : {}),
  };
}

// ── Reporte Excel (mismo estilo Axcess que loan tapes) ───────────────────────────────────────────────────────────────
import type { SheetDef } from './export';
import { F, FMT, SheetBuilder } from './loanTapeReport';
import { AXC } from './xlsxCharts';

const STATUS_LABEL: Record<LoanAforoStatus, string> = { elegible: 'Elegible', no_elegible_mora: 'No elegible (mora)', no_en_loan_tape: 'No está en el loan tape', sin_saldo: 'Sin saldo' };

export function buildAforoSheets(clientName: string, facilityName: string, cut: AforoCut, terms: AforoTerms, r: AforoResult, history: Array<{ cut: AforoCut; result: AforoResult }>): SheetDef[] {
  const sheets: SheetDef[] = [];
  {
    const s = new SheetBuilder('Resumen', [44, 20, 16]);
    s.title(`AFORO — ${clientName.toUpperCase()} · ${facilityName}`);
    s.text(`Corte ${cut.cutoff} · colateral: ${r.mode === 'cedida' ? `cartera cedida (${cut.ceded?.fileName}) cruzada contra el loan tape` : 'loan tape completo (sin reporte de cartera cedida)'}`);
    s.blank();
    const base = s.baseCell('Saldo de la deuda', cut.debtBalance);
    const eligibleRow = s.next + 6;   // subtítulo, encabezado y 5º renglón de datos = colateral elegible
    s.table('CÁLCULO', ['Concepto', 'Valor'], [
      ['Créditos en el colateral', r.totals.loans],
      ['Colateral total', F(r.totals.collateral, FMT.money)],
      ['   No elegible por mora (> ' + terms.maxDpdEligible + ' días)', F(r.totals.ineligibleDpd, FMT.money)],
      ['   No está en el loan tape', F(r.totals.notInTape, FMT.money)],
      ['Colateral elegible', F(r.totals.eligible, FMT.money)],
      ['Aforo = colateral elegible ÷ deuda', { __fmtNum: true, raw: `=IFERROR(B${eligibleRow}/${base},0)`, fmt: '0.00"x"', result: r.ratio ?? 0 } as any],
      ['Aforo requerido', r.required === null ? 'Sin capturar' : F(r.required, '0.00"x"')],
      ['Colateral requerido', r.requiredCollateral === null ? '—' : F(r.requiredCollateral, FMT.money)],
      ['Exceso (+) / faltante (−)', r.excess === null ? '—' : F(r.excess, FMT.money)],
      ['Estatus', r.status === 'cumple' ? 'CUMPLE' : r.status === 'incumple' ? 'INCUMPLE' : r.status === 'sin_requerido' ? 'Falta capturar el aforo requerido' : 'Falta el saldo de la deuda'],
      ['Créditos cruzados con el loan tape', r.mode === 'cedida' ? `${r.matched} de ${r.totals.loans}${r.matchedByFingerprint ? ` (${r.matchedByFingerprint} por huella)` : ''}` : '—'],
      ['Diferencias de saldo cedido vs. loan tape', r.totals.balanceDiffs],
    ], []);
    sheets.push(s.done());
  }
  {
    const s = new SheetBuilder('Créditos', [18, 34, 16, 16, 16, 10, 22, 16], AXC.cyan);
    s.title(`CRÉDITOS DEL COLATERAL — corte ${cut.cutoff}`);
    s.blank();
    s.table('DETALLE', ['Crédito', 'Cliente', 'Saldo cedido', 'Saldo loan tape', 'Colateral', 'Días atraso', 'Estatus', 'Dif. saldo'],
      r.rows.map(x => [x.loanId, x.client, x.cededBalance, x.tapeBalance, x.collateral, x.dpd, STATUS_LABEL[x.status], x.balanceDiff]),
      [undefined, undefined, 'money', 'money', 'money', 'int', undefined, 'money'],
      ['TOTAL', '', r.rows.reduce((a, x) => a + (x.cededBalance || 0), 0), r.rows.reduce((a, x) => a + (x.tapeBalance || 0), 0), r.totals.collateral, null, '', null], { sum: [2, 3, 4] });
    sheets.push(s.done({ freezeRows: 4 }));
  }
  {
    const issues = r.rows.filter(x => x.status !== 'elegible' || x.flagBalance);
    const s = new SheetBuilder('Discrepancias', [18, 34, 16, 16, 10, 26], AXC.red);
    s.title('DISCREPANCIAS Y NO ELEGIBLES');
    s.blank();
    s.table('CRÉDITOS A REVISAR', ['Crédito', 'Cliente', 'Saldo cedido', 'Saldo loan tape', 'Días atraso', 'Motivo'],
      issues.length ? issues.map(x => [x.loanId, x.client, x.cededBalance, x.tapeBalance, x.dpd, x.status !== 'elegible' ? STATUS_LABEL[x.status] : 'Saldo cedido ≠ loan tape']) : [['—', 'Sin discrepancias', null, null, null, '']],
      [undefined, undefined, 'money', 'money', 'int']);
    sheets.push(s.done());
  }
  if (history.length) {
    const s = new SheetBuilder('Histórico', [14, 18, 18, 12, 12, 14], AXC.green);
    s.title('HISTÓRICO DE AFORO');
    s.blank();
    const t = s.table('POR CORTE', ['Corte', 'Deuda', 'Colateral elegible', 'Aforo', 'Requerido', 'Estatus'],
      history.map(h => [h.cut.cutoff, h.cut.debtBalance, h.result.totals.eligible, h.result.ratio, h.result.required, h.result.status]),
      [undefined, 'money', 'money', 'dec2', 'dec2'], undefined, { ratio: [[3, 2, 1]] });
    s.chart(t, { title: 'Aforo vs. requerido', kind: 'line', series: [{ col: 3, color: AXC.deep, labels: true, fmt: '0.00"x"' }, { col: 4, color: AXC.red }], yFmt: '0.00"x"' });
    sheets.push(s.done());
  }
  return sheets;
}
