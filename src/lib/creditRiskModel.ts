import type { Covenant_DB, FinancialStatement_DB } from '../db/index';
import { evaluateCovenantForStatement, getMetric, standardRatios } from './financialMetrics';

export type CreditRiskBand = 'low' | 'medium' | 'high';

export interface CreditRiskFeatures {
  dscr: number | null;
  debtEbitda: number | null;
  currentRatio: number | null;
  capitalization: number | null;
  pastDuePortfolio: number | null;
  revenueGrowth: number | null;
  ebitdaMargin: number | null;
  covenantBreachRate: number;
  covenantWarningRate: number;
}

export interface CreditRiskPrediction {
  probabilityOfDefault: number;
  riskBand: CreditRiskBand;
  score: number;
  features: CreditRiskFeatures;
  drivers: string[];
}

export interface CreditRiskTrainingSample {
  features: CreditRiskFeatures;
  defaulted: boolean;
}

export interface CreditRiskModelWeights {
  intercept: number;
  dscr: number;
  debtEbitda: number;
  currentRatio: number;
  capitalization: number;
  pastDuePortfolio: number;
  revenueGrowth: number;
  ebitdaMargin: number;
  covenantBreachRate: number;
  covenantWarningRate: number;
}

const FEATURE_KEYS: Array<keyof CreditRiskFeatures> = [
  'dscr',
  'debtEbitda',
  'currentRatio',
  'capitalization',
  'pastDuePortfolio',
  'revenueGrowth',
  'ebitdaMargin',
  'covenantBreachRate',
  'covenantWarningRate',
];

export const DEFAULT_CREDIT_RISK_WEIGHTS: CreditRiskModelWeights = {
  intercept: -0.85,
  dscr: -0.8,
  debtEbitda: 0.55,
  currentRatio: -0.35,
  capitalization: -0.9,
  pastDuePortfolio: 1.2,
  revenueGrowth: -0.45,
  ebitdaMargin: -0.55,
  covenantBreachRate: 1.7,
  covenantWarningRate: 0.85,
};

function latestStatement(statements: FinancialStatement_DB[]): FinancialStatement_DB | null {
  return [...statements].sort((a, b) => a.periodDate.localeCompare(b.periodDate)).at(-1) || null;
}

function previousStatement(statements: FinancialStatement_DB[], latest: FinancialStatement_DB): FinancialStatement_DB | null {
  return [...statements]
    .filter(stmt => stmt.periodDate < latest.periodDate)
    .sort((a, b) => a.periodDate.localeCompare(b.periodDate))
    .at(-1) || null;
}

function ratioValue(stmt: FinancialStatement_DB, key: string): number | null {
  return standardRatios(stmt).find(ratio => ratio.key === key)?.value ?? null;
}

function growth(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0) return null;
  return (current - previous) / Math.abs(previous);
}

function divide(a: number | null, b: number | null): number | null {
  if (a === null || b === null || b === 0) return null;
  return a / b;
}

export function buildCreditRiskFeatures(
  statements: FinancialStatement_DB[],
  covenants: Covenant_DB[] = [],
): CreditRiskFeatures {
  const latest = latestStatement(statements);
  if (!latest) {
    return {
      dscr: null,
      debtEbitda: null,
      currentRatio: null,
      capitalization: null,
      pastDuePortfolio: null,
      revenueGrowth: null,
      ebitdaMargin: null,
      covenantBreachRate: 0,
      covenantWarningRate: 0,
    };
  }

  const previous = previousStatement(statements, latest);
  const covenantResults = covenants
    .filter(cov => cov.type === 'financial')
    .map(cov => evaluateCovenantForStatement(cov, latest));
  const covenantCount = Math.max(covenantResults.length, 1);

  return {
    dscr: ratioValue(latest, 'dscr'),
    debtEbitda: ratioValue(latest, 'debt_ebitda'),
    currentRatio: ratioValue(latest, 'current_ratio'),
    capitalization: ratioValue(latest, 'capitalization'),
    pastDuePortfolio: ratioValue(latest, 'past_due_portfolio'),
    revenueGrowth: growth(getMetric(latest, 'revenue'), previous ? getMetric(previous, 'revenue') : null),
    ebitdaMargin: divide(getMetric(latest, 'ebitda'), getMetric(latest, 'revenue')),
    covenantBreachRate: covenantResults.filter(result => result.status === 'incumple').length / covenantCount,
    covenantWarningRate: covenantResults.filter(result => result.status === 'alerta').length / covenantCount,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-clamp(value, -40, 40)));
}

function featureValue(features: CreditRiskFeatures, key: keyof CreditRiskFeatures): number {
  const raw = features[key];
  if (raw === null || !Number.isFinite(raw)) return 0;
  if (key === 'debtEbitda') return clamp(raw / 4, -2, 3);
  if (key === 'dscr') return clamp(raw / 1.5, -2, 3);
  if (key === 'currentRatio') return clamp(raw / 1.2, -2, 3);
  if (key === 'capitalization') return clamp(raw / 0.25, -2, 3);
  if (key === 'pastDuePortfolio') return clamp(raw / 0.08, -2, 3);
  if (key === 'revenueGrowth') return clamp(raw / 0.15, -3, 3);
  if (key === 'ebitdaMargin') return clamp(raw / 0.18, -3, 3);
  return clamp(raw, 0, 1);
}

function logit(features: CreditRiskFeatures, weights: CreditRiskModelWeights): number {
  return FEATURE_KEYS.reduce(
    (sum, key) => sum + weights[key] * featureValue(features, key),
    weights.intercept,
  );
}

export function scoreCreditRisk(
  features: CreditRiskFeatures,
  weights: CreditRiskModelWeights = DEFAULT_CREDIT_RISK_WEIGHTS,
): CreditRiskPrediction {
  const probabilityOfDefault = sigmoid(logit(features, weights));
  const score = Math.round((1 - probabilityOfDefault) * 1000);
  const riskBand: CreditRiskBand =
    probabilityOfDefault >= 0.35 ? 'high' :
    probabilityOfDefault >= 0.15 ? 'medium' :
    'low';

  const drivers = [
    features.covenantBreachRate > 0 ? `${Math.round(features.covenantBreachRate * 100)}% of tested covenants are breached` : '',
    features.dscr !== null && features.dscr < 1.25 ? `DSCR is tight at ${features.dscr.toFixed(2)}x` : '',
    features.debtEbitda !== null && features.debtEbitda > 4 ? `Debt/EBITDA is elevated at ${features.debtEbitda.toFixed(2)}x` : '',
    features.pastDuePortfolio !== null && features.pastDuePortfolio > 0.08 ? `Past due portfolio is ${Math.round(features.pastDuePortfolio * 100)}%` : '',
    features.revenueGrowth !== null && features.revenueGrowth < -0.1 ? `Revenue declined ${Math.round(Math.abs(features.revenueGrowth) * 100)}%` : '',
  ].filter(Boolean);

  return {
    probabilityOfDefault,
    riskBand,
    score,
    features,
    drivers: drivers.length ? drivers : ['No single risk driver dominates the model output'],
  };
}

export function predictCreditRisk(
  statements: FinancialStatement_DB[],
  covenants: Covenant_DB[] = [],
  weights: CreditRiskModelWeights = DEFAULT_CREDIT_RISK_WEIGHTS,
): CreditRiskPrediction {
  return scoreCreditRisk(buildCreditRiskFeatures(statements, covenants), weights);
}

export function trainCreditRiskModel(
  samples: CreditRiskTrainingSample[],
  options: { learningRate?: number; iterations?: number; l2?: number } = {},
): CreditRiskModelWeights {
  const learningRate = options.learningRate ?? 0.08;
  const iterations = options.iterations ?? 1200;
  const l2 = options.l2 ?? 0.002;
  const weights: CreditRiskModelWeights = { ...DEFAULT_CREDIT_RISK_WEIGHTS };
  if (!samples.length) return weights;

  for (let iteration = 0; iteration < iterations; iteration++) {
    const gradients: CreditRiskModelWeights = {
      intercept: 0,
      dscr: 0,
      debtEbitda: 0,
      currentRatio: 0,
      capitalization: 0,
      pastDuePortfolio: 0,
      revenueGrowth: 0,
      ebitdaMargin: 0,
      covenantBreachRate: 0,
      covenantWarningRate: 0,
    };

    for (const sample of samples) {
      const prediction = sigmoid(logit(sample.features, weights));
      const error = prediction - (sample.defaulted ? 1 : 0);
      gradients.intercept += error;
      for (const key of FEATURE_KEYS) gradients[key] += error * featureValue(sample.features, key);
    }

    weights.intercept -= learningRate * gradients.intercept / samples.length;
    for (const key of FEATURE_KEYS) {
      weights[key] -= learningRate * ((gradients[key] / samples.length) + l2 * weights[key]);
    }
  }

  return weights;
}
