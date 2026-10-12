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
