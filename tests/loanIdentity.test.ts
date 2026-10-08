import assert from 'node:assert/strict';
import test from 'node:test';
import { inferLoanIds, INFERRED_ID_PREFIX, idBasis } from '../src/lib/loanIdentity';
import { buildMigrationMatrix } from '../src/lib/loanTapeMigration';
import type { StandardLoan } from '../src/lib/loanTapeAnalytics';

const loan = (o: Partial<StandardLoan>): StandardLoan => ({
  loan_id: null, client: null, amount: null, outstanding_balance: 0, interest_rate: null, loan_status: null, start_date: null,
  end_date: null, loan_type: null, days_overdue: 0, currency: 'MXN', industry: null, state: null, file_date: '2026-01-31', ...o,
});

const base = [
  { client: 'ALFA SA DE CV', amount: 1000000, start_date: '2024-01-15', end_date: '2027-01-15' },
  { client: 'BETA SA DE CV', amount: 500000, start_date: '2024-03-01', end_date: '2026-09-01' },
  { client: 'GAMMA SA DE CV', amount: 750000, start_date: '2025-02-10', end_date: '2028-02-10' },
  { client: 'DELTA SA DE CV', amount: 200000, start_date: '2025-06-01', end_date: '2026-12-01' },
  { client: 'EPSILON SA DE CV', amount: 300000, start_date: '2025-07-01', end_date: '2027-07-01' },
];

test('without IDs, the same loan gets the same key in two cuts even when balance and DPD changed', () => {
  const jan = inferLoanIds(base.map((b, i) => loan({ ...b, outstanding_balance: 400000 - i * 10000, days_overdue: 0 })));
  const feb = inferLoanIds(base.slice(0, 4).map((b, i) => loan({ ...b, file_date: '2026-02-28', outstanding_balance: 380000 - i * 10000, days_overdue: i === 1 ? 45 : 0 })));
  assert.equal(jan.report.method, 'inferred');
  assert.equal(jan.report.confidence, 'alta');
  assert.ok(jan.rows.every(r => r.loan_id?.startsWith(INFERRED_ID_PREFIX)));
  const m = buildMigrationMatrix(jan.rows, feb.rows, 'ene', 'feb')!;
  assert.equal(m.summary.matched, 4);          // four paired; EPSILON left
  assert.equal(m.idBasis, 'inferred');
  assert.ok(m.summary.worse > 0);              // BETA went 0 → 45 DPD
});

test('rent (renta) is part of the fingerprint and separates identical contracts', () => {
  const twins = [
    loan({ client: 'ZETA', amount: 100000, start_date: '2025-01-01', installment: 5000 }),
    loan({ client: 'ZETA', amount: 100000, start_date: '2025-01-01', installment: 7000 }),
    loan({ client: 'ETA', amount: 90000, start_date: '2025-02-01', installment: 4000 }),
    loan({ client: 'THETA', amount: 80000, start_date: '2025-03-01', installment: 3000 }),
  ];
  const res = inferLoanIds(twins);
  assert.equal(new Set(res.rows.map(r => r.loan_id)).size, 4);
  assert.equal(res.report.uniquePct, 1);
});

test('exact duplicates get an order suffix and the report does not claim they are unique', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ client: `CLIENTE ${i}`, amount: 100000 + i * 1000, start_date: '2025-01-01', end_date: '2027-01-01' }));
  const res = inferLoanIds([...many, many[0]].map(b => loan(b)));
  assert.equal(new Set(res.rows.map(r => r.loan_id)).size, 13);
  assert.ok(res.report.uniquePct < 1);
  assert.equal(res.report.method, 'inferred');
});

test('too many look-alike loans (<80% unique) → the importer refuses to guess', () => {
  const res = inferLoanIds([...base, base[0], base[1]].map(b => loan(b)));
  assert.equal(res.report.method, 'none');
});

test('not enough stable attributes → no invented IDs', () => {
  const res = inferLoanIds([loan({ client: 'A' }), loan({ client: 'A' }), loan({ client: 'B' }), loan({ client: 'B' })]);
  assert.equal(res.report.method, 'none');
  assert.ok(res.rows.every(r => r.loan_id === null));
});

test('client-level tapes (one row per acreditado) key by borrower', () => {
  const res = inferLoanIds(['A', 'B', 'C', 'D'].map(c => loan({ client: `CLIENTE ${c}`, outstanding_balance: 1000 })));
  assert.equal(res.report.method, 'inferred');
  assert.deepEqual(res.report.fields, ['cliente']);
});

test('tapes that already carry IDs are left untouched', () => {
  const rows = base.map((b, i) => loan({ ...b, loan_id: `L${i}` }));
  const res = inferLoanIds(rows);
  assert.equal(res.report.method, 'reported');
  assert.equal(res.rows, rows);
  assert.equal(idBasis(res.rows), 'reported');
});
