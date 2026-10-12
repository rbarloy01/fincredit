import assert from 'node:assert/strict';
import test from 'node:test';
import { computeAforo, defaultAforoTerms, parseRequiredRatio, type AforoCut } from '../src/lib/aforo';

const tape = (loan_id: string, outstanding_balance: number, days_overdue: number) =>
  ({ loan_id, client: `Cliente ${loan_id}`, outstanding_balance, days_overdue, file_date: '2026-08-31', loan_status: 'Vigente' }) as any;
const tapeRows = [tape('A1', 100, 0), tape('A2', 200, 45), tape('A3', 300, 120), tape('A4', 400, 0), { ...tape('A5', 999, 0), file_date: '2026-07-31' }];
const baseCut: AforoCut = { id: 'c', transactionId: 't1', cutoff: '2026-08-31', debtBalance: 500, createdAt: '' };

test('aforo requerido se lee como 1.3x, 130% o 1.3', () => {
  assert.equal(parseRequiredRatio('1.3x'), 1.3);
  assert.equal(parseRequiredRatio('130%'), 1.3);
  assert.equal(parseRequiredRatio('1.3'), 1.3);
  assert.equal(parseRequiredRatio(''), null);
});

test('sin cartera cedida: el colateral es el loan tape del corte; mora > 90 no es elegible', () => {
  const r = computeAforo(baseCut, { ...defaultAforoTerms(), requiredRatio: 1.3 }, tapeRows);
  assert.equal(r.mode, 'loan_tape');
  assert.equal(r.totals.loans, 4);                 // A5 es de otro corte
  assert.equal(r.totals.eligible, 700);            // A1 + A2 (45 días ≤ 90) + A4
  assert.equal(r.totals.ineligibleDpd, 300);
  assert.equal(r.ratio, 1.4);
  assert.equal(r.status, 'cumple');
  assert.equal(r.excess, 700 - 650);
});

test('con cartera cedida: se cruza contra el loan tape, que manda en saldo y mora', () => {
  const cut: AforoCut = { ...baseCut, ceded: { fileName: 'cedida.xlsx', rows: [
    { loan_id: 'A1', client: 'Cliente A1', outstanding_balance: 100, days_overdue: 0 },
    { loan_id: 'A3', client: 'Cliente A3', outstanding_balance: 300, days_overdue: 0 },   // reportada al corriente, el tape dice 120 días
    { loan_id: 'A4', client: 'Cliente A4', outstanding_balance: 450, days_overdue: 0 },   // saldo cedido ≠ loan tape
    { loan_id: 'Z9', client: 'Fantasma', outstanding_balance: 1000, days_overdue: 0 },     // no existe en el loan tape
  ] as any } };
  const r = computeAforo(cut, { ...defaultAforoTerms(), requiredRatio: 1.3 }, tapeRows);
  assert.equal(r.mode, 'cedida');
  assert.equal(r.matched, 3);
  assert.equal(r.totals.eligible, 500);            // A1 100 + A4 400 (saldo del tape)
  assert.equal(r.totals.ineligibleDpd, 300);
  assert.equal(r.totals.notInTape, 1000);
  assert.equal(r.totals.balanceDiffs, 1);
  assert.equal(r.ratio, 1);
  assert.equal(r.status, 'incumple');
  assert.equal(r.excess, 500 - 650);
});
