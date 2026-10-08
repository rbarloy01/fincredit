import assert from 'node:assert/strict';
import test from 'node:test';
import type { Client, FinancialStatement_DB } from '../src/db/index';
import { buildBenchmarkContext, percentile, placement } from '../src/lib/benchmarkContext';

const client = (id: string, name: string, status: string, industry = 'Arrendadora'): Client => ({ id, name, status, industry, totalCreditValue: 1e7, currentDue: 5e6 }) as unknown as Client;
const stmt = (id: string, m: Record<string, number>): FinancialStatement_DB => ({ id, clientId: id, period: 'Abril 2026', periodDate: '2026-04-30', uploadDate: '2026-04-30', mappedData: m, rawLineItems: [], status: 'ok' }) as unknown as FinancialStatement_DB;

test('percentiles interpolate and placement respects the polarity of the ratio', () => {
  assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(percentile([1, 2, 3, 4], 0.25), 1.75);
  assert.equal(percentile([], 0.5), null);
  // ICAP: higher is better → the highest value is better placed than 100% of the others
  assert.equal(placement([0.1, 0.2, 0.3, 0.4], 0.4, 'capitalization'), 100);
  // leverage: lower is better → the lowest value is the best placed
  assert.equal(placement([0.1, 0.2, 0.3, 0.4], 0.1, 'leverage'), 100);
  assert.equal(placement([0.1], 0.1, 'leverage'), null);
});

test('benchmark includes dormant clients as reference (labelled), and warns about small samples', () => {
  const inputs = [
    { client: client('a', 'ALFA', 'activo'), statements: [stmt('a', { equity: 20, totalAssets: 100, netIncome: 3 })] },
    { client: client('b', 'BETA', 'activo'), statements: [stmt('b', { equity: 10, totalAssets: 100, netIncome: 1 })] },
    { client: client('c', 'GAMMA', 'dormido'), statements: [stmt('c', { equity: 50, totalAssets: 100, netIncome: 9 })] },
    { client: client('d', 'DELTA', 'activo'), statements: [] },
  ];
  const pack = buildBenchmarkContext(inputs);
  assert.match(pack.text, /Clientes comparados: 3 con estados financieros \(de 4\), de los cuales 1 están dormidos o terminados/);
  assert.match(pack.text, /ICAP \| 3 \|/);
  assert.match(pack.text, /GAMMA \| dormido \|/);
  assert.ok(pack.text.includes('ALFA'));
  assert.ok(pack.notes.some(n => /Menos de 5 clientes/.test(n)));
  assert.ok(pack.notes.some(n => /1 clientes no tienen estados/.test(n)));
});
