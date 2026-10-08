import assert from 'node:assert/strict';
import test from 'node:test';
import { assessStatementQuality, assessLoanTapeImport, usableStatements, isQuarantined } from '../src/lib/statementQuality';
import { computeStatementReconciliation } from '../src/lib/export';

const line = (name: string, value: number, path: string, type = 'balance_general') => ({ name, value, statementType: type, sectionPath: path });
const stmt = (period: string, periodDate: string, scale = 1, extra: any[] = []): any => {
  const items = [
    line('EFECTIVO', 1_000 * scale, 'Balance General > ACTIVO'), line('CARTERA', 9_000 * scale, 'Balance General > ACTIVO'), line('TOTAL ACTIVO', 10_000 * scale, 'Balance General > ACTIVO'),
    line('PROVEEDORES', 2_000 * scale, 'Balance General > PASIVO'), line('TOTAL PASIVO', 2_000 * scale, 'Balance General > PASIVO'),
    line('CAPITAL SOCIAL', 8_000 * scale, 'Balance General > CAPITAL'), line('TOTAL CAPITAL', 8_000 * scale, 'Balance General > CAPITAL'),
    line('INGRESOS', 1_200 * scale, 'Estado de Resultados', 'estado_resultados'), line('RESULTADO NETO', 300 * scale, 'Estado de Resultados', 'estado_resultados'),
    ...extra,
  ];
  return { id: period, clientId: 'c', period, periodDate, fileName: 'x', rawLineItems: items, extraAccounts: [], mappedData: { revenue: 1_200 * scale, cogs: 0, operatingExpenses: 0, ebitda: 0, interestExpense: 0, netIncome: 300 * scale, currentAssets: 0, currentLiabilities: 0, totalDebt: 0, totalAssets: 10_000 * scale, equity: 8_000 * scale } };
};
const assess = (s: any, history: any[]) => assessStatementQuality(s, history, computeStatementReconciliation(s));

test('a clean, balanced statement passes the quality gate with high confidence', () => {
  const q = assess(stmt('mar 25', '2025-03-31'), [stmt('feb 25', '2025-02-28')]);
  assert.equal(q.blocking, false);
  assert.ok(q.score >= 85);
});

test('scale error (thousands vs pesos) is blocked against the previous period', () => {
  const q = assess(stmt('mar 25', '2025-03-31', 1000), [stmt('feb 25', '2025-02-28')]);
  assert.equal(q.blocking, true);
  assert.ok(q.checks.some(c => c.id === 'escala' && c.severity === 'block'));
});

test('an unbalanced balance sheet is blocked and negative total assets too', () => {
  const unbalanced = stmt('mar 25', '2025-03-31');
  unbalanced.rawLineItems = unbalanced.rawLineItems.map((i: any) => (i.name === 'TOTAL CAPITAL' || i.name === 'CAPITAL SOCIAL' ? { ...i, value: 5_000 } : i));
  unbalanced.mappedData.equity = 5_000;
  assert.equal(assess(unbalanced, []).blocking, true);
  const negative = stmt('mar 25', '2025-03-31', -1);
  assert.ok(assess(negative, []).checks.some(c => c.id === 'signos' && c.severity === 'block'));
});

test('an income-statement-only document is not blocked for lacking a balance sheet', () => {
  const only = stmt('dic 21', '2021-12-31');
  only.rawLineItems = only.rawLineItems.filter((i: any) => i.statementType === 'estado_resultados');
  only.mappedData.totalAssets = 0; only.mappedData.equity = 0;
  assert.equal(assess(only, []).blocking, false);
});

test('statements kept in review are excluded from analysis until approved', () => {
  const list = [{ id: 'a' }, { id: 'b' }];
  const records: any = { b: { status: 'en_revision' } };
  assert.deepEqual(usableStatements(list, records).map(s => s.id), ['a']);
  assert.equal(isQuarantined(records.b), true);
  assert.equal(usableStatements(list, { b: { status: 'aprobado' } } as any).length, 2);
});

test('loan tape import confidence drops with low-confidence mappings and missing critical fields', () => {
  const good = assessLoanTapeImport({ mappingReport: [{ confidence: 'high' }, { confidence: 'high' }, { confidence: 'medium' }], readinessScore: 90, rows: 100, missingCritical: [], blocker: false, extractionMs: 1200 });
  const bad = assessLoanTapeImport({ mappingReport: [{ confidence: 'low' }, { confidence: 'low' }], readinessScore: 40, rows: 100, missingCritical: ['days_overdue'], blocker: true });
  assert.ok(good.score > 80 && good.level === 'alta');
  assert.ok(bad.score < 40 && bad.level === 'baja');
});
