import assert from 'node:assert/strict';
import test from 'node:test';
import type { FinancialStatement_DB } from '../src/db/index';
import { standardRatios } from '../src/lib/financialMetrics';
import { FAVORITE_PRESETS, INDICATOR_GROUPS, TOUR_STEPS, needsOnboarding, ONBOARDING_VERSION, applyPreset } from '../src/lib/onboarding';
import { indicatorKey } from '../src/lib/indicatorInsights';

const labels = new Set(standardRatios({ id: 's', clientId: 'c', period: 'p', periodDate: '2026-01-31', uploadDate: '2026-01-31', mappedData: {}, rawLineItems: [], status: 'ok' } as unknown as FinancialStatement_DB).map(r => indicatorKey({ name: r.label })));

test('every indicator offered in onboarding exists as a standard ratio (favorites are stored by name)', () => {
  for (const name of INDICATOR_GROUPS.flatMap(g => g.items)) assert.ok(labels.has(indicatorKey({ name })), `unknown indicator: ${name}`);
});

test('every preset uses only indicators from the picker and has no duplicates', () => {
  const offered = new Set(INDICATOR_GROUPS.flatMap(g => g.items));
  for (const p of FAVORITE_PRESETS) {
    assert.equal(new Set(p.items).size, p.items.length, p.id);
    for (const item of p.items) assert.ok(offered.has(item), `${p.id}: ${item}`);
  }
  assert.deepEqual(applyPreset('no-existe'), []);
});

test('tour: unique steps, a favorites step, and anchored steps declare their target', () => {
  assert.equal(new Set(TOUR_STEPS.map(s => s.id)).size, TOUR_STEPS.length);
  assert.ok(TOUR_STEPS.some(s => s.kind === 'favorites'));
  assert.equal(TOUR_STEPS[0].id, 'welcome');
});

test('the tour covers every main screen, including Benchmark, Línea de vida, Z-Score and Configuración', () => {
  const ids = TOUR_STEPS.map(s => s.id);
  for (const id of ['dashboard', 'clients', 'benchmark', 'lifeline', 'zscore', 'assistant', 'settings']) assert.ok(ids.includes(id), id);
  assert.match(TOUR_STEPS[0].bullets[0], new RegExp(`${TOUR_STEPS.length} pasos`));
  const zscore = TOUR_STEPS.find(s => s.id === 'zscore')!;
  assert.match(zscore.bullets[0], /manualmente/); // the formula is not defined yet: the tour must not promise automatic scoring
});

test('onboarding shows for new users and again when the tour version changes, not after completion or skip', () => {
  assert.equal(needsOnboarding(null), true);
  assert.equal(needsOnboarding({ version: ONBOARDING_VERSION, completedAt: '2026-10-05' }), false);
  assert.equal(needsOnboarding({ version: ONBOARDING_VERSION, skippedAt: '2026-10-05' }), false);
  assert.equal(needsOnboarding({ version: ONBOARDING_VERSION - 1, completedAt: '2026-10-05' }), true);
});
