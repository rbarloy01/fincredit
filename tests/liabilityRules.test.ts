import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { classifyLiability, detectCutoffs, linesFromRows, linesFromText, parseLiabilityBreakdown, screenAiLiabilityRows } from '../src/lib/liabilityRules';

const ago = readFileSync('tests/fixtures/rg-segregacion-agosto2026.txt', 'utf8');

test('segregación Red Girasol ago-26: unidad, corte, jerarquía por sumas, fondeadores y cuadre', () => {
  const r = parseLiabilityBreakdown(linesFromText(ago), { text: ago, fileName: 'Segregacion de Pasivos_Agosto2026.pdf' });
  assert.equal(r.recognized, true);
  assert.equal(r.unit, 1000);
  const p = r.periods[0];
  assert.equal(p.cutoff, '2026-08-31');
  assert.equal(p.totalLiabilities, 54_486_000);
  assert.deepEqual(p.funding.map(f => [f.lender, f.term, f.balance]), [
    ['Clara CF Tech', 'corto', 81_000], ['Play Business SAPI de CV', 'largo', 290_000], ['Hexágono Capital', 'largo', 34_667_000],
  ]);
  assert.equal(p.composition.fondeo, 35_038_000);
  assert.equal(p.composition.impuestos, 8_903_000 + 7_935_000);
  assert.equal(p.composition.operativo, 1_820_000);
  assert.equal(p.composition.empleados, 791_000);
  assert.ok(p.checks.every(c => c.ok), JSON.stringify(p.checks));
  // Credit Saison está bajo "Acreedores diversos": es operativo, no fondeador.
  assert.ok(!p.funding.some(f => /Saison/.test(f.lender)));
});

test('varias columnas = varios cortes; Excel con las mismas reglas', () => {
  const rows = [
    ['Préstamos bancarios y de otros organismos', 37116, 35038],
    ['De corto plazo', 44, 81], ['Banco X', 44, 81],
    ['De largo plazo', 37072, 34957], ['Fondo Y', 37072, 34957],
    ['Proveedores', 100, 200],
    ['Total pasivo', 37216, 35238],
  ];
  const r = parseLiabilityBreakdown(linesFromRows(rows as any), { text: 'Cifras en miles de pesos 31-jul-26 31-ago-26' });
  assert.equal(r.periods.length, 2);
  assert.deepEqual(r.periods.map(p => p.cutoff), ['2026-07-31', '2026-08-31']);
  assert.deepEqual(r.periods[1].funding.map(f => f.balance), [81_000, 34_957_000]);
  assert.ok(r.periods.every(p => p.checks.every(c => c.ok)));
});

test('clasificación y filtro de salidas de IA: solo el fondeo con costo es pasivo institucional', () => {
  assert.equal(classifyLiability('ISR Retenido Inversionistas'), 'impuestos');
  assert.equal(classifyLiability('Certificados bursátiles'), 'fondeo');
  assert.equal(classifyLiability('Beneficios por terminación'), 'empleados');
  const { keep, dropped } = screenAiLiabilityRows([{ lenderName: 'BBVA' }, { lenderName: 'Impuesto al valor agregado' }, { lenderName: 'Proveedores' }]);
  assert.deepEqual(keep.map(k => k.lenderName), ['BBVA']);
  assert.equal(dropped.length, 2);
  assert.deepEqual(detectCutoffs('', '260831 - Segregacion.pdf'), ['2026-08-31']);
});

test('segregación Red Girasol jul-26: mismo resultado con otros acreedores operativos', () => {
  const jul = readFileSync('tests/fixtures/rg-segregacion-julio2026.txt', 'utf8');
  const r = parseLiabilityBreakdown(linesFromText(jul), { text: jul, fileName: 'Segregacion de Pasivos_Julio2026.pdf' });
  const p = r.periods[0];
  assert.equal(p.cutoff, '2026-07-31');
  assert.equal(p.composition.fondeo, 37_116_000);
  assert.deepEqual(p.funding.map(f => f.lender), ['Clara CF Tech', 'Play Business SAPI de CV', 'Hexágono Capital']);
  assert.ok(p.checks.every(c => c.ok), JSON.stringify(p.checks));
});
