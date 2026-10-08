import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEconomicGroups } from '../src/lib/economicGroups';
import { buildMigrationMatrix } from '../src/lib/loanTapeMigration';
import type { StandardLoan } from '../src/lib/loanTapeAnalytics';

const loan = (id: string, client: string, balance: number, dpd: number | null): StandardLoan => ({
  loan_id: id, client, amount: balance * 2, outstanding_balance: balance, interest_rate: 0.2, loan_status: null, start_date: '2025-01-01', end_date: null, loan_type: 'x', days_overdue: dpd, currency: 'MXN', industry: null, state: null, file_date: '2026-05-31',
});

test('same entity written two ways is one group; unrelated "de San Luis" companies are NOT merged', () => {
  const rows = [
    loan('1', 'MAQUINAS FER S.A. DE C.V.', 500, 0), loan('2', 'MAQUINAS FER SA DE CV', 300, 0),
    loan('3', 'EUROGAS DE SAN LUIS S.A. DE C.V.', 200, 0), loan('4', 'TURISTICA DINAMICA DE SAN LUIS S.A. DE C.V.', 200, 0), loan('5', 'AEROGAS DE SAN LUIS S.A. DE C.V.', 200, 0),
    loan('6', 'PATRICIA TREVIÑO DELGADO', 100, 0), loan('7', 'TREVIÑO DELGADO PATRICIA', 100, 0),
  ];
  const groups = buildEconomicGroups(rows);
  const multi = groups.filter(g => g.inferred).map(g => g.members.map(m => m.name).sort());
  assert.equal(multi.length, 2);
  assert.ok(multi.some(m => m.includes('MAQUINAS FER S.A. DE C.V.') && m.includes('MAQUINAS FER SA DE CV')));
  assert.ok(multi.some(m => m.includes('PATRICIA TREVIÑO DELGADO')));
  assert.equal(groups.find(g => g.members.some(m => m.name.startsWith('TURISTICA')))!.members.length, 1);
  assert.ok(Math.abs(groups.reduce((a, g) => a + g.pct, 0) - 1) < 1e-9);
});

test('a manual override separates a member from an inferred group', () => {
  const rows = [loan('1', 'MAQUINAS FER S.A. DE C.V.', 500, 0), loan('2', 'MAQUINAS FER SA DE CV', 300, 0)];
  const split = buildEconomicGroups(rows, { 'MAQUINAS FER SA DE CV': '' });
  assert.equal(split.length, 2);
});

test('migration matrix: roll-in, cure, exits and new loans reconcile', () => {
  const prev = [loan('a', 'A', 100, 0), loan('b', 'B', 100, 0), loan('c', 'C', 100, 15), loan('d', 'D', 100, 45), loan('e', 'E', 100, 0)];
  const cur = [loan('a', 'A', 100, 0), loan('b', 'B', 100, 20), loan('c', 'C', 100, 0), loan('d', 'D', 100, 75), loan('n', 'N', 50, 0)]; // e salió, n nuevo
  const m = buildMigrationMatrix(prev, cur, 'abr', 'may')!;
  assert.equal(m.summary.matched, 4);
  assert.equal(m.summary.exitBalance, 100);
  assert.equal(m.summary.newBalance, 50);
  assert.ok(Math.abs((m.summary.performingToDelinquentPct as number) - 100 / 200) < 1e-9); // b rodó de 0 a 1-30, sobre los al corriente que siguen (a, b); e salió y no cuenta
  assert.ok(Math.abs((m.summary.delinquentCurePct as number) - 100 / 200) < 1e-9);       // c curó
  const totalPrev = m.rowTotals.slice(0, -1).reduce((a, r) => a + r.balance, 0);
  assert.equal(totalPrev, 500);
});
