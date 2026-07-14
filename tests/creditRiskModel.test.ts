import assert from 'node:assert/strict';
import test from 'node:test';
import type { Covenant_DB, FinancialStatement_DB } from '../src/db/index';
import { evaluateCovenantForStatement, evaluateFormula } from '../src/lib/financialMetrics';
import { parseNullableFinancialNumber } from '../src/lib/numberParsing';
import {
  buildCreditRiskFeatures,
  predictCreditRisk,
  scoreCreditRisk,
  trainCreditRiskModel,
  type CreditRiskFeatures,
} from '../src/lib/creditRiskModel';

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

function statement(period: string, periodDate: string, values: Partial<FinancialStatement_DB['mappedData']>): FinancialStatement_DB {
  return {
    id: period,
    clientId: 'client-1',
    period,
    periodDate,
    uploadDate: `${periodDate}T00:00:00.000Z`,
    fileName: `${period}.xlsx`,
    rawLineItems: [],
    mappedData: mapped(values),
    extraAccounts: [],
  };
}

const dscrCovenant: Covenant_DB = {
  id: 'cov-1',
  clientId: 'client-1',
  name: 'DSCR minimo',
  type: 'financial',
  formula: 'ratio:ebitda/interestExpense',
  threshold: '1.25',
  operator: 'gte',
  description: '',
  isCustom: false,
  createdAt: '2026-01-01T00:00:00.000Z',
};

test('financial parser normalizes accounting and locale-specific values', () => {
  assert.equal(parseNullableFinancialNumber('($1,234.50)'), -1234.5);
  assert.equal(parseNullableFinancialNumber('MXN 1.234,50'), 1234.5);
  assert.equal(parseNullableFinancialNumber(''), null);
});

test('covenant calculation detects a DSCR breach', () => {
  const weak = statement('2026-Q1', '2026-03-31', {
    ebitda: 900,
    interestExpense: 1000,
  });

  const result = evaluateCovenantForStatement(dscrCovenant, weak);

  assert.equal(result.value, 0.9);
  assert.equal(result.status, 'incumple');
});

test('formula evaluation treats missing references as zero but keeps zero denominators invalid', () => {
  const stmt = statement('2026-Q2', '2026-06-30', {
    ebitda: 100,
  });

  assert.equal(evaluateFormula('expr:["ref:ebitda","+","ref:totalDebt"]', stmt), 100);
  assert.equal(evaluateFormula('ratio:totalDebt/ebitda', stmt), 0);
  assert.equal(evaluateFormula('ratio:ebitda/totalDebt', stmt), null);
});

test('credit risk model builds features from financial statements and covenants', () => {
  const statements = [
    statement('2025-Q4', '2025-12-31', {
      revenue: 10000,
      ebitda: 2400,
      interestExpense: 900,
      totalDebt: 7000,
      currentAssets: 3500,
      currentLiabilities: 2000,
      totalAssets: 12000,
      equity: 3600,
    }),
    statement('2026-Q1', '2026-03-31', {
      revenue: 8000,
      ebitda: 900,
      interestExpense: 1000,
      totalDebt: 6500,
      currentAssets: 2500,
      currentLiabilities: 2600,
      totalAssets: 11500,
      equity: 1800,
    }),
  ];

  const features = buildCreditRiskFeatures(statements, [dscrCovenant]);
  const prediction = predictCreditRisk(statements, [dscrCovenant]);

  assert.equal(features.dscr, 0.9);
  assert.equal(features.covenantBreachRate, 1);
  assert.equal(features.revenueGrowth, -0.2);
  assert.equal(prediction.riskBand, 'high');
  assert.ok(prediction.drivers.some(driver => driver.includes('covenants')));
});

test('trainable logistic model separates stronger and weaker credits', () => {
  const strong: CreditRiskFeatures = {
    dscr: 2.4,
    debtEbitda: 1.8,
    currentRatio: 1.8,
    capitalization: 0.42,
    pastDuePortfolio: 0.015,
    revenueGrowth: 0.18,
    ebitdaMargin: 0.28,
    covenantBreachRate: 0,
    covenantWarningRate: 0,
  };
  const weak: CreditRiskFeatures = {
    dscr: 0.75,
    debtEbitda: 6.4,
    currentRatio: 0.82,
    capitalization: 0.11,
    pastDuePortfolio: 0.16,
    revenueGrowth: -0.22,
    ebitdaMargin: 0.07,
    covenantBreachRate: 0.75,
    covenantWarningRate: 0.25,
  };

  const weights = trainCreditRiskModel([
    { features: strong, defaulted: false },
    { features: { ...strong, dscr: 1.9, revenueGrowth: 0.05 }, defaulted: false },
    { features: weak, defaulted: true },
    { features: { ...weak, debtEbitda: 5.5, covenantBreachRate: 0.5 }, defaulted: true },
  ]);

  const strongPrediction = scoreCreditRisk(strong, weights);
  const weakPrediction = scoreCreditRisk(weak, weights);

  assert.ok(weakPrediction.probabilityOfDefault > strongPrediction.probabilityOfDefault + 0.5);
  assert.equal(strongPrediction.riskBand, 'low');
  assert.equal(weakPrediction.riskBand, 'high');
});
