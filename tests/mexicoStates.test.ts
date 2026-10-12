import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregateByState, mexicanStateId } from '../src/lib/mexicoStates';
import { MEXICO_STATES } from '../src/lib/mexicoStatesGeo';

test('estados: variantes comunes del loan tape', () => {
  const cases: Array<[string, string | null]> = [
    ['CDMX', 'MX-CMX'], ['Ciudad de México', 'MX-CMX'], ['Distrito Federal', 'MX-CMX'], ['Edo. de México', 'MX-MEX'], ['ESTADO DE MEXICO', 'MX-MEX'],
    ['Veracruz de Ignacio de la Llave', 'MX-VER'], ['Nuevo León', 'MX-NLE'], ['NL', 'MX-NLE'], ['Baja California Sur', 'MX-BCS'], ['Baja California', 'MX-BCN'],
    ['Guadalajara, Jalisco', 'MX-JAL'], ['Q. Roo', 'MX-ROO'], ['San Luis Potosí', 'MX-SLP'], ['Coahuila de Zaragoza', 'MX-COA'], ['Texas', null], ['', null], ['Sin dato', null],
  ];
  cases.forEach(([input, id]) => assert.equal(mexicanStateId(input), id, input));
});

test('mapa: 32 estados con contorno y la cartera se agrega por estado', () => {
  assert.equal(MEXICO_STATES.length, 32);
  assert.ok(MEXICO_STATES.every(s => s.d.startsWith('M') && s.d.length > 50));
  const r = (state: string, b: number, dpd: number) => ({ state, outstanding_balance: b, days_overdue: dpd }) as any;
  const a = aggregateByState([r('Jalisco', 100, 0), r('JAL', 50, 120), r('CDMX', 50, 0), r('Texas', 0, 0)]);
  assert.equal(a.states.get('MX-JAL')!.balance, 150);
  assert.equal(a.states.get('MX-JAL')!.venPct, 1 / 3);
  assert.equal(a.states.size, 2);
  assert.equal(a.unmatched[0].name, 'Texas');
});
