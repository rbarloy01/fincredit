// Benchmark context for the AI assistant: how every monitored client compares with the rest of the portfolio.
// It uses the same annualized standard ratios as the Indicadores screen, takes each client's LATEST statement, and gives the
// model cohort statistics (median, quartiles), industry cohorts and a per-client ranking, so it can answer
// "¿cómo está X contra su cohorte?" without recomputing anything.

import type { Client, FinancialStatement_DB } from '../db/index';
import { ratioPolarity, standardRatios } from './financialMetrics';
import { isClientMonitored } from './clientStatus';
import type { ClientContextPack } from './clientContext';

export interface BenchmarkInput { client: Client; statements: FinancialStatement_DB[] }

const KEYS: Array<{ key: string; pct: boolean }> = [
  { key: 'capitalization', pct: true }, { key: 'adjusted_capitalization', pct: true }, { key: 'roa', pct: true }, { key: 'roe', pct: true },
  { key: 'leverage', pct: true }, { key: 'debt_equity', pct: true }, { key: 'debt_ebitda', pct: false }, { key: 'dscr', pct: false }, { key: 'current_ratio', pct: false },
  { key: 'past_due_portfolio', pct: true }, { key: 'past_due_coverage', pct: true }, { key: 'ifnb_financial_margin', pct: true }, { key: 'ifnb_net_margin', pct: true },
  { key: 'ifnb_operating_efficiency', pct: true }, { key: 'portfolio_yield', pct: true }, { key: 'funding_cost', pct: true }, { key: 'financial_spread', pct: true }, { key: 'immediate_liquidity', pct: false },
];
const COHORT_KEYS = ['capitalization', 'roa', 'leverage', 'past_due_portfolio'];
const RANK_KEYS = ['capitalization', 'roa', 'leverage', 'past_due_portfolio'];

const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
export function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = sorted(xs); const idx = (s.length - 1) * p; const lo = Math.floor(idx); const hi = Math.ceil(idx);
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const fmt = (v: number | null, pct: boolean) => (v === null || !Number.isFinite(v) ? 'N/D' : pct ? `${(v * 100).toFixed(1)}%` : `${v.toFixed(2)}x`);
const pctOf = (key: string) => KEYS.find(k => k.key === key)?.pct ?? true;
const mM = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? 'N/D' : `$${(v / 1e6).toLocaleString('es-MX', { maximumFractionDigits: 1 })}M`);

// Share of the cohort that is in a WORSE position than this value (0-100): higher = better placed.
export function placement(values: number[], value: number, key: string): number | null {
  if (values.length < 2) return null;
  const polarity = ratioPolarity(key);
  const worse = values.filter(v => (polarity === 'lower' ? v > value : v < value)).length;
  return Math.round((worse / (values.length - 1)) * 100);
}

interface Snapshot { client: Client; period: string; values: Record<string, number | null>; labels: Record<string, string> }

export function buildBenchmarkContext(inputs: BenchmarkInput[]): ClientContextPack {
  const notes: string[] = [];
  const snaps: Snapshot[] = [];
  // Dormant and terminated clients stay in: their history makes the comparison sample larger and more representative.
  for (const { client, statements } of inputs) {
    const ordered = [...statements].sort((a, b) => a.periodDate.localeCompare(b.periodDate));
    const latest = ordered.at(-1);
    if (!latest) continue;
    const ratios = standardRatios(latest, ordered);
    snaps.push({ client, period: latest.period, values: Object.fromEntries(ratios.map(r => [r.key, r.value])), labels: Object.fromEntries(ratios.map(r => [r.key, r.label])) });
  }
  const lines: string[] = [];
  const paused = snaps.filter(s => !isClientMonitored(s.client)).length;
  lines.push(`Clientes comparados: ${snaps.length} con estados financieros (de ${inputs.length})${paused ? `, de los cuales ${paused} están dormidos o terminados: se incluyen como referencia del benchmark pero no se monitorean ni se marcan en incumplimiento` : ''}.`);
  lines.push('Cada cliente entra con su ÚLTIMO corte (los periodos pueden diferir: se indica por cliente). Los ratios de resultados están anualizados; cuartiles = percentil 25 y 75.');
  lines.push('Lectura: "mejor ubicado" = porcentaje de la muestra que está peor que el cliente (para apalancamiento, cartera vencida y costo de fondeo, menos es mejor).');
  if (snaps.length < 5) notes.push('Menos de 5 clientes con datos: los estadísticos del benchmark son poco robustos.');

  const labelOf = (key: string) => snaps.find(s => s.labels[key])?.labels[key] || key;
  const valuesOf = (key: string, rows = snaps) => rows.map(s => s.values[key]).filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v));

  lines.push('', 'ESTADÍSTICOS DE TODA LA MUESTRA: indicador | n | mediana | promedio | p25 | p75 | mín–máx');
  for (const { key, pct } of KEYS) {
    const xs = valuesOf(key);
    if (!xs.length) continue;
    lines.push(`${labelOf(key)} | ${xs.length} | ${fmt(percentile(xs, 0.5), pct)} | ${fmt(mean(xs), pct)} | ${fmt(percentile(xs, 0.25), pct)} | ${fmt(percentile(xs, 0.75), pct)} | ${fmt(Math.min(...xs), pct)}–${fmt(Math.max(...xs), pct)}`);
  }

  const byIndustry = new Map<string, Snapshot[]>();
  for (const s of snaps) { const k = (s.client.industry || 'Sin industria').trim() || 'Sin industria'; byIndustry.set(k, [...(byIndustry.get(k) || []), s]); }
  const cohorts = [...byIndustry.entries()].filter(([, rows]) => rows.length >= 3).sort((a, b) => b[1].length - a[1].length).slice(0, 6);
  if (cohorts.length) {
    lines.push('', `COHORTES POR INDUSTRIA (≥3 clientes): industria | n | ${COHORT_KEYS.map(labelOf).join(' | ')} (medianas)`);
    for (const [name, rows] of cohorts) lines.push(`${name} | ${rows.length} | ${COHORT_KEYS.map(k => fmt(percentile(valuesOf(k, rows), 0.5), pctOf(k))).join(' | ')}`);
  } else notes.push('Ninguna industria tiene 3 o más clientes: no se arman cohortes por industria, solo la muestra completa.');

  lines.push('', `RANKING POR CLIENTE (hasta 40, por línea): cliente | estatus | corte | línea | ${RANK_KEYS.map(k => `${labelOf(k)} (mejor ubicado %)`).join(' | ')}`);
  [...snaps].sort((a, b) => (b.client.totalCreditValue || 0) - (a.client.totalCreditValue || 0)).slice(0, 40).forEach(s => {
    const cells = RANK_KEYS.map(k => {
      const v = s.values[k];
      if (v === null || v === undefined) return 'N/D';
      const place = placement(valuesOf(k), v, k);
      return `${fmt(v, pctOf(k))}${place === null ? '' : ` (${place}%)`}`;
    });
    lines.push(`${s.client.name} | ${s.client.status || 'activo'} | ${s.period} | ${mM(s.client.totalCreditValue)} | ${cells.join(' | ')}`);
  });
  if (snaps.length > 40) notes.push(`El ranking muestra los 40 clientes con mayor línea de ${snaps.length}.`);
  const noData = inputs.length - snaps.length;
  if (noData > 0) notes.push(`${noData} clientes no tienen estados financieros y no aparecen en el benchmark.`);

  const text = lines.join('\n');
  return { text, approxTokens: Math.ceil(text.length / 3.6), sections: [{ title: 'BENCHMARK', chars: text.length }], notes };
}

export const BENCHMARK_SYSTEM_PROMPT = `Eres un analista de crédito senior de una institución financiera mexicana (Syscap / Axcess).
Respondes preguntas de BENCHMARK: comparar clientes entre sí y contra su cohorte, usando EXCLUSIVAMENTE el bloque "CONTEXTO" que te doy.
Reglas:
1. Cita siempre el tamaño de la muestra (n) y el corte de cada cliente; los periodos pueden diferir entre clientes.
2. Distingue mediana de promedio y usa los cuartiles para decir si un cliente está en el extremo de la muestra.
3. Con menos de 5 observaciones advierte que el estadístico es poco robusto. No inventes datos que no estén en el contexto.
   Los clientes dormidos o terminados forman parte de la muestra como referencia: no los marques en incumplimiento ni los trates como cartera activa.
4. Para apalancamiento, cartera vencida, costo de fondeo y eficiencia menos es mejor; en el resto más es mejor.
5. Si piden el detalle de un cliente (estados, loan tape, indicadores), di que debe seleccionarlo en el selector.
6. Responde en español, directo y breve. Formato: **negritas** para cifras clave, listas con guiones y tablas cortas cuando ayuden; no uses encabezados con # ni bloques de código.`;

export const ALL_SYSTEM_PROMPT = `Eres un analista de crédito senior de una institución financiera mexicana (Syscap / Axcess).
Respondes sobre TODA la cartera de clientes y su benchmark usando EXCLUSIVAMENTE el bloque "CONTEXTO": la ficha de cada cliente (línea, estatus, industria, analista) y el comparativo de indicadores entre clientes.
Reglas:
1. Cita el cliente, el corte y la cifra; con menos de 5 observaciones advierte que el estadístico es poco robusto.
2. Los clientes dormidos o terminados no se monitorean (no los marques en incumplimiento) pero SÍ forman parte del benchmark como referencia; el estatus de cada uno se indica.
3. No tienes estados financieros completos ni loan tapes: si la pregunta los necesita, pide seleccionar ese cliente en el selector.
4. Para apalancamiento, cartera vencida, costo de fondeo y eficiencia menos es mejor; en el resto más es mejor.
5. No inventes datos. Responde en español, directo y breve. Formato: **negritas** para cifras clave, listas con guiones y tablas cortas cuando ayuden; no uses encabezados con # ni bloques de código.`;
