// DPD migration matrix between two loan-tape snapshots (roll rates).
// Rows = bucket the loan was in at the previous cut; columns = where it is now. Loans that disappeared appear in the
// "Salió" column (paid, sold, written off or re-numbered) and loans that are new appear in the "Nuevo" row.

import type { StandardLoan } from './loanTapeAnalytics';
import { DPD_BUCKET_DEFS } from './portfolioRules';
import { pairLoans, isRealLoanId } from './loanIdentity';

export const MIGRATION_STATES = [...DPD_BUCKET_DEFS.map(b => b.label), 'Sin dato'] as const;
export const EXIT_COLUMN = 'Salió';
export const NEW_ROW = 'Nuevo';

export interface MigrationCell { count: number; balance: number }
export interface MigrationMatrix {
  fromLabel: string;
  toLabel: string;
  rows: string[];                      // previous-bucket labels (+ Nuevo)
  columns: string[];                   // current-bucket labels (+ Salió)
  cells: MigrationCell[][];            // [row][col], balance measured at the PREVIOUS cut (current for Nuevo)
  rowTotals: MigrationCell[];
  rollPct: number[][];                 // balance share of each row going to each column (0..1)
  idBasis: 'reported' | 'inferred' | 'mixed' | 'none';   // how loans were paired between the two cuts
  matchedBalancePct: number;                             // share of the previous balance found again in the current cut (paired loans)
  summary: {
    matched: number;
    stable: number; worse: number; better: number;     // by balance (previous cut), among matched loans
    stablePct: number; worsePct: number; betterPct: number;
    performingToDelinquentPct: number | null;           // 0 días → ≥1 día, sobre el saldo al corriente que SIGUE en cartera (excluye salidas)
    delinquentCurePct: number | null;                   // ≥1 día → 0 días
    exitBalance: number; newBalance: number;
  };
}

function stateOf(r: StandardLoan): number {
  const d = r.days_overdue;
  if (d === null || d === undefined || !Number.isFinite(d)) return MIGRATION_STATES.length - 1;
  const idx = DPD_BUCKET_DEFS.findIndex(b => d >= b.min && d <= b.max);
  return idx >= 0 ? idx : MIGRATION_STATES.length - 1;
}

export function buildMigrationMatrix(prev: StandardLoan[], cur: StandardLoan[], fromLabel = 'previo', toLabel = 'actual'): MigrationMatrix | null {
  const prevRows = prev.filter(r => r.loan_id || r.client || r.amount);
  const curRows = cur.filter(r => r.loan_id || r.client || r.amount);
  if (!prevRows.length || !curRows.length) return null;
  const pairing = pairLoans(prevRows, curRows);
  if (pairing.pairs.size === 0 && !prevRows.some(r => r.loan_id) && !curRows.some(r => r.loan_id)) return null;
  const matchedCur = new Set(pairing.pairs.values());

  const n = MIGRATION_STATES.length;
  const rows = [...MIGRATION_STATES, NEW_ROW];
  const columns = [...MIGRATION_STATES, EXIT_COLUMN];
  const cells: MigrationCell[][] = rows.map(() => columns.map(() => ({ count: 0, balance: 0 })));
  const add = (r: number, c: number, balance: number) => { cells[r][c].count += 1; cells[r][c].balance += balance; };

  let stable = 0, worse = 0, better = 0, matched = 0, exitBalance = 0, newBalance = 0, prevTotal = 0;
  for (const p of prevRows) {
    const from = stateOf(p);
    const bal = p.outstanding_balance || 0;
    prevTotal += bal;
    const c = pairing.pairs.get(p);
    if (!c) { add(from, n, bal); exitBalance += bal; continue; }
    const to = stateOf(c);
    add(from, to, bal);
    matched += 1;
    if (to === from) stable += bal; else if (to > from && from < n - 1 && to < n - 1) worse += bal; else if (to < from && from < n - 1 && to < n - 1) better += bal; else stable += bal;
  }
  for (const c of curRows) {
    if (matchedCur.has(c)) continue;
    add(n, stateOf(c), c.outstanding_balance || 0);
    newBalance += c.outstanding_balance || 0;
  }
  const anyInferred = prevRows.some(r => !isRealLoanId(r)) || curRows.some(r => !isRealLoanId(r));
  const basis: MigrationMatrix['idBasis'] = !anyInferred ? 'reported' : pairing.byId === 0 ? 'inferred' : 'mixed';

  const rowTotals = cells.map(row => row.reduce((acc, x) => ({ count: acc.count + x.count, balance: acc.balance + x.balance }), { count: 0, balance: 0 }));
  const rollPct = cells.map((row, i) => row.map(x => (rowTotals[i].balance ? x.balance / rowTotals[i].balance : 0)));
  const moved = stable + worse + better;
  const zeroRow = 0;
  const performing = cells[zeroRow].slice(0, n).reduce((a, x) => a + x.balance, 0);
  const toDelinquent = cells[zeroRow].slice(1, n - 1).reduce((a, x) => a + x.balance, 0);
  const delinquentBal = cells.slice(1, n - 1).reduce((a, row) => a + row.slice(0, n).reduce((x, c) => x + c.balance, 0), 0);
  const cured = cells.slice(1, n - 1).reduce((a, row) => a + row[0].balance, 0);

  return {
    fromLabel, toLabel, rows, columns, cells, rowTotals, rollPct,
    idBasis: basis,
    matchedBalancePct: prevTotal ? (prevTotal - exitBalance) / prevTotal : 0,
    summary: {
      matched, stable, worse, better,
      stablePct: moved ? stable / moved : 0, worsePct: moved ? worse / moved : 0, betterPct: moved ? better / moved : 0,
      performingToDelinquentPct: performing ? toDelinquent / performing : null,
      delinquentCurePct: delinquentBal ? cured / delinquentBal : null,
      exitBalance, newBalance,
    },
  };
}
