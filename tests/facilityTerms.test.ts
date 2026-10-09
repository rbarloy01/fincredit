import assert from 'node:assert/strict';
import test from 'node:test';
import { effectiveRate, effectiveDefaultRate, emptyFacilityTerms, termsFromExtraction } from '../src/lib/facilityTerms';

test('tasa variable: referencia + sobretasa acotada por piso y techo; moratoria como múltiplo', () => {
  const t = { ...emptyFacilityTerms(), tasaTipo: 'variable' as const, referencia: 'TIIE 28', referenciaValor: '7.25', sobretasa: '4.5', piso: '13', techo: '16' };
  assert.equal(effectiveRate(t).rate, 13);                                // 11.75 < piso 13
  assert.equal(effectiveRate({ ...t, referenciaValor: '12.5' }).rate, 16); // 17 > techo 16
  assert.equal(effectiveRate({ ...t, referenciaValor: '10' }).rate, 14.5);
  assert.equal(effectiveRate({ ...t, referenciaValor: '' }).rate, null);
  assert.equal(effectiveDefaultRate({ ...t, referenciaValor: '10', moratorioFactor: '2' }), 29);
  assert.equal(effectiveDefaultRate({ ...t, moratorioTasa: '36' }), 36);
});

test('términos del contrato: nulls quedan vacíos y las comisiones se conservan', () => {
  const t = termsFromExtraction({ plazoMeses: 36, tasaTipo: 'variable', referencia: 'TIIE 28', sobretasa: 5, piso: null, comisiones: [{ concepto: 'Apertura', valor: '1%', base: 'monto de la línea' }] });
  assert.equal(t.plazoMeses, '36');
  assert.equal(t.piso, '');
  assert.equal(t.comisiones.length, 1);
  assert.equal(t.fuente, 'contrato');
});

import { parseLimit } from '../src/components/transactions/FacilityTermsEditor';

test('el límite del covenant se entiende como lo escribe el analista', () => {
  assert.equal(parseLimit('30%', 'percent').store, '0.3');
  assert.equal(parseLimit('30', 'percent').store, '0.3');
  assert.equal(parseLimit('0.30', 'percent').store, '0.3');
  assert.equal(parseLimit('1.25x', 'number').store, '1.25');
  assert.equal(parseLimit('1,25', 'number').store, '1.25');
  assert.ok(parseLimit('abc', 'number').error);
  assert.equal(parseLimit('', 'percent').store, null);
});
