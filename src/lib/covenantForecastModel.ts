import type { Covenant_DB, FinancialStatement_DB } from '../db/index';
import { covenantPerformanceHistory, resolveCovenantThreshold } from './financialMetrics';

export type CovenantTrend = 'mejorando' | 'deteriorando' | 'estable';
export type CovenantForecastConfidence = 'baja' | 'media' | 'alta';

export interface CovenantForecast {
  covenantId: string;
  covenantName: string;
  periodsUsed: number;
  lastValue: number;
  predictedNextValue: number;
  threshold: number;
  trend: CovenantTrend;
  breachProbability: number;
  confidence: CovenantForecastConfidence;
}

const MIN_HISTORY_POINTS = 3;

interface RegressionFit {
  slope: number;
  intercept: number;
  residualStd: number;
}

function linearRegression(points: Array<{ x: number; y: number }>): RegressionFit {
  const n = points.length;
  const sumX = points.reduce((sum, p) => sum + p.x, 0);
  const sumY = points.reduce((sum, p) => sum + p.y, 0);
  const sumXY = points.reduce((sum, p) => sum + p.x * p.y, 0);
  const sumXX = points.reduce((sum, p) => sum + p.x * p.x, 0);
  const denominator = n * sumXX - sumX * sumX;
  const slope = denominator === 0 ? 0 : (n * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / n;
  const residuals = points.map(p => p.y - (slope * p.x + intercept));
  const residualVariance = residuals.reduce((sum, r) => sum + r * r, 0) / Math.max(1, n - 2);
  return { slope, intercept, residualStd: Math.sqrt(Math.max(0, residualVariance)) };
}

// Abramowitz-Stegun rational approximation of the standard normal CDF —
// avoids pulling in a stats library for one function.
function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (z > 0) p = 1 - p;
  return p;
}

export function forecastCovenant(cov: Covenant_DB, statements: FinancialStatement_DB[]): CovenantForecast | null {
  if (cov.type !== 'financial' || cov.operator === 'none') return null;
  const threshold = resolveCovenantThreshold(cov);
  if (threshold === null) return null;

  const history = covenantPerformanceHistory(cov, statements).filter(row => row.value !== null);
  if (history.length < MIN_HISTORY_POINTS) return null;

  const points = history.map((row, index) => ({ x: index, y: row.value as number }));
  const { slope, intercept, residualStd } = linearRegression(points);
  const nextX = points.length;
  const predictedNextValue = slope * nextX + intercept;
  const lastValue = points[points.length - 1].y;

  // Compliant direction: +1 means "higher is better" (gte/gt), -1 means "lower is better" (lte/lt).
  const directionSign = cov.operator === 'gte' || cov.operator === 'gt' ? 1 : -1;
  const sigma = residualStd > 0 ? residualStd : Math.max(Math.abs(predictedNextValue) * 0.05, 0.001);
  const z = (directionSign * (predictedNextValue - threshold)) / sigma;
  const rawBreachProbability = Math.min(1, Math.max(0, 1 - normalCdf(z)));

  // Shrink toward 50% when the history is short: a straight line through 3–4
  // points can otherwise report a near-certain (or near-impossible) breach with
  // false precision. The shrinkage factor grows from 0.625 at the 3-point
  // minimum to 1.0 (no shrinkage) at 6+ points, so more history earns a more
  // confident number.
  const historyWeight = Math.min(1, Math.max(0, (points.length - MIN_HISTORY_POINTS + 1) / 4));
  const shrinkage = 0.5 + 0.5 * historyWeight;
  const breachProbability = 0.5 + (rawBreachProbability - 0.5) * shrinkage;

  const trend: CovenantTrend =
    directionSign * slope > 1e-6 ? 'mejorando' :
    directionSign * slope < -1e-6 ? 'deteriorando' :
    'estable';

  return {
    covenantId: cov.id,
    covenantName: cov.name,
    periodsUsed: points.length,
    lastValue,
    predictedNextValue,
    threshold,
    trend,
    breachProbability,
    confidence: points.length >= 6 ? 'alta' : points.length >= 4 ? 'media' : 'baja',
  };
}

export function forecastCovenants(covenants: Covenant_DB[], statements: FinancialStatement_DB[]): CovenantForecast[] {
  return covenants
    .map(cov => forecastCovenant(cov, statements))
    .filter((forecast): forecast is CovenantForecast => forecast !== null)
    .sort((a, b) => b.breachProbability - a.breachProbability);
}
