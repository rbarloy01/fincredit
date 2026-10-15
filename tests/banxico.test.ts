import assert from 'node:assert/strict';
import test from 'node:test';
import { monthlyPoints } from '../server/banxicoProxy';

test('TIIE mensual: valor al cierre del mes y promedio del mes', () => {
  const pts = monthlyPoints([
    { date: '2026-07-30', value: 7.6 }, { date: '2026-07-31', value: 7.5 }, { date: '2026-07-01', value: 7.7 },
    { date: '2026-08-31', value: 7.25 },
  ]);
  assert.deepEqual(pts.map(p => [p.month, p.endOfMonth, p.lastDate]), [['2026-07', 7.5, '2026-07-31'], ['2026-08', 7.25, '2026-08-31']]);
  assert.ok(Math.abs(pts[0].average - 7.6) < 1e-9);
});
