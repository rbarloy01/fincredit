import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRateFormula, rateForMonth } from '../src/lib/referenceRates';
import { lenderRatesByCutoff } from '../src/lib/fundingCost';

test('fórmulas de tasa variable: TIIE + sobretasa en pb / pp / %, piso y techo', () => {
  assert.deepEqual(parseRateFormula('TIIE + 350 pb'), { series: 'tiie28', spread: 0.035, floor: null, cap: null, text: 'TIIE + 350 pb' });
  assert.equal(parseRateFormula('TIIE 28 + 3.5%')!.spread, 0.035);
  const f = parseRateFormula('TIIE de fondeo + 4 pp, piso 12%')!;
  assert.equal(f.series, 'tiie_fondeo'); assert.equal(f.spread, 0.04); assert.equal(f.floor, 0.12);
  assert.equal(parseRateFormula('TIIE91 + 2.75 puntos techo 18%')!.series, 'tiie91');
  assert.equal(parseRateFormula('20% fija'), null);
  assert.ok(Math.abs(rateForMonth(parseRateFormula('TIIE + 350 pb')!, 7.25)! - 0.1075) < 1e-12);
  assert.equal(rateForMonth(f, 7.0), 0.12);            // 7% + 4 pp = 11% < piso 12%
  assert.equal(rateForMonth(f, null), null);
});

test('tasa por fondeador en cada corte: la TIIE del mes mueve la tasa variable; la fija no', () => {
  const liab: any[] = [
    { lenderName: 'Banco A', currentBalance: 100, interestRate: null, rateDescription: 'TIIE + 400 pb' },
    { lenderName: 'Fondo B', currentBalance: 50, interestRate: 0.2, rateDescription: '' },
  ];
  const tape: any = { '2026-07-31': { cutoff: '2026-07-31', waRate: 0.3 }, '2026-08-31': { cutoff: '2026-08-31', waRate: 0.3 } };
  const rows = lenderRatesByCutoff(liab, tape, { tiie28: { '2026-07': 7.5, '2026-08': 7.0 } });
  assert.ok(Math.abs(rows[0].lenders[0].rate! - 0.115) < 1e-12);
  assert.ok(Math.abs(rows[1].lenders[0].rate! - 0.11) < 1e-12);
  assert.equal(rows[1].lenders[1].rate, 0.2);
  assert.ok(Math.abs(rows[1].lenders[0].spread! - 0.19) < 1e-12);
});
