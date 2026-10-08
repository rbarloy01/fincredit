import assert from 'node:assert/strict';
import test from 'node:test';
import type { FinancialStatement_DB } from '../src/db/index';
import { standardRatios } from '../src/lib/financialMetrics';
import { KNOWN_INDICATORS, draftErrors, knownIndicatorDirection, knownIndicatorFormula, limitSentence, previewDraft, thresholdToStore } from '../src/lib/covenantBuilder';
import { parseFormulaText } from '../src/lib/formulaText';

const stmt = (period: string, periodDate: string, m: Record<string, number>): FinancialStatement_DB => ({ id: period, clientId: 'c', period, periodDate, uploadDate: periodDate, mappedData: m, rawLineItems: [], status: 'ok' }) as unknown as FinancialStatement_DB;
const series = [
  stmt('ene 26', '2026-01-31', { equity: 20, totalAssets: 100, totalDebt: 40, ebitda: 10 }),
  stmt('feb 26', '2026-02-28', { equity: 16, totalAssets: 100, totalDebt: 50, ebitda: 10 }),
  stmt('mar 26', '2026-03-31', { equity: 12, totalAssets: 100, totalDebt: 60, ebitda: 10 }),
];

test('every known indicator exists as a standard ratio with that exact label', () => {
  const labels = new Map(standardRatios(stmt('p', '2026-01-31', {})).map(r => [r.key, r.label]));
  for (const ind of KNOWN_INDICATORS) assert.equal(labels.get(ind.key), ind.label, ind.key);
});

test('known indicators carry the right direction: ICAP wants a minimum, leverage a maximum', () => {
  const by = (k: string) => KNOWN_INDICATORS.find(i => i.key === k)!;
  assert.equal(knownIndicatorDirection(by('capitalization')), 'gte');
  assert.equal(knownIndicatorDirection(by('leverage')), 'lte');
  assert.equal(knownIndicatorFormula(by('capitalization')), 'ratio:equity/totalAssets');
});

test('a percent limit is stored as a fraction so it never depends on the covenant name', () => {
  assert.equal(thresholdToStore('15', 'percent'), '0.15');
  assert.equal(thresholdToStore('15%', 'percent'), '0.15');
  assert.equal(thresholdToStore('4.5', 'number'), '4.5');
  assert.equal(thresholdToStore('', 'percent'), '');
  assert.equal(thresholdToStore('abc', 'number'), '');
});

test('preview evaluates the draft per period exactly as the saved covenant will be evaluated', () => {
  const p = previewDraft({ name: 'Mi indicador', formula: 'ratio:equity/totalAssets', kind: 'gte', limit: '15', unit: 'percent' }, series);
  assert.deepEqual(p.rows.map(r => r.display), ['20.0%', '16.0%', '12.0%']);
  assert.deepEqual(p.rows.map(r => r.status), ['cumple', 'alerta', 'incumple']);
  assert.equal(p.computable, true);
  assert.equal(previewDraft({ name: 'x', formula: 'ratio:equity/totalAssets', kind: 'none', limit: '', unit: 'percent' }, series).rows[0].status, 'sin_limite');
  // paused clients are never shown as breaching
  assert.ok(previewDraft({ name: 'x', formula: 'ratio:equity/totalAssets', kind: 'gte', limit: '15', unit: 'percent' }, series, false).rows.every(r => r.status !== 'incumple'));
});

test('preview warns when an input has no data (it would silently count as 0) and when nothing computes', () => {
  const p = previewDraft({ name: 'x', formula: 'ratio:cash/currentLiabilities', kind: 'none', limit: '', unit: 'number' }, series);
  assert.equal(p.computable, false);
  assert.ok(p.warnings.some(w => /Sin dato en mar 26/.test(w)));
  assert.ok(previewDraft({ name: 'x', formula: '', kind: 'none', limit: '', unit: 'number' }, series).warnings[0].includes('Aún no hay fórmula'));
});

test('limit sentences are plain Spanish and validation lists what is missing', () => {
  assert.equal(limitSentence('ICAP', 'gte', '15', 'percent'), 'Cumple si ICAP es mayor o igual a 15%. Se marca en alerta cuando queda a menos de 15% del límite.');
  assert.match(limitSentence('Costo', 'none', '', 'number'), /nunca se marca en incumplimiento/);
  assert.deepEqual(draftErrors({ name: '', formula: '', kind: 'lte', limit: '', unit: 'number' }), ['Ponle un nombre al covenant.', 'Define qué se mide.', 'Escribe el valor del límite.']);
  assert.deepEqual(draftErrors({ name: 'a', formula: 'f', kind: 'none', limit: '', unit: 'number' }), []);
});

test('text → formula: "deuda total entre ebitda" and unknown words are reported', () => {
  const aliases = [{ key: 'totalDebt', label: 'Deuda Total' }, { key: 'ebitda', label: 'EBITDA' }, { key: 'equity', label: 'Capital Contable' }];
  assert.deepEqual(parseFormulaText('deuda total entre ebitda', aliases).tokens, ['ref:totalDebt', '/', 'ref:ebitda']);
  assert.deepEqual(parseFormulaText('(deuda total menos 5) dividido por capital contable', aliases).tokens, ['(', 'ref:totalDebt', '-', 'num:5', ')', '/', 'ref:equity']);
  assert.deepEqual(parseFormulaText('deuda total entre inventarios', aliases).missing, ['inventarios']);
});

test('text → formula never mistakes words inside account names for operators', () => {
  const aliases = [
    { key: 'banksFundsShortTerm', label: 'Bancos y fondos CP' }, { key: 'totalAssets', label: 'Total activo' },
    { key: 'a1', label: 'Participación por impuestos' }, { key: 'equity', label: 'Capital Contable' },
  ];
  assert.deepEqual(parseFormulaText('bancos y fondos cp entre total activo', aliases).tokens, ['ref:banksFundsShortTerm', '/', 'ref:totalAssets']);
  assert.deepEqual(parseFormulaText('participación por impuestos más capital contable', aliases).tokens, ['ref:a1', '+', 'ref:equity']);
  assert.deepEqual(parseFormulaText('capital contable por 100', aliases).tokens, ['ref:equity', '*', 'num:100']);
});
