// Costo del fondeo estimado con los estados financieros (Pasivos Institucionales). Regla general para todos los clientes.
//
//  R1. Gasto del fondeo = gasto por intereses del estado de resultados (getMetric 'interestExpense'). No incluye comisiones
//      pagadas ni otros gastos: es el costo financiero de la deuda.
//  R2. Gasto DEL PERIODO: si el ER es mensual, es el del mes. Si es acumulado (ene→mes), se resta el acumulado del estado
//      anterior del mismo año (jul − jun = gasto de julio); sin anterior, se usa el acumulado entre sus meses (promedio).
//  R3. Saldo de fondeo: el de la segregación del pasivo (historial) si existe para ese mes; si no, la deuda con costo del
//      balance (getMetric 'totalDebt'). Se usa el PROMEDIO entre el saldo inicial y final del periodo.
//  R4. Costo implícito anual = gasto del periodo ÷ meses × 12 ÷ saldo promedio. Fuera de 3%-60% se marca para revisión
//      (el gasto puede traer otros conceptos o la deuda estar incompleta).
//  R5. Gasto anual: últimos 12 meses si los estados los cubren; si no, el último periodo anualizado.
//  R6. Por fondeador: si el pasivo trae tasa contractual, gasto = tasa × saldo; el gasto restante se reparte entre los
//      fondeadores SIN tasa en proporción a su saldo (tasa implícita común). Es una aproximación y se dice así.

import type { FinancialStatement_DB, InstitutionalLiability_DB } from '../db/index';
import { getMetric, incomeSpan } from './financialMetrics';
import type { LiabilitySnapshot } from './liabilityHistory';

export const FUNDING_COST_BOUNDS = { min: 0.03, max: 0.6 } as const;

export interface FundingCostPeriod {
  cutoff: string;
  months: number;               // meses que cubre el gasto del periodo
  basis: string;                // mensual / acumulado / diferencia de acumulados
  periodExpense: number;        // gasto por intereses del periodo
  annualizedExpense: number;
  debtStart: number | null;
  debtEnd: number | null;
  avgDebt: number | null;
  debtSource: 'segregación' | 'balance';
  rate: number | null;          // costo implícito anual
  flag: string | null;
}

export interface LenderCost { lender: string; balance: number; rate: number | null; annualCost: number | null; source: 'contrato' | 'implícita' | 'sin dato' }

export interface FundingCostAnalysis {
  periods: FundingCostPeriod[];
  unexplained: number | null;
  latest: FundingCostPeriod | null;
  annualExpense: number | null;
  annualBasis: string;
  byLender: LenderCost[];
  notes: string[];
}

const ym = (d: string) => d.slice(0, 7);
const monthOf = (d: string) => Number(d.slice(5, 7));

export function analyzeFundingCost(
  statements: FinancialStatement_DB[],
  snapshots: LiabilitySnapshot[] = [],
  liabilities: InstitutionalLiability_DB[] = [],
): FundingCostAnalysis {
  const sts = [...statements].filter(s => s.periodDate).sort((a, b) => a.periodDate.localeCompare(b.periodDate));
  const snapTotal = (d: string) => {
    const s = snapshots.find(x => ym(x.cutoff) === ym(d));
    return s ? s.lines.reduce((a, l) => a + (l.balance || 0), 0) : null;
  };
  const debtAt = (st: FinancialStatement_DB): { value: number | null; source: FundingCostPeriod['debtSource'] } => {
    const seg = snapTotal(st.periodDate);
    if (seg !== null) return { value: seg, source: 'segregación' };
    const d = getMetric(st, 'totalDebt');
    return { value: d === null ? null : Math.abs(d), source: 'balance' };
  };

  const periods: FundingCostPeriod[] = [];
  sts.forEach((st, i) => {
    const raw = getMetric(st, 'interestExpense');
    if (raw === null) return;
    const exp = Math.abs(raw);
    const span = incomeSpan(st, sts);
    const prev = i > 0 ? sts[i - 1] : null;
    let months = span.months; let periodExpense = exp; let basis = span.basis;
    // R2: acumulado − acumulado anterior del mismo año.
    if (span.months > 1 && prev && prev.periodDate.slice(0, 4) === st.periodDate.slice(0, 4) && monthOf(prev.periodDate) < monthOf(st.periodDate)) {
      const prevSpan = incomeSpan(prev, sts);
      const prevExp = getMetric(prev, 'interestExpense');
      // Enero acumulado = 1 mes: también sirve de base para febrero.
      const prevIsYtd = /acumul|anual/.test(prevSpan.basis) || prevSpan.months > 1;
      if (prevExp !== null && prevIsYtd && Math.abs(prevExp) <= exp) {
        months = monthOf(st.periodDate) - monthOf(prev.periodDate);
        periodExpense = exp - Math.abs(prevExp);
        basis = `diferencia de acumulados (${prev.periodDate} → ${st.periodDate})`;
      }
    }
    const end = debtAt(st);
    // Saldo inicial = el del estado anterior si es contiguo al periodo; si no, el final.
    const contiguous = prev && (Number(st.periodDate.slice(0, 4)) * 12 + monthOf(st.periodDate)) - (Number(prev.periodDate.slice(0, 4)) * 12 + monthOf(prev.periodDate)) === months;
    const start = contiguous && prev ? debtAt(prev).value : null;
    const avg = end.value === null ? start : start === null ? end.value : (start + end.value) / 2;
    const annualized = (periodExpense / months) * 12;
    const rate = avg && avg > 0 ? annualized / avg : null;
    const flag = rate === null ? 'Sin saldo de fondeo para calcular el costo'
      : rate < FUNDING_COST_BOUNDS.min ? 'Costo muy bajo: el gasto por intereses podría estar incompleto o la deuda incluir pasivos sin costo'
      : rate > FUNDING_COST_BOUNDS.max ? 'Costo muy alto: el gasto podría incluir otros conceptos o la deuda estar incompleta'
      : null;
    periods.push({ cutoff: st.periodDate, months, basis, periodExpense, annualizedExpense: annualized, debtStart: start, debtEnd: end.value, avgDebt: avg, debtSource: end.source, rate, flag });
  });

  const latest = periods.at(-1) || null;
  // R5: últimos 12 meses cubiertos por periodos consecutivos.
  let annualExpense: number | null = null; let annualBasis = '';
  if (latest) {
    let covered = 0; let sum = 0;
    for (let i = periods.length - 1; i >= 0 && covered < 12; i--) { covered += periods[i].months; sum += periods[i].periodExpense; }
    if (covered === 12) { annualExpense = sum; annualBasis = 'últimos 12 meses'; }
    else { annualExpense = latest.annualizedExpense; annualBasis = `${latest.months === 1 ? 'último mes' : `últimos ${latest.months} meses`} anualizado`; }
  }

  // R6: reparto por fondeador.
  const lastSnap = [...snapshots].sort((a, b) => a.cutoff.localeCompare(b.cutoff)).at(-1);
  const base = lastSnap
    ? lastSnap.lines.map(l => ({ lender: l.lender, balance: l.balance }))
    : liabilities.filter(l => (l.currentBalance || 0) > 0).map(l => ({ lender: l.lenderName, balance: l.currentBalance as number }));
  const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const contractRate = (lender: string) => liabilities.find(l => norm(l.lenderName) === norm(lender))?.interestRate ?? null;
  const known = base.map(b => ({ ...b, rate: contractRate(b.lender) }));
  const knownCost = known.filter(k => k.rate !== null).reduce((a, k) => a + (k.rate as number) * k.balance, 0);
  const unknownBal = known.filter(k => k.rate === null).reduce((a, k) => a + k.balance, 0);
  const residual = latest ? latest.annualizedExpense - knownCost : null;
  let impliedForUnknown = residual !== null && unknownBal > 0 && residual > 0 ? residual / unknownBal : null;
  // Si el remanente implica una tasa irreal para los fondeadores sin contrato, no se les carga: usan la tasa combinada del
  // periodo y el excedente se reporta como gasto no explicado por las tasas de contrato.
  let unexplained: number | null = null;
  if (impliedForUnknown !== null && impliedForUnknown > FUNDING_COST_BOUNDS.max && latest?.rate) {
    unexplained = (residual as number) - latest.rate * unknownBal;
    impliedForUnknown = latest.rate;
  }
  const byLender: LenderCost[] = known.map(k => k.rate !== null
    ? { lender: k.lender, balance: k.balance, rate: k.rate, annualCost: k.rate * k.balance, source: 'contrato' as const }
    : { lender: k.lender, balance: k.balance, rate: impliedForUnknown, annualCost: impliedForUnknown !== null ? impliedForUnknown * k.balance : null, source: impliedForUnknown !== null ? 'implícita' as const : 'sin dato' as const });

  const notes: string[] = [];
  if (!periods.length) notes.push('Los estados financieros no traen gasto por intereses: no se puede estimar el costo del fondeo.');
  if (latest?.flag) notes.push(`${latest.cutoff}: ${latest.flag}.`);
  if (residual !== null && residual < 0) notes.push('El costo de las tasas contractuales supera el gasto por intereses del estado: revisar tasas o el gasto reportado.');
  if (unexplained !== null && unexplained > 0 && latest) {
    notes.push(`Gasto no explicado por las tasas de contrato: ~$${(unexplained / 1e6).toLocaleString('es-MX', { maximumFractionDigits: 2 })}M anuales (${((unexplained / latest.annualizedExpense) * 100).toFixed(0)}% del gasto). Puede ser comisión de la línea, un saldo promedio mayor o deuda no registrada.`);
  }
  if (byLender.some(b => b.source === 'implícita')) notes.push('Los fondeadores sin tasa de contrato usan la tasa implícita del estado (aproximación); con el contrato se reemplaza por la tasa real.');
  return { periods, latest, annualExpense, annualBasis, byLender, notes, unexplained };
}
