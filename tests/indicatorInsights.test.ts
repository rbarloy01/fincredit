import assert from 'node:assert/strict';
import test from 'node:test';
import type { Covenant_DB, FinancialStatement_DB } from '../src/db/index';
import { buildFavoriteInsights, explainFormula, indicatorKey, summarizeFavorites, toggleFavorite, buildFavoritesPrompt } from '../src/lib/indicatorInsights';

const stmt = (period: string, periodDate: string, mapped: Record<string, number>): FinancialStatement_DB => ({
  id: period, clientId: 'c1', period, periodDate, uploadDate: periodDate, mappedData: mapped, rawLineItems: [], status: 'ok',
} as unknown as FinancialStatement_DB);
const cov = (name: string, formula: string, operator: Covenant_DB['operator'] = 'none', threshold = ''): Covenant_DB => ({
  id: name, clientId: 'c1', name, type: 'financial', formula, threshold, operator, description: '', isCustom: false, createdAt: '2026-01-01',
} as Covenant_DB);

const icapSeries = [
  stmt('ene 26', '2026-01-31', { equity: 20, totalAssets: 100 }),
  stmt('feb 26', '2026-02-28', { equity: 18, totalAssets: 100 }),
  stmt('mar 26', '2026-03-31', { equity: 16, totalAssets: 100 }),
  stmt('abr 26', '2026-04-30', { equity: 14, totalAssets: 100 }),
];

test('favorite keys are stable by name and toggle on/off', () => {
  const k = indicatorKey(cov('ICAP', 'ratio:equity/totalAssets'));
  assert.equal(k, 'name:icap');
  assert.deepEqual(toggleFavorite([], k), [k]);
  assert.deepEqual(toggleFavorite([k], k), []);
});

test('favorite insight: consecutive deterioration, headroom and breach risk are surfaced', () => {
  const icap = cov('ICAP', 'ratio:equity/totalAssets', 'gte', '12%');
  const [ins] = buildFavoriteInsights([icap], icapSeries, [indicatorKey(icap)]);
  assert.equal(ins.streak.direction, 'empeora');
  assert.ok(ins.streak.length >= 3);
  assert.equal(ins.severity, 'atencion');
  assert.ok(ins.lines.some(l => /consecutivos empeorando/.test(l)));
  assert.ok(ins.headroom !== null && Math.abs(ins.headroom - 0.02) < 1e-9);
});

test('favorite insight: a breached limit is critical, and paused clients are never marked as breaching', () => {
  const icap = cov('ICAP', 'ratio:equity/totalAssets', 'gte', '15%');
  assert.equal(buildFavoriteInsights([icap], icapSeries, ['name:icap'])[0].severity, 'critico');
  assert.notEqual(buildFavoriteInsights([icap], icapSeries, ['name:icap'], undefined, false)[0].severity, 'critico');
});

test('summary headline counts favorites by severity and the empty state invites to pick favorites', () => {
  const icap = cov('ICAP', 'ratio:equity/totalAssets', 'gte', '15%');
  const s = summarizeFavorites(buildFavoriteInsights([icap], icapSeries, ['name:icap']), 'Ana');
  assert.match(s.headline, /1 favoritos: 1 crítico/);
  assert.match(summarizeFavorites([], 'Ana').headline, /aún no marca/);
  assert.match(buildFavoritesPrompt('Tim', 'Ana', buildFavoriteInsights([icap], icapSeries, ['name:icap'])), /INDICADORES FAVORITOS DE ANA/);
});

test('formula map: inputs with their values, and a missing input is flagged because it is evaluated as 0', () => {
  const ok = explainFormula(cov('ICAP', 'ratio:equity/totalAssets'), icapSeries[0]);
  assert.equal(ok.inputs.length, 2);
  assert.equal(ok.severity, 'ok');
  assert.ok(Math.abs((ok.result as number) - 0.2) < 1e-9);
  const bad = explainFormula(cov('Cobertura', 'ratio:ebitda/interestExpense'), icapSeries[0]);
  assert.equal(bad.severity, 'error');
  assert.deepEqual(bad.missing.sort(), ['EBITDA', 'Gasto financiero'].sort());
  assert.match(bad.notes[0], /toma como 0/);
});

test('formula map: free-text formulas and flow/balance mixes carry a comparability note', () => {
  const text = explainFormula(cov('Apalancamiento', 'apalancamiento'), icapSeries[0]);
  assert.equal(text.kind, 'texto libre');
  assert.equal(text.severity, 'aviso');
  const roaNoLimit = explainFormula(cov('ROA', 'ratio:netIncome/totalAssets'), stmt('abr', '2026-04-30', { netIncome: 8, totalAssets: 100 }));
  assert.ok(roaNoLimit.notes.some(n => /se anualiza/.test(n)));
  const roaLimit = explainFormula(cov('ROA', 'ratio:netIncome/totalAssets', 'gte', '5'), stmt('abr', '2026-04-30', { netIncome: 8, totalAssets: 100 }));
  assert.ok(roaLimit.notes.some(n => /literal/.test(n)));
  const custom = explainFormula(cov('X', 'ratio:netIncome/equity_custom'), stmt('abr', '2026-04-30', { netIncome: 8, totalAssets: 100 }));
  assert.ok(custom.inputs.length === 2);
});
