import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { checkHierarchy } from '../src/lib/statementRules';

const rg2021 = JSON.parse(readFileSync('tests/fixtures-redgirasol-2021.json', 'utf8'));

test('Red Girasol 2021: el estado de resultados cuadra por niveles (solo redondeos de $1-2 de la fuente)', () => {
  const er = checkHierarchy(rg2021.raw_line_items, 'estado_resultados')!;
  assert.equal(er.top?.name, 'RESULTADO NETO');
  assert.equal(er.top?.reported, -3988151);
  assert.ok(Math.abs(er.top!.gap) <= 2);
  assert.ok(er.ok);
  const bg = checkHierarchy(rg2021.raw_line_items, 'balance_general')!;
  assert.equal(bg.failures.length, 0);
});

test('un subtotal que no cuadra se reporta con su nombre y diferencia', () => {
  const items = rg2021.raw_line_items.map((i: any) => (i.name === 'Comisiones cobradas' ? { ...i, value: i.value - 500000 } : i));
  const er = checkHierarchy(items, 'estado_resultados')!;
  assert.equal(er.ok, false);
  const f = er.failures.find(x => x.name === 'Resultado por servicios');
  assert.ok(f && Math.round(f.gap) === 500001);
});

test('sin jerarquía no se aplica la regla (estados viejos)', () => {
  assert.equal(checkHierarchy([{ name: 'Ingresos', value: 10, statementType: 'estado_resultados' }], 'estado_resultados'), null);
});

import { setAccountFeedbackCache, normalizeAccountName } from '../src/lib/accountFeedback';
import { getMetric } from '../src/lib/financialMetrics';

test('corrección de cuentas por cliente: la cartera de Red Girasol es "Instrumentos financieros para cobrar principal e interés"', () => {
  const stmt: any = { id: 's', clientId: 'rg', period: 'dic 21', periodDate: '2021-12-31', rawLineItems: rg2021.raw_line_items, mappedData: rg2021.mapped_data };
  assert.equal(getMetric(stmt, 'loanPortfolio'), null);   // sin corrección la app no la reconoce
  setAccountFeedbackCache('rg', { loanPortfolio: [normalizeAccountName('Instrumentos financieros para cobrar principal e interés')] });
  assert.equal(getMetric(stmt, 'loanPortfolio'), 5536695);
  // suma de varias cuentas: deuda = préstamos de corto + largo plazo
  setAccountFeedbackCache('rg', { totalDebt: ['prestamos bancarios y de otros organismos de corto plazo', 'prestamos bancarios y de otros organismos de largo plazo'] });
  assert.equal(getMetric(stmt, 'totalDebt'), 150032 + 2309607);
  setAccountFeedbackCache('rg', {});
});

test('Utilidad neta CNBV: "Participación en el resultado neto de otras entidades" (= 0) no gana a "RESULTADO NETO"', async () => {
  (globalThis as any).localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
  const { getMetric } = await import('../src/lib/financialMetrics');
  const stmt: any = { id: 'rg21', clientId: 'rg', period: '2021', periodDate: '2021-12-31', fileName: '', rawLineItems: rg2021.raw_line_items, mappedData: {}, extraAccounts: [] };
  assert.equal(getMetric(stmt, 'netIncome'), -3988151);
});

test('Deuda: un solo renglón de préstamos no se cuenta dos veces; inversionistas sí son deuda; nunca el pasivo total', async () => {
  (globalThis as any).localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
  const { getMetric } = await import('../src/lib/financialMetrics');
  const st = (items: any[]): any => ({ id: 'd', clientId: 'x', period: '', periodDate: '2025-12-31', fileName: '', rawLineItems: items.map(([name, value]) => ({ name, value, statementType: 'balance_general' })), mappedData: {}, extraAccounts: [] });
  assert.equal(getMetric(st([['Préstamos bancarios y de otros organismos', 100], ['Total pasivo', 150]]), 'totalDebt'), 100);
  assert.equal(getMetric(st([['Préstamos bancarios de corto plazo', 40], ['Préstamos bancarios de largo plazo', 60], ['Acreedores inversionistas', 50], ['Total pasivo', 170]]), 'totalDebt'), 150);
  assert.equal(getMetric(st([['Total activo a corto plazo', 80], ['Proveedores', 10], ['Total a corto plazo', 30], ['Total pasivo', 30]]), 'totalDebt'), null);
  assert.equal(getMetric(st([['Total activo a corto plazo', 80], ['Total activo', 200], ['Total pasivo', 30]]), 'totalAssets'), 200);
});

test('Gasto financiero nunca es un renglón de ingreso; un resumen "mapped" en 0 no bloquea la cuenta real', async () => {
  (globalThis as any).localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
  const { getMetric } = await import('../src/lib/financialMetrics');
  const er = (items: any[], mapped: any = {}): any => ({ id: 'e', clientId: 'x', period: '', periodDate: '2025-12-31', fileName: '', rawLineItems: items.map(([name, value]) => ({ name, value, statementType: 'estado_resultados' })), mappedData: mapped, extraAccounts: [] });
  assert.equal(getMetric(er([['Ingresos por intereses de créditos otorgados', 100], ['Costo de otorgamiento de crédito', -20], ['Gasto por interés, neto', -5]]), 'interestExpense'), 5);
  assert.equal(getMetric(er([['Ingresos por intereses de créditos otorgados', 100]]), 'interestExpense'), null);
  assert.equal(getMetric(er([['Utilidad neta', -7]], { netIncome: 0 }), 'netIncome'), -7);
  assert.equal(getMetric(er([['Ingresos por intereses', 100], ['Gastos generales', -40], ['Utilidad neta', 60]]), 'adminSellingOperatingExpenses'), 40);
});
