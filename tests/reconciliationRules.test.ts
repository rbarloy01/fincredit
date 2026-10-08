import assert from 'node:assert/strict';
import test from 'node:test';
import { computeStatementReconciliation } from '../src/lib/export';
import { classifyAccount } from '../src/lib/accountClassification';

const item = (name: string, value: number, sectionPath: string) => ({ name, value, statementType: 'balance_general', sectionPath });
const stmt = (rawLineItems: any[], mapped: any): any => ({ id: 's', clientId: 'c', period: 'dic 25', periodDate: '2025-12-31', uploadDate: '2025-12-31', fileName: 'x', rawLineItems, extraAccounts: [], mappedData: { revenue: 0, cogs: 0, operatingExpenses: 0, ebitda: 0, interestExpense: 0, netIncome: 0, currentAssets: 0, currentLiabilities: 0, totalDebt: 0, totalAssets: 0, equity: 0, ...mapped } });

test('deepest heading wins: "Pasivo y capital > Capital contable" lines are CAPITAL (Tim Leasing case)', () => {
  const path = 'Balance General > PASIVO Y CAPITAL > CAPITAL CONTABLE';
  assert.equal(classifyAccount('balance_general', 'Resultado neto', path), 'CAPITAL');
  assert.equal(classifyAccount('balance_general', 'Resultado de ejercicios anteriores', path), 'CAPITAL');
  assert.equal(classifyAccount('balance_general', 'Proveedores', 'Balance General > PASIVO Y CAPITAL > PASIVO'), 'PASIVO');
});

test('Pasivo/Capital tie to their totals, and the balance closes, when sub-totals are listed with and without "total"', () => {
  const P = 'Balance General > PASIVO Y CAPITAL > PASIVO';
  const C = 'Balance General > PASIVO Y CAPITAL > CAPITAL CONTABLE';
  const items = [
    item('EFECTIVO', 700, 'Balance General > ACTIVO'), item('BIENES EN ARRENDAMIENTO', 9_300, 'Balance General > ACTIVO'), item('TOTAL ACTIVO', 10_000, 'Balance General > ACTIVO'),
    item('Impuestos por pagar', 500, P), item('Proveedores', 300, P), item('Otros acreedores diversos y otras cuentas por pagar', 800, P), item('Préstamos largo plazo', 200, P), item('TOTAL PASIVO', 1_000, P),
    item('Capital social', 8_000, C), item('CAPITAL CONTRIBUIDO', 8_000, C), item('Resultado de ejercicios anteriores', -100, C), item('Resultado neto', 1_100, C), item('TOTAL CAPITAL CONTABLE', 9_000, C),
    item('TOTAL PASIVO Y CAPITAL CONTABLE', 10_000, 'Balance General > PASIVO Y CAPITAL'),
  ];
  const rec = computeStatementReconciliation(stmt(items, { totalAssets: 10_000, equity: 9_000 }));
  const by = Object.fromEntries(rec.sections.map(s => [s.section, s]));
  assert.equal(by.PASIVO.status, 'ok');
  assert.equal(by.CAPITAL.status, 'ok');
  assert.equal(by.ACTIVO.status, 'ok');
  assert.equal(Math.round(rec.balanceCheck.diferencia ?? 1), 0);
});

test('pasivo grand total is chosen by the accounting identity, never a "Total Pasivo circulante" sub-total (Ideaconv case)', () => {
  const P = 'Balance General > PASIVO > PASIVO CIRCULANTE';
  const items = [
    item('Efectivo', 1_000, 'Balance General > ACTIVO'), item('Cartera', 24_000, 'Balance General > ACTIVO'), item('SUMA EL ACTIVO', 25_000, 'Balance General > ACTIVO'),
    item('Acreedores', 15_000, P), item('Impuestos', 5_000, P), item('Total Pasivo circulante', 20_000, P),
    item('Préstamos corto plazo', 2_000, 'Balance General > PASIVO > PASIVO A CORTO PLAZO'), item('Total Pasivo largo plazo', 2_000, 'Balance General > PASIVO > PASIVO A CORTO PLAZO'),
    item('SUMA EL PASIVO', 22_000, 'Balance General > PASIVO'),
    item('Capital social', 3_000, 'Balance General > CAPITAL CONTABLE'), item('TOTAL CAPITAL CONTABLE', 3_000, 'Balance General > CAPITAL CONTABLE'),
  ];
  const rec = computeStatementReconciliation(stmt(items, { totalAssets: 25_000, equity: 3_000 }));
  assert.equal(rec.sections.find(s => s.section === 'PASIVO')!.extractedTotal, 22_000);
  assert.equal(Math.round(rec.balanceCheck.diferencia ?? 1), 0);
});

test('a misplaced account that explains the gap is proposed for reclassification', () => {
  const items = [
    item('Efectivo', 10_000, 'Balance General > ACTIVO'), item('TOTAL ACTIVO', 10_000, 'Balance General > ACTIVO'),
    item('Proveedores', 4_000, 'Balance General > PASIVO'), item('Aportaciones de socios', 1_500, 'Balance General > PASIVO'), item('TOTAL PASIVO', 4_000, 'Balance General > PASIVO'),
    item('Capital social', 4_500, 'Balance General > CAPITAL'), item('TOTAL CAPITAL', 6_000, 'Balance General > CAPITAL'),
  ];
  const rec = computeStatementReconciliation(stmt(items, { totalAssets: 10_000, equity: 6_000 }));
  assert.ok(rec.suggestions.some(sg => sg.from === 'PASIVO' && sg.to === 'CAPITAL' && sg.accounts.some(a => a.name === 'Aportaciones de socios')));
});
