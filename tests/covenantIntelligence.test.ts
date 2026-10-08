import assert from 'node:assert/strict';
import test from 'node:test';
import type { Covenant_DB, FinancialStatement_DB } from '../src/db/index';
import { covenantDirection, covenantPerformanceHistory, getMetric, incomeSpan, standardRatios } from '../src/lib/financialMetrics';
import { forecastCovenant, forecastCovenants } from '../src/lib/covenantForecastModel';

const mapped = (values: Partial<FinancialStatement_DB['mappedData']>): FinancialStatement_DB['mappedData'] => ({
  revenue: 0,
  cogs: 0,
  operatingExpenses: 0,
  ebitda: 0,
  interestExpense: 0,
  netIncome: 0,
  currentAssets: 0,
  currentLiabilities: 0,
  totalDebt: 0,
  totalAssets: 0,
  equity: 0,
  ...values,
});

function statement(
  period: string,
  periodDate: string,
  values: Partial<FinancialStatement_DB['mappedData']>,
  rawLineItems: FinancialStatement_DB['rawLineItems'] = [],
): FinancialStatement_DB {
  return {
    id: period,
    clientId: 'client-1',
    period,
    periodDate,
    uploadDate: `${periodDate}T00:00:00.000Z`,
    fileName: `${period}.xlsx`,
    rawLineItems,
    mappedData: mapped(values),
    extraAccounts: [],
  };
}

test('fuzzy trigram fallback resolves an account name no exact/contains/word-set rule catches', () => {
  const withoutTypo = statement('2026-Q1', '2026-03-31', {}, [
    { name: 'Otro concepto sin relacion alguna', value: 999, statementType: 'balance_general' },
  ]);
  assert.equal(getMetric(withoutTypo, 'availableInvestments'), null);

  const withTypo = statement('2026-Q1', '2026-03-31', {}, [
    { name: 'Inversiones en Balores', value: 12345, statementType: 'balance_general' },
  ]);
  assert.equal(getMetric(withTypo, 'availableInvestments'), 12345);
});

test('coreBusinessIncome falls back to revenue instead of matching an unrelated short "Ingresos Financieros" line', () => {
  // Real FRONT CAPITAL bug: a small interest-on-cash line under COSTOS
  // FINANCIEROS was matching the "ingresos financieros y comisiones" alias
  // via an unguarded reverse-substring check, tanking every margin ratio.
  const stmt = statement('2023-05', '2023-05-31', { revenue: undefined as unknown as number }, [
    { name: 'Total INGRESOS NETOS', value: 7562881, statementType: 'estado_resultados', sectionPath: 'Estado de Resultados > INGRESOS' },
    { name: 'Ingresos Financieros', value: 6141, statementType: 'estado_resultados', sectionPath: 'Estado de Resultados > COSTOS FINANCIEROS' },
  ]);
  assert.equal(getMetric(stmt, 'coreBusinessIncome'), 7562881);
});

test('adjustedFinancialMargin does not match a plain non-risk-adjusted "Margen Financiero" line', () => {
  // Real SOLVENKA bug: "Margen Financiero" (unadjusted) fuzzy-matched the
  // "margen financiero ajustado" alias, inflating the financial-margin ratio
  // to 211x. This metric has no legitimate unadjusted fallback, so it should
  // report missing rather than substitute the wrong figure.
  const stmt = statement('2023-12', '2023-12-31', {}, [
    { name: 'Margen Financiero', value: 121135734, statementType: 'estado_resultados' },
    { name: 'Intereses Ganados', value: 572873, statementType: 'estado_resultados' },
  ]);
  assert.equal(getMetric(stmt, 'adjustedFinancialMargin'), null);

  const withAdjusted = statement('2023-12', '2023-12-31', {}, [
    { name: 'Margen Financiero Ajustado', value: 34261871, statementType: 'estado_resultados' },
  ]);
  assert.equal(getMetric(withAdjusted, 'adjustedFinancialMargin'), 34261871);
});

test('"Otros ingresos de la operación" does not get treated as core business income', () => {
  // Real LIQUIDEZ CORPORATIVA bug: a residual/miscellaneous income line
  // textually contains the "ingresos de la operacion" alias as a suffix
  // ("Otros " + alias), so an unqualified substring/word-set match picked it
  // over the real interest+fee income (167M), tanking every margin ratio.
  const stmt = statement('2024-04', '2024-04-30', { revenue: undefined as unknown as number }, [
    { name: 'Ingresos por intereses', value: 157736847, statementType: 'estado_resultados' },
    { name: 'Comisiones Cobradas', value: 9322758, statementType: 'estado_resultados' },
    { name: 'Otros ingresos de la operación', value: 1297337, statementType: 'estado_resultados' },
  ]);
  assert.equal(getMetric(stmt, 'coreBusinessIncome'), 167059605);

  // A genuine "ingresos de la operacion" line (no "otros" prefix) should
  // still match normally.
  const withGenuineMatch = statement('2024-04', '2024-04-30', { revenue: undefined as unknown as number }, [
    { name: 'Ingresos de la operación', value: 555555, statementType: 'estado_resultados' },
  ]);
  assert.equal(getMetric(withGenuineMatch, 'coreBusinessIncome'), 555555);
});

function dscrCovenant(operator: Covenant_DB['operator'], threshold: string): Covenant_DB {
  return {
    id: 'cov-dscr',
    clientId: 'client-1',
    name: 'DSCR minimo',
    type: 'financial',
    formula: 'ratio:ebitda/interestExpense',
    threshold,
    operator,
    description: '',
    isCustom: false,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function statementsWithDscr(dscrValues: number[]): FinancialStatement_DB[] {
  return dscrValues.map((dscr, i) => statement(`P${i}`, `2026-0${i + 1}-01`, {
    ebitda: dscr * 100,
    interestExpense: 100,
  }));
}

test('covenant forecast returns null without enough historical periods', () => {
  const covenant = dscrCovenant('gte', '1.25');
  const statements = statementsWithDscr([1.5, 1.4]);
  assert.equal(forecastCovenant(covenant, statements), null);
});

test('covenant forecast flags a deteriorating trend and rising breach probability', () => {
  const covenant = dscrCovenant('gte', '1.25');
  // DSCR sliding from comfortably compliant toward and past the 1.25x floor.
  const statements = statementsWithDscr([1.6, 1.5, 1.4, 1.3, 1.2]);
  const forecast = forecastCovenant(covenant, statements);
  assert.ok(forecast);
  assert.equal(forecast!.trend, 'deteriorando');
  assert.ok(forecast!.predictedNextValue < forecast!.lastValue);
  assert.ok(forecast!.breachProbability > 0.5);
  assert.equal(forecast!.confidence, 'media');
});

test('covenant forecast flags an improving trend and low breach probability', () => {
  const covenant = dscrCovenant('gte', '1.25');
  const statements = statementsWithDscr([1.3, 1.5, 1.7, 1.9, 2.1]);
  const forecast = forecastCovenant(covenant, statements);
  assert.ok(forecast);
  assert.equal(forecast!.trend, 'mejorando');
  assert.ok(forecast!.breachProbability < 0.3);
});

test('forecastCovenants ranks the covenant with the tighter threshold first', () => {
  // Same declining DSCR history, evaluated against two covenants with
  // different floors: the tighter one (1.4x) is closer to being breached
  // than the looser one (1.0x), so it should rank as the higher risk.
  const loose = dscrCovenant('gte', '1.0');
  loose.id = 'cov-loose';
  const tight = dscrCovenant('gte', '1.4');
  tight.id = 'cov-tight';
  const statements = statementsWithDscr([1.6, 1.5, 1.4, 1.3, 1.2]);

  const ranked = forecastCovenants([loose, tight], statements);
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].covenantId, 'cov-tight');
  assert.ok(ranked[0].breachProbability > ranked[1].breachProbability);
});

const icapCovenant = (operator: Covenant_DB['operator'], threshold = ''): Covenant_DB => ({
  id: 'icap', clientId: 'client-1', name: 'ICAP', type: 'financial', formula: 'ratio:equity/totalAssets',
  threshold, operator, description: '', isCustom: false, createdAt: '2026-01-01',
} as Covenant_DB);

test('ICAP rising is an improvement even when the covenant has no threshold (form default operator lte/none)', () => {
  const stmts = [
    statement('dic 25', '2025-12-31', { equity: 86_168_157, totalAssets: 96_827_860 }),
    statement('abr 26', '2026-04-30', { equity: 120_876_066, totalAssets: 129_532_752 }),
  ];
  for (const operator of ['lte', 'none'] as const) {
    const history = covenantPerformanceHistory(icapCovenant(operator), stmts);
    assert.equal(history[1].movement, 'betterment', `operator ${operator} without threshold`);
  }
});

test('covenant direction: contract threshold operator wins; otherwise ratio semantics decide', () => {
  assert.equal(covenantDirection(icapCovenant('lte', '10')), 'lower');
  assert.equal(covenantDirection(icapCovenant('gte', '15')), 'higher');
  assert.equal(covenantDirection(icapCovenant('lte')), 'higher');
  assert.equal(covenantDirection({ ...icapCovenant('none'), name: 'Apalancamiento', formula: 'ratio:totalDebt/equity' }), 'lower');
  assert.equal(covenantDirection({ ...icapCovenant('none'), name: 'Cartera vencida', formula: 'ratio:pastDuePortfolio/managedPortfolio' }), 'lower');
});

test('income-statement ratios are annualized for accumulated periods (Tim Leasing abril = 4 meses)', () => {
  const dec = statement('Diciembre 2025', '2025-12-31', { netIncome: 10_710_624, totalAssets: 96_827_860, equity: 86_168_157, revenue: 25_908_177 });
  const apr = statement('Abril 2026', '2026-04-30', { netIncome: 8_207_908, totalAssets: 129_532_752, equity: 120_876_066, revenue: 15_512_141 });
  assert.equal(incomeSpan(dec, [apr]).months, 12);
  assert.equal(incomeSpan(apr, [dec]).months, 4);
  const roa = (stmt: FinancialStatement_DB, siblings: FinancialStatement_DB[]) => standardRatios(stmt, siblings).find(r => r.key === 'roa')!;
  assert.ok(Math.abs((roa(dec, [apr]).value as number) - 10_710_624 / 96_827_860) < 1e-9);
  assert.ok(Math.abs((roa(apr, [dec]).value as number) - (8_207_908 * 3) / 129_532_752) < 1e-9);
  assert.match(roa(apr, [dec]).formula, /anualizado ×3\.00/);
});

test('a series whose revenue rises and falls is monthly (not accumulated): no annualization surprise', () => {
  const m = (p: string, d: string, rev: number) => statement(p, d, { revenue: rev, netIncome: rev * 0.1, totalAssets: 1_000, equity: 500 });
  const series = [m('ene 25', '2025-01-31', 100), m('feb 25', '2025-02-28', 80), m('mar 25', '2025-03-31', 120)];
  assert.equal(incomeSpan(series[2], series).months, 1);
  const cumulative = [m('ene 25', '2025-01-31', 100), m('feb 25', '2025-02-28', 190), m('mar 25', '2025-03-31', 310)];
  assert.equal(incomeSpan(cumulative[2], cumulative).months, 3);
});

const roaIndicator = (operator: Covenant_DB['operator'], threshold = ''): Covenant_DB => ({
  id: 'roa', clientId: 'client-1', name: 'ROA', type: 'financial', formula: 'ratio:netIncome/totalAssets',
  threshold, operator, description: '', isCustom: false, createdAt: '2026-01-01',
} as Covenant_DB);

test('storyline: an indicator without a limit is compared annualized, so ROA of 4 accumulated months is not a fake deterioration', () => {
  const dec = statement('Diciembre 2025', '2025-12-31', { netIncome: 10_710_624, totalAssets: 96_827_860, equity: 86_168_157, revenue: 25_908_177 });
  const apr = statement('Abril 2026', '2026-04-30', { netIncome: 8_207_908, totalAssets: 129_532_752, equity: 120_876_066, revenue: 15_512_141 });
  const history = covenantPerformanceHistory(roaIndicator('none'), [dec, apr]);
  assert.ok(Math.abs((history[1].value as number) - (8_207_908 * 3) / 129_532_752) < 1e-9);
  assert.equal(history[1].movement, 'betterment'); // 19.0% annualized vs 11.1% in December
});

test('an indicator WITH a contractual limit is measured literally, as the contract states', () => {
  const dec = statement('Diciembre 2025', '2025-12-31', { netIncome: 10_710_624, totalAssets: 96_827_860, equity: 86_168_157, revenue: 25_908_177 });
  const apr = statement('Abril 2026', '2026-04-30', { netIncome: 8_207_908, totalAssets: 129_532_752, equity: 120_876_066, revenue: 15_512_141 });
  const history = covenantPerformanceHistory(roaIndicator('gte', '5'), [dec, apr]);
  assert.ok(Math.abs((history[1].value as number) - 8_207_908 / 129_532_752) < 1e-9);
});
