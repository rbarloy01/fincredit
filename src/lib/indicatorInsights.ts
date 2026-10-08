// Analyst favorites + insights + formula map for the "Indicadores Financieros" panel.
//
//  - Favorites are stored per analyst (not per client) by a stable indicator key, so a star on "ICAP" follows the analyst across clients.
//  - Insights read the whole history of each favorite (streaks, headroom to the limit, forecast) instead of only last vs previous.
//  - The formula map shows, for the latest statement, every input of every formula and its value. A formula input without data is
//    evaluated as 0 (that is how custom formulas work), so the map says so explicitly instead of letting a wrong ratio pass.

import type { Covenant_DB, FinancialStatement_DB } from '../db/index';
import {
  annualizedStandardKey, covenantDirection, covenantPerformanceHistory, evaluateFormula, formulaLabel, getMetric, metricLabels, resolveCovenantThreshold,
  type CovenantPeriodPerformance,
} from './financialMetrics';
import { forecastCovenant, type CovenantForecast } from './covenantForecastModel';

export const FAVORITES_SETTING_PREFIX = 'finmonitor_fav_indicators_';
export const favoritesSettingKey = (userId: string) => `${FAVORITES_SETTING_PREFIX}${userId}`;
export const favoritesDefaultKey = (userId: string) => `finmonitor_fav_default_${userId}`;

const plain = (v: string) => v.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
export const indicatorKey = (cov: Pick<Covenant_DB, 'name'>) => `name:${plain(cov.name)}`;

export function toggleFavorite(favorites: string[], key: string): string[] {
  return favorites.includes(key) ? favorites.filter(k => k !== key) : [...favorites, key];
}

// ── Formula map ─────────────────────────────────────────────────────────────────────────────────────────────────────
const FLOW_REFS = new Set(['revenue', 'interestIncome', 'feeIncome', 'coreBusinessIncome', 'adjustedFinancialMargin', 'adjustedOperatingIncome', 'adminSellingOperatingExpenses', 'ebitda', 'interestExpense', 'netIncome']);
const BALANCE_REFS = new Set(['currentAssets', 'currentLiabilities', 'totalDebt', 'banksFundsShortTerm', 'banksFundsLongTerm', 'totalLiabilities', 'totalAssets', 'equity', 'cash', 'availableInvestments', 'loanPortfolio', 'netPortfolio', 'managedPortfolio', 'pastDuePortfolio', 'loanLossReserves', 'productiveAssets']);

export interface FormulaInput { ref: string; label: string; kind: 'métrica' | 'cuenta' | 'concepto'; value: number | null; missing: boolean }
export interface FormulaExplanation {
  text: string;
  kind: 'ratio' | 'expresión' | 'texto libre';
  inputs: FormulaInput[];
  missing: string[];                 // labels of inputs with no data
  result: number | null;
  notes: string[];                   // data-quality and comparability warnings
  severity: 'ok' | 'aviso' | 'error';
}

function refsOf(formula: string): string[] {
  if (formula.startsWith('ratio:')) return formula.slice('ratio:'.length).split('/').filter(Boolean);
  if (formula.startsWith('expr:')) {
    try { return (JSON.parse(formula.slice('expr:'.length)) as string[]).filter(t => t.startsWith('ref:')).map(t => t.slice(4)); } catch { return []; }
  }
  return [];
}

export function explainFormula(cov: Pick<Covenant_DB, 'formula' | 'operator' | 'threshold' | 'name'>, stmt: FinancialStatement_DB | undefined, labels: Record<string, string> = {}): FormulaExplanation {
  const formula = (cov.formula || cov.name || '').trim();
  const kind: FormulaExplanation['kind'] = formula.startsWith('ratio:') ? 'ratio' : formula.startsWith('expr:') ? 'expresión' : 'texto libre';
  const label = (ref: string) => labels[ref] || metricLabels[ref] || ref;
  const unique = [...new Set(refsOf(formula))];
  const inputs: FormulaInput[] = unique.map(ref => {
    const value = stmt ? getMetric(stmt, ref) : null;
    return { ref, label: label(ref), kind: ref.startsWith('account:') ? 'cuenta' : ref.startsWith('concept:') ? 'concepto' : 'métrica', value, missing: value === null };
  });
  const notes: string[] = [];
  let severity: FormulaExplanation['severity'] = 'ok';
  const missing = inputs.filter(i => i.missing).map(i => i.label);
  const result = stmt ? evaluateFormula(formula, stmt) : null;

  if (kind === 'texto libre') {
    notes.push('Fórmula en texto libre: se interpreta por palabras clave. Conviértela a una fórmula con cuentas mapeadas para que sea auditable.');
    severity = 'aviso';
  }
  if (missing.length) {
    notes.push(`Sin dato en el último corte: ${missing.join(', ')}. La fórmula lo toma como 0, así que el resultado puede estar mal.`);
    severity = 'error';
  }
  if (stmt && result === null && !missing.length && kind !== 'texto libre') {
    notes.push('No se puede calcular (división entre 0 o expresión incompleta).');
    severity = severity === 'ok' ? 'aviso' : severity;
  }
  const hasFlow = unique.some(r => FLOW_REFS.has(r));
  const hasBalance = unique.some(r => BALANCE_REFS.has(r));
  const hasLimit = cov.operator !== 'none' && resolveCovenantThreshold(cov as Covenant_DB) !== null;
  const standardKey = annualizedStandardKey(formula);
  if (standardKey) {
    notes.push(hasLimit
      ? 'Mezcla flujo del estado de resultados con saldo. Con límite de contrato se mide literal (periodo acumulado sin anualizar): no es comparable contra un cierre de 12 meses.'
      : 'Mezcla flujo con saldo: se anualiza según los meses del periodo para poder compararlo entre cortes.');
  } else if (hasFlow && hasBalance) {
    notes.push('Mezcla flujo del estado de resultados con saldo y no se anualiza: en periodos acumulados no es comparable entre cortes.');
    if (severity === 'ok') severity = 'aviso';
  }
  return { text: formulaLabel(formula, labels), kind, inputs, missing, result, notes, severity };
}

// ── Favorite insights ───────────────────────────────────────────────────────────────────────────────────────────────
export type FavoriteSeverity = 'critico' | 'atencion' | 'ok' | 'sin_dato';

export interface FavoriteInsight {
  key: string;
  covenantId: string;
  name: string;
  period: string;
  value: number | null;
  previousValue: number | null;
  status: CovenantPeriodPerformance['status'];
  movement: CovenantPeriodPerformance['movement'];
  series: Array<{ period: string; value: number | null }>;      // last 6 periods
  streak: { direction: 'empeora' | 'mejora' | null; length: number };
  vsAverage: number | null;                                     // change vs the average of the previous periods (fraction)
  headroom: number | null;                                      // signed distance to the limit, positive = on the safe side
  forecast: CovenantForecast | null;
  severity: FavoriteSeverity;
  lines: string[];
}

export type ValueFormatter = (value: number | null, cov: Covenant_DB) => string;
const OPERATOR_SYMBOL: Record<string, string> = { gte: '≥', gt: '>', lte: '≤', lt: '<' };
const defaultFormat: ValueFormatter = value => (value === null ? 'N/D' : Math.abs(value) < 5 ? `${(value * 100).toFixed(1)}%` : value.toFixed(2));

export function buildFavoriteInsights(
  covenants: Covenant_DB[],
  statements: FinancialStatement_DB[],
  favorites: string[],
  fmt: ValueFormatter = defaultFormat,
  monitored = true,
): FavoriteInsight[] {
  const ordered = [...statements].sort((a, b) => a.periodDate.localeCompare(b.periodDate));
  const latest = ordered.at(-1);
  const out: FavoriteInsight[] = [];
  for (const key of favorites) {
    const cov = covenants.find(c => indicatorKey(c) === key);
    if (!cov || cov.type !== 'financial') continue;
    const history = covenantPerformanceHistory(cov, ordered);
    const last = history.at(-1);
    if (!last) continue;
    const withValue = history.filter(r => r.value !== null);
    const series = history.slice(-6).map(r => ({ period: r.period, value: r.value }));

    let streakLen = 0;
    let streakDir: 'empeora' | 'mejora' | null = null;
    for (let i = history.length - 1; i >= 0; i--) {
      const m = history[i].movement;
      const dir = m === 'deterioration' ? 'empeora' : m === 'betterment' ? 'mejora' : null;
      if (!dir || (streakDir && dir !== streakDir)) break;
      streakDir = dir; streakLen += 1;
    }

    const prevValues = withValue.slice(0, -1).slice(-5).map(r => r.value as number);
    const avg = prevValues.length >= 2 ? prevValues.reduce((a, b) => a + b, 0) / prevValues.length : null;
    const vsAverage = avg !== null && avg !== 0 && last.value !== null ? (last.value - avg) / Math.abs(avg) : null;

    const threshold = cov.operator === 'none' ? null : resolveCovenantThreshold(cov);
    const direction = covenantDirection(cov);
    let headroom: number | null = null;
    if (threshold !== null && last.value !== null) {
      const higherIsBetter = cov.operator === 'gt' || cov.operator === 'gte' ? true : cov.operator === 'lt' || cov.operator === 'lte' ? false : direction === 'higher';
      headroom = higherIsBetter ? last.value - threshold : threshold - last.value;
    }
    const forecast = monitored ? forecastCovenant(cov, ordered) : null;
    const explanation = explainFormula(cov, latest);

    const lines: string[] = [];
    if (last.value === null) lines.push(`Sin dato en ${last.period}${explanation.missing.length ? `: falta ${explanation.missing.join(', ')}` : ''}. Revisa el mapeo de cuentas.`);
    else {
      if (monitored && last.status === 'incumple') lines.push(`Incumple: ${fmt(last.value, cov)} contra el requisito (${OPERATOR_SYMBOL[cov.operator] || ''} ${cov.threshold}).`);
      else if (monitored && last.status === 'alerta' && headroom !== null) lines.push(`En alerta: a solo ${fmt(Math.abs(headroom), cov)} del límite.`);
      else if (headroom !== null && monitored) lines.push(`Holgura de ${fmt(headroom, cov)} frente al límite.`);
      else if (threshold === null) lines.push('Sin límite capturado: se sigue como tendencia, no como cumplimiento.');
      if (streakDir && streakLen >= 2) lines.push(`${streakLen} cortes consecutivos ${streakDir === 'empeora' ? 'empeorando' : 'mejorando'} (${fmt(history[history.length - 1 - streakLen].value, cov)} → ${fmt(last.value, cov)}).`);
      else if (last.previousValue !== null && last.delta !== null) lines.push(`${last.movementLabel} contra el corte anterior: ${fmt(last.previousValue, cov)} → ${fmt(last.value, cov)}.`);
      if (vsAverage !== null && Math.abs(vsAverage) >= 0.15) lines.push(`${Math.abs(vsAverage * 100).toFixed(0)}% ${vsAverage > 0 ? 'por encima' : 'por debajo'} de su promedio de los ${prevValues.length} cortes previos.`);
      if (forecast && forecast.breachProbability >= 0.4) lines.push(`Pronóstico: ${(forecast.breachProbability * 100).toFixed(0)}% de probabilidad de incumplir el siguiente corte (confianza ${forecast.confidence}, ${forecast.periodsUsed} periodos).`);
      if (explanation.missing.length) lines.push(`Ojo: faltan insumos (${explanation.missing.join(', ')}) y se toman como 0.`);
    }

    const severity: FavoriteSeverity =
      last.value === null ? 'sin_dato'
        : monitored && last.status === 'incumple' ? 'critico'
          : (monitored && last.status === 'alerta') || (streakDir === 'empeora' && streakLen >= 2) || (forecast !== null && forecast.breachProbability >= 0.6) || explanation.severity === 'error' ? 'atencion'
            : 'ok';

    out.push({
      key, covenantId: cov.id, name: cov.name, period: last.period, value: last.value, previousValue: last.previousValue, status: last.status,
      movement: last.movement, series, streak: { direction: streakDir, length: streakLen }, vsAverage, headroom, forecast, severity, lines,
    });
  }
  const rank: Record<FavoriteSeverity, number> = { critico: 0, atencion: 1, sin_dato: 2, ok: 3 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity] || a.name.localeCompare(b.name));
}

export function summarizeFavorites(insights: FavoriteInsight[], analystName = 'el analista'): { headline: string; bullets: string[] } {
  if (!insights.length) return { headline: `${analystName} aún no marca indicadores favoritos.`, bullets: ['Marca con el pin los indicadores que quieres seguir de cerca: aparecerán primero en el storyline con su lectura.'] };
  const count = (s: FavoriteSeverity) => insights.filter(i => i.severity === s).length;
  const period = insights[0].period;
  const parts = [count('critico') ? `${count('critico')} crítico${count('critico') === 1 ? '' : 's'}` : '', count('atencion') ? `${count('atencion')} en atención` : '', count('sin_dato') ? `${count('sin_dato')} sin dato` : '', count('ok') ? `${count('ok')} sin alertas` : ''].filter(Boolean);
  const bullets = insights.filter(i => i.severity !== 'ok').slice(0, 4).map(i => `${i.name}: ${i.lines[0] || 'revisar'}`);
  if (!bullets.length) bullets.push('Todos tus favoritos están dentro de rango y sin deterioros sostenidos.');
  return { headline: `Al ${period}, de tus ${insights.length} favoritos: ${parts.join(', ')}.`, bullets };
}

export function buildFavoritesPrompt(clientName: string, analystName: string, insights: FavoriteInsight[]): string {
  if (!insights.length) return '';
  const rows = insights.map(i => ({ indicador: i.name, periodo: i.period, valor: i.value, anterior: i.previousValue, estatus: i.status, serie: i.series, racha: i.streak, holgura: i.headroom, pronostico: i.forecast && { probabilidadIncumplir: Math.round(i.forecast.breachProbability * 100), confianza: i.forecast.confidence }, lecturaAutomatica: i.lines }));
  return `\n\nINDICADORES FAVORITOS DE ${analystName.toUpperCase()} para ${clientName || 'este cliente'} (dales prioridad en tu análisis y explica la causa probable de cada movimiento):\n${JSON.stringify(rows, null, 2)}`;
}
