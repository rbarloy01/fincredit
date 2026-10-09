// Logic behind the guided covenant builder: known indicators, how to store the limit, plain-language sentences and a live
// per-period preview computed with the SAME evaluation the app uses once the covenant is saved.

import type { Covenant_DB, FinancialStatement_DB } from '../db/index';
import { evaluateCovenantForStatement, ratioPolarity, standardRatioFormula, standardRatios } from './financialMetrics';
import { explainFormula } from './indicatorInsights';

export type LimitUnit = 'percent' | 'number';
export type LimitKind = 'gte' | 'lte' | 'gt' | 'lt' | 'none';

export interface KnownIndicator { key: string; label: string; group: string; unit: LimitUnit; hint: string }

// The indicators an analyst usually turns into a covenant. Labels must match standardRatios labels (guarded by a test).
export const KNOWN_INDICATORS: KnownIndicator[] = [
  { key: 'capitalization', label: 'ICAP', group: 'Capitalización y solvencia', unit: 'percent', hint: 'Capital contable ÷ activos totales' },
  { key: 'adjusted_capitalization', label: 'ICAP Ajustado', group: 'Capitalización y solvencia', unit: 'percent', hint: 'Capital contable ÷ cartera neta' },
  { key: 'leverage', label: 'Apalancamiento', group: 'Capitalización y solvencia', unit: 'percent', hint: 'Bancos y fondos ÷ activos totales' },
  { key: 'debt_equity', label: 'Deuda / Capital', group: 'Capitalización y solvencia', unit: 'number', hint: 'Deuda total ÷ capital contable' },
  { key: 'debt_ebitda', label: 'Deuda / EBITDA', group: 'Servicio de deuda y liquidez', unit: 'number', hint: 'Deuda total ÷ EBITDA anualizado' },
  { key: 'dscr', label: 'DSCR', group: 'Servicio de deuda y liquidez', unit: 'number', hint: 'EBITDA ÷ gasto financiero' },
  { key: 'current_ratio', label: 'Razón Corriente', group: 'Servicio de deuda y liquidez', unit: 'number', hint: 'Activo corriente ÷ pasivo corriente' },
  { key: 'immediate_liquidity', label: 'Liquidez Inmediata', group: 'Servicio de deuda y liquidez', unit: 'number', hint: 'Efectivo e inversiones ÷ pasivo corriente' },
  { key: 'roa', label: 'ROA', group: 'Rentabilidad', unit: 'percent', hint: 'Utilidad neta ÷ activos totales (anualizado)' },
  { key: 'roe', label: 'ROE', group: 'Rentabilidad', unit: 'percent', hint: 'Utilidad neta ÷ capital contable (anualizado)' },
  { key: 'ifnb_net_margin', label: 'Margen Neto', group: 'Rentabilidad', unit: 'percent', hint: 'Utilidad neta ÷ ingresos del negocio' },
  { key: 'ifnb_financial_margin', label: 'Margen Financiero', group: 'Rentabilidad', unit: 'percent', hint: 'Margen financiero ÷ ingresos del negocio' },
  { key: 'ifnb_operating_efficiency', label: 'Eficiencia Operativa', group: 'Rentabilidad', unit: 'percent', hint: 'Gastos de operación ÷ ingresos del negocio' },
  { key: 'past_due_portfolio', label: 'Cartera Vencida', group: 'Calidad de cartera', unit: 'percent', hint: 'Cartera vencida ÷ cartera administrada' },
  { key: 'net_past_due_portfolio', label: 'Cartera Vencida Neta', group: 'Calidad de cartera', unit: 'percent', hint: '(Cartera vencida − estimación) ÷ cartera' },
  { key: 'past_due_to_equity', label: 'Cartera Vencida / Capital Contable', group: 'Calidad de cartera', unit: 'percent', hint: 'Cartera vencida ÷ capital contable' },
  { key: 'debt_coverage_productive_assets', label: 'Cobertura de Deuda', group: 'Servicio de deuda y liquidez', unit: 'number', hint: 'Activos productivos ÷ total pasivo' },
  { key: 'ifnb_operating_profitability', label: 'Rentabilidad Operativa', group: 'Rentabilidad', unit: 'percent', hint: 'Utilidad de operación ÷ ingresos del negocio' },
  { key: 'past_due_coverage', label: 'Índice de Cobertura de Cartera Vencida', group: 'Calidad de cartera', unit: 'percent', hint: 'Estimación preventiva ÷ cartera vencida' },
  { key: 'portfolio_yield', label: 'Rendimiento de Cartera (Yield)', group: 'Margen y fondeo', unit: 'percent', hint: 'Ingresos por intereses ÷ cartera' },
  { key: 'funding_cost', label: 'Costo de Fondeo Aproximado', group: 'Margen y fondeo', unit: 'percent', hint: 'Gasto financiero ÷ fondeo' },
  { key: 'financial_spread', label: 'Spread Financiero Aproximado', group: 'Margen y fondeo', unit: 'percent', hint: 'Rendimiento de cartera − costo de fondeo' },
];

export const knownIndicatorFormula = (ind: KnownIndicator) => standardRatioFormula(ind.key);
export const knownIndicatorDirection = (ind: KnownIndicator): LimitKind => (ratioPolarity(ind.key) === 'lower' ? 'lte' : 'gte');

// The limit is stored unambiguously: a percent limit is a fraction ("15" → "0.15") so it never depends on the covenant's name.
export function thresholdToStore(input: string, unit: LimitUnit): string {
  const n = Number(String(input).replace(/[%\s,]/g, ''));
  if (!Number.isFinite(n) || String(input).trim() === '') return '';
  if (unit === 'percent') return String(Math.round(n * 1e6) / 1e8);
  return String(n);
}

const KIND_WORDS: Record<Exclude<LimitKind, 'none'>, string> = { gte: 'mayor o igual a', gt: 'mayor que', lte: 'menor o igual a', lt: 'menor que' };
export const limitText = (value: string, unit: LimitUnit) => (value.trim() ? `${value.trim().replace(/%$/, '')}${unit === 'percent' ? '%' : 'x'}` : '…');

export function limitSentence(name: string, kind: LimitKind, value: string, unit: LimitUnit): string {
  const label = name.trim() || 'El indicador';
  if (kind === 'none') return `${label} se registra solo como seguimiento: no tiene límite y nunca se marca en incumplimiento.`;
  return `Cumple si ${label} es ${KIND_WORDS[kind]} ${limitText(value, unit)}. Se marca en alerta cuando queda a menos de 15% del límite.`;
}

export interface BuilderDraft { name: string; formula: string; kind: LimitKind; limit: string; unit: LimitUnit; description?: string }
export interface PreviewRow { period: string; value: number | null; display: string; status: 'cumple' | 'alerta' | 'incumple' | 'sin_limite' | 'sin_dato' }
export interface BuilderPreview { rows: PreviewRow[]; warnings: string[]; computable: boolean }

export const formatUnit = (value: number | null, unit: LimitUnit) => (value === null || !Number.isFinite(value) ? 'sin dato' : unit === 'percent' ? `${(value * 100).toFixed(1)}%` : `${value.toFixed(2)}x`);

export function previewDraft(draft: BuilderDraft, statements: FinancialStatement_DB[], monitored = true, last = 6): BuilderPreview {
  const ordered = [...statements].sort((a, b) => a.periodDate.localeCompare(b.periodDate));
  const warnings: string[] = [];
  if (!draft.formula.trim()) return { rows: [], warnings: ['Aún no hay fórmula.'], computable: false };
  const temp = {
    id: 'preview', clientId: '', name: draft.name || 'Indicador', type: 'financial', formula: draft.formula, operator: draft.kind,
    threshold: draft.kind === 'none' ? '' : thresholdToStore(draft.limit, draft.unit), description: '', isCustom: true, createdAt: '',
  } as unknown as Covenant_DB;
  const rows: PreviewRow[] = ordered.slice(-last).map(stmt => {
    const r = evaluateCovenantForStatement(temp, stmt, ordered);
    const status: PreviewRow['status'] = r.value === null ? 'sin_dato' : draft.kind === 'none' || !temp.threshold ? 'sin_limite' : (monitored ? r.status : 'cumple');
    return { period: stmt.period, value: r.value, display: formatUnit(r.value, draft.unit), status };
  });
  const latest = ordered.at(-1);
  if (latest) {
    const explained = explainFormula(temp, latest);
    if (explained.missing.length) warnings.push(`Sin dato en ${latest.period}: ${explained.missing.join(', ')}. Se tomaría como 0 y el resultado puede estar mal.`);
    if (explained.kind === 'texto libre') warnings.push('Fórmula en texto libre: elige cuentas del estado para que sea auditable.');
  }
  const computable = rows.some(r => r.value !== null);
  if (!ordered.length) warnings.push('El cliente no tiene estados financieros: no se puede probar la fórmula.');
  else if (!computable) warnings.push('La fórmula no da resultado en ningún periodo (división entre 0 o cuentas sin dato).');
  return { rows, warnings, computable };
}

// Standard values at the latest statement, shown on the indicator cards so the analyst sees a real number before choosing.
export function knownIndicatorValues(statements: FinancialStatement_DB[]): Record<string, number | null> {
  const ordered = [...statements].sort((a, b) => a.periodDate.localeCompare(b.periodDate));
  const latest = ordered.at(-1);
  if (!latest) return {};
  return Object.fromEntries(standardRatios(latest, ordered).map(r => [r.key, r.value]));
}

export function draftErrors(draft: BuilderDraft): string[] {
  const errors: string[] = [];
  if (!draft.name.trim()) errors.push('Ponle un nombre al covenant.');
  if (!draft.formula.trim()) errors.push('Define qué se mide.');
  if (draft.kind !== 'none' && !thresholdToStore(draft.limit, draft.unit)) errors.push('Escribe el valor del límite.');
  return errors;
}
