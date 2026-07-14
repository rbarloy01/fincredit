import type { Covenant_DB, FinancialStatement_DB } from '../db/index';
import { findConsolidatedMetricValue, metricAliases } from './accountConsolidation';
import { parseNullableFinancialNumber } from './numberParsing';

export type RatioStatus = 'cumple' | 'alerta' | 'incumple';
export type CovenantMovement = 'betterment' | 'deterioration' | 'stable' | 'new' | 'insufficient';

export interface RatioResult {
  key: string;
  label: string;
  value: number | null;
  formula: string;
  missing: string[];
}

export interface CovenantPeriodPerformance {
  covenantId: string;
  covenantName: string;
  period: string;
  periodDate: string;
  value: number | null;
  previousValue: number | null;
  delta: number | null;
  deltaPct: number | null;
  status: RatioStatus;
  previousStatus: RatioStatus | null;
  movement: CovenantMovement;
  movementLabel: string;
  threshold: string;
  operator: Covenant_DB['operator'];
  formula: string;
}

export interface PrioritizedCovenantPerformance extends CovenantPeriodPerformance {
  isContractCovenant: boolean;
  priority: number;
}

export interface CovenantAnalystInsight {
  headline: string;
  bullets: string[];
}

const norm = (v: string) => v.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
const contractNameKey = (v: string) => v.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

function asArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed as T[] : [];
    } catch {
      return [];
    }
  }
  return [];
}

function asObject<T extends Record<string, any>>(value: unknown): T {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as T;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as T : {} as T;
    } catch {
      return {} as T;
    }
  }
  return {} as T;
}

function rawLineItems(stmt: FinancialStatement_DB): FinancialStatement_DB['rawLineItems'] {
  return asArray<FinancialStatement_DB['rawLineItems'][number]>((stmt as any).rawLineItems);
}

export const metricLabels: Record<string, string> = {
  revenue: 'Ingresos',
  interestIncome: 'Ingresos por intereses',
  feeIncome: 'Ingresos por comisiones',
  coreBusinessIncome: 'Ingresos core del negocio',
  adjustedFinancialMargin: 'Margen financiero ajustado',
  adjustedOperatingIncome: 'Utilidad operativa ajustada',
  adminSellingOperatingExpenses: 'Gastos adm., venta y operación',
  ebitda: 'EBITDA',
  interestExpense: 'Gasto financiero',
  netIncome: 'Utilidad neta',
  currentAssets: 'Activo corriente',
  currentLiabilities: 'Pasivo corriente',
  totalDebt: 'Deuda total',
  banksFundsShortTerm: 'Bancos y fondos CP',
  banksFundsLongTerm: 'Bancos y fondos LP',
  totalLiabilities: 'Total pasivo',
  totalAssets: 'Total activo',
  equity: 'Capital contable',
  cash: 'Bancos / efectivo',
  availableInvestments: 'Inversiones disponibles no comprometidas',
  loanPortfolio: 'Cartera de crédito',
  netPortfolio: 'Cartera neta',
  managedPortfolio: 'Cartera administrada',
  pastDuePortfolio: 'Cartera vencida',
  loanLossReserves: 'Estimación preventiva',
  productiveAssets: 'Activos productivos',
};

interface LocalConcept {
  id: string;
  name: string;
  tokens: string[];
}

function localConcepts(clientId: string): LocalConcept[] {
  try {
    return JSON.parse(localStorage.getItem(`finmonitor_defined_concepts_${clientId}`) || '[]');
  } catch {
    return [];
  }
}

export function rawAccountKey(item: FinancialStatement_DB['rawLineItems'][number]): string {
  return `${item.statementType || 'otro'}::${item.name}`;
}

export function accountOptions(statements: FinancialStatement_DB[]) {
  const seen = new Set<string>();
  const rows: Array<{ key: string; label: string }> = [];
  for (const stmt of statements) {
    for (const item of rawLineItems(stmt)) {
      const key = rawAccountKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ key, label: `${item.statementType || 'otro'} / ${item.name}` });
    }
  }
  return rows;
}

function findRaw(stmt: FinancialStatement_DB, names: string[], types?: string[]): number | null {
  const aliases = names.map((name, index) => ({ value: norm(name), index })).filter(alias => alias.value);
  let best: { value: number; score: number } | null = null;
  rawLineItems(stmt).forEach((item, itemIndex) => {
    const n = norm(item.name);
    const section = norm(item.sectionPath || '');
    const typeOk = !types || types.includes(item.statementType || 'otro');
    if (!typeOk) return;
    aliases.forEach(alias => {
      const exact = n === alias.value;
      const contains = n.includes(alias.value);
      const reverseContains = alias.value.includes(n);
      if (!exact && !contains && !reverseContains) return;
      let score = exact ? 1000 : contains ? 700 : 450;
      score += Math.max(0, 120 - alias.index);
      if (n.includes('total') || n.includes('subtotal') || section.includes('total')) score += 80;
      if (n.includes('neto') || n.includes('neta')) score += 35;
      score -= itemIndex / 1000;
      if (!best || score > best.score) best = { value: item.value, score };
    });
  });
  return best?.value ?? null;
}

function firstValue(...values: Array<number | null | undefined>): number | null {
  const found = values.find(value => value !== null && value !== undefined);
  return found ?? null;
}

function addValues(...values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length ? present.reduce((sum, value) => sum + value, 0) : null;
}

function subtractValues(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  return a - b;
}

function absoluteValue(value: number | null): number | null {
  return value === null ? null : Math.abs(value);
}

export function getMetric(stmt: FinancialStatement_DB, key: string): number | null {
  const m = asObject<FinancialStatement_DB['mappedData']>((stmt as any).mappedData);
  const raw = (names: string[], types?: string[]) => findRaw(stmt, names, types);
  switch (key) {
    case 'revenue': return firstValue(m.revenue, findConsolidatedMetricValue(stmt, 'revenue'), raw(['ingresos', 'ventas', ...metricAliases('revenue')], ['estado_resultados']));
    case 'interestIncome': return firstValue(findConsolidatedMetricValue(stmt, 'interestIncome'), raw(['ingresos por intereses', 'intereses cobrados', 'ingreso por interes', ...metricAliases('interestIncome')], ['estado_resultados']));
    case 'feeIncome': return firstValue(findConsolidatedMetricValue(stmt, 'feeIncome'), raw(['ingresos por comisiones', 'comisiones cobradas', 'ingreso por comision', ...metricAliases('feeIncome')], ['estado_resultados']));
    case 'coreBusinessIncome': return firstValue(findConsolidatedMetricValue(stmt, 'coreBusinessIncome'), addValues(getMetric(stmt, 'interestIncome'), getMetric(stmt, 'feeIncome')), getMetric(stmt, 'revenue'));
    case 'adjustedFinancialMargin': return firstValue(raw(['margen financiero ajustado por riesgos crediticios', 'margen financiero ajustado', 'margen financiero aj', ...metricAliases('adjustedFinancialMargin')], ['estado_resultados']), findConsolidatedMetricValue(stmt, 'adjustedFinancialMargin'));
    case 'adjustedOperatingIncome': return firstValue(raw(['utilidad o perdida de operacion', 'utilidad o pérdida de operación', 'utilidad de operacion', 'utilidad operativa ajustada', 'utilidad operacion ajustada', 'utilidad de operacion ajustada', 'resultado de operacion', ...metricAliases('adjustedOperatingIncome')], ['estado_resultados']), findConsolidatedMetricValue(stmt, 'adjustedOperatingIncome'));
    case 'adminSellingOperatingExpenses': return absoluteValue(firstValue(raw(['gastos de operacion total', 'gastos de operación total', 'gastos de operacion (total)', 'gastos de administracion venta y operacion', 'gastos adm venta opn', 'gastos administrativos', 'gastos de operacion', ...metricAliases('adminSellingOperatingExpenses')], ['estado_resultados']), findConsolidatedMetricValue(stmt, 'adminSellingOperatingExpenses')));
    case 'ebitda': return firstValue(m.ebitda, findConsolidatedMetricValue(stmt, 'ebitda'), raw(['ebitda', ...metricAliases('ebitda')], ['estado_resultados']), raw(['utilidad operacion', 'utilidad de operacion', 'resultado de operacion', 'utilidad antes de intereses'], ['estado_resultados']));
    case 'interestExpense': return absoluteValue(firstValue(m.interestExpense, raw(['gastos por intereses', 'gasto por intereses', 'gasto financiero', 'intereses pagados', 'intereses devengados', 'resultado integral de financiamiento', ...metricAliases('interestExpense')], ['estado_resultados']), findConsolidatedMetricValue(stmt, 'interestExpense')));
    case 'netIncome': return firstValue(m.netIncome, findConsolidatedMetricValue(stmt, 'netIncome'), raw(['utilidad neta', 'resultado neto', 'utilidad o perdida', 'utilidad (o perdida)', 'perdida del ejercicio', ...metricAliases('netIncome')], ['estado_resultados']));
    case 'currentAssets': return firstValue(m.currentAssets, findConsolidatedMetricValue(stmt, 'currentAssets'), raw(['activo circulante', 'activo corriente', 'total activo a corto plazo', 'activo a corto plazo', ...metricAliases('currentAssets')], ['balance_general']));
    case 'currentLiabilities': return firstValue(m.currentLiabilities, findConsolidatedMetricValue(stmt, 'currentLiabilities'), raw(['pasivo circulante', 'pasivo corriente', 'total pasivo a corto plazo', 'pasivo a corto plazo', ...metricAliases('currentLiabilities')], ['balance_general']));
    case 'totalDebt': return firstValue(m.totalDebt, addValues(getMetric(stmt, 'banksFundsShortTerm'), getMetric(stmt, 'banksFundsLongTerm')), raw(['deuda total', 'prestamos total', 'préstamos total', 'pasivo con costo', 'deuda', ...metricAliases('totalDebt')], ['balance_general']), findConsolidatedMetricValue(stmt, 'totalDebt'));
    case 'banksFundsShortTerm': return firstValue(raw(['prestamos total corto plazo', 'préstamos total corto plazo', 'prestamos (total corto plazo)', 'prestamos corto plazo', 'préstamos corto plazo', 'bancos y fondos corto plazo', 'bancos y fondos cp', 'fondeo corto plazo', ...metricAliases('banksFundsShortTerm')], ['balance_general']), findConsolidatedMetricValue(stmt, 'banksFundsShortTerm'));
    case 'banksFundsLongTerm': return firstValue(raw(['prestamos total largo plazo', 'préstamos total largo plazo', 'prestamos (total largo plazo)', 'prestamos largo plazo', 'préstamos largo plazo', 'bancos y fondos largo plazo', 'bancos y fondos lp', 'fondeo largo plazo', ...metricAliases('banksFundsLongTerm')], ['balance_general']), findConsolidatedMetricValue(stmt, 'banksFundsLongTerm'));
    case 'totalLiabilities': return firstValue(raw(['total de pasivo', 'total, de pasivo', 'total pasivo', 'suma del pasivo', 'pasivo total', ...metricAliases('totalLiabilities')], ['balance_general']), findConsolidatedMetricValue(stmt, 'totalLiabilities'), getMetric(stmt, 'totalDebt'));
    case 'totalAssets': return firstValue(m.totalAssets, findConsolidatedMetricValue(stmt, 'totalAssets'), raw(['total activo', 'activos totales', 'suma del activo', ...metricAliases('totalAssets')], ['balance_general']));
    case 'equity': return firstValue(m.equity, findConsolidatedMetricValue(stmt, 'equity'), raw(['capital contable', 'patrimonio', 'suma del capital', 'total capital', ...metricAliases('equity')], ['balance_general']));
    case 'cash': return firstValue(findConsolidatedMetricValue(stmt, 'cash'), raw(['efectivo', 'bancos', 'equivalentes de efectivo', ...metricAliases('cash')], ['balance_general']));
    case 'availableInvestments': return firstValue(raw(['inversiones temporales', 'inversiones disponibles', 'inversiones en valores', 'inversiones no comprometidas', ...metricAliases('availableInvestments')], ['balance_general']), findConsolidatedMetricValue(stmt, 'availableInvestments'));
    case 'loanPortfolio': return firstValue(raw(['cartera de credito subtotal', 'cartera de credito (subtotal)', 'cartera de credito total', 'cartera de credito', 'cartera vigente', 'creditos vigentes', ...metricAliases('loanPortfolio')], ['balance_general']), findConsolidatedMetricValue(stmt, 'loanPortfolio'));
    case 'netPortfolio': return firstValue(raw(['cartera de credito neto', 'cartera de credito, neto', 'cartera neta', 'cartera de credito neta', ...metricAliases('netPortfolio')], ['balance_general']), findConsolidatedMetricValue(stmt, 'netPortfolio'), subtractValues(getMetric(stmt, 'managedPortfolio'), getMetric(stmt, 'loanLossReserves')));
    case 'managedPortfolio': return firstValue(raw(['cartera administrada', 'cartera total administrada', 'portafolio administrado', ...metricAliases('managedPortfolio')], ['balance_general']), getMetric(stmt, 'loanPortfolio'), findConsolidatedMetricValue(stmt, 'managedPortfolio'));
    case 'pastDuePortfolio': return firstValue(raw(['cartera de credito etapa 3', 'cartera etapa 3', 'creditos etapa 3', 'cartera vencida', 'creditos vencidos', 'saldo vencido', ...metricAliases('pastDuePortfolio')], ['balance_general']), findConsolidatedMetricValue(stmt, 'pastDuePortfolio'));
    case 'loanLossReserves': return absoluteValue(firstValue(raw(['estimacion de cuentas incobrables', 'estimacion preventiva para riesgos crediticios', 'estimacion preventiva', 'reservas crediticias', 'reserva para perdidas crediticias', ...metricAliases('loanLossReserves')], ['balance_general']), findConsolidatedMetricValue(stmt, 'loanLossReserves')));
    case 'productiveAssets': return firstValue(findConsolidatedMetricValue(stmt, 'productiveAssets'), addValues(getMetric(stmt, 'cash'), getMetric(stmt, 'availableInvestments'), getMetric(stmt, 'loanPortfolio')));
    default: {
      if (key.startsWith('concept:')) {
        const concept = localConcepts(stmt.clientId).find(c => c.id === key.slice('concept:'.length));
        return concept ? evaluateFormula(`expr:${JSON.stringify(concept.tokens)}`, stmt) : null;
      }
      if (key.startsWith('account:')) {
        const accountKey = key.slice('account:'.length);
        const item = rawLineItems(stmt).find(i => rawAccountKey(i) === accountKey);
        return item?.value ?? null;
      }
      return null;
    }
  }
}

function div(a: number | null, b: number | null): number | null {
  if (a === null || b === null || b === 0) return null;
  return a / b;
}

export function standardRatios(stmt: FinancialStatement_DB): RatioResult[] {
  const adjustedFinancialMargin = getMetric(stmt, 'adjustedFinancialMargin');
  const adjustedOperatingIncome = getMetric(stmt, 'adjustedOperatingIncome');
  const adminSellingOperatingExpenses = getMetric(stmt, 'adminSellingOperatingExpenses');
  const revenue = getMetric(stmt, 'revenue');
  const coreBusinessIncome = getMetric(stmt, 'coreBusinessIncome');
  const interestIncome = getMetric(stmt, 'interestIncome');
  const ebitda = getMetric(stmt, 'ebitda');
  const interest = getMetric(stmt, 'interestExpense');
  const netIncome = getMetric(stmt, 'netIncome');
  const currentAssets = getMetric(stmt, 'currentAssets');
  const currentLiabilities = getMetric(stmt, 'currentLiabilities');
  const totalDebt = getMetric(stmt, 'totalDebt');
  const banksFundsShortTerm = getMetric(stmt, 'banksFundsShortTerm');
  const banksFundsLongTerm = getMetric(stmt, 'banksFundsLongTerm');
  const totalLiabilities = getMetric(stmt, 'totalLiabilities');
  const totalAssets = getMetric(stmt, 'totalAssets');
  const equity = getMetric(stmt, 'equity');
  const managedPortfolio = getMetric(stmt, 'managedPortfolio');
  const pastDuePortfolio = getMetric(stmt, 'pastDuePortfolio');
  const loanLossReserves = getMetric(stmt, 'loanLossReserves');
  const netPortfolio = getMetric(stmt, 'netPortfolio');
  const productiveAssets = getMetric(stmt, 'productiveAssets');
  const fundingDebt = addValues(banksFundsShortTerm, banksFundsLongTerm) ?? totalDebt;
  const costOfFunding = div(interest, fundingDebt);
  const portfolioYield = div(interestIncome, managedPortfolio);
  const miss = (items: Array<[string, number | null]>) => items.filter(([, value]) => value === null).map(([label]) => label);
  return [
    { key: 'revenue', label: 'Ingresos', value: revenue, formula: 'Cuenta extraída: ingresos/ventas', missing: miss([['Ingresos', revenue]]) },
    { key: 'ebitda', label: 'EBITDA', value: ebitda, formula: 'EBITDA o utilidad de operación', missing: miss([['EBITDA', ebitda]]) },
    { key: 'ifnb_financial_margin', label: 'Margen Financiero', value: div(adjustedFinancialMargin, coreBusinessIncome), formula: 'Margen financiero ajustado / (ingresos por intereses + ingresos por comisiones)', missing: miss([['Margen financiero ajustado', adjustedFinancialMargin], ['Ingresos core', coreBusinessIncome]]) },
    { key: 'ifnb_operating_profitability', label: 'Rentabilidad Operativa', value: div(adjustedOperatingIncome, coreBusinessIncome), formula: 'Utilidad operativa ajustada / ingresos core del negocio', missing: miss([['Utilidad operativa ajustada', adjustedOperatingIncome], ['Ingresos core', coreBusinessIncome]]) },
    { key: 'ifnb_net_margin', label: 'Margen Neto', value: div(netIncome, coreBusinessIncome), formula: 'Utilidad neta / ingresos core del negocio', missing: miss([['Utilidad neta', netIncome], ['Ingresos core', coreBusinessIncome]]) },
    { key: 'ifnb_operating_efficiency', label: 'Eficiencia Operativa', value: div(adminSellingOperatingExpenses, coreBusinessIncome), formula: 'Gastos de administración, venta y operación / ingresos core del negocio', missing: miss([['Gastos adm., venta y operación', adminSellingOperatingExpenses], ['Ingresos core', coreBusinessIncome]]) },
    { key: 'debt_ebitda', label: 'Deuda / EBITDA', value: div(totalDebt, ebitda), formula: 'Deuda total / EBITDA', missing: miss([['Deuda total', totalDebt], ['EBITDA', ebitda]]) },
    { key: 'dscr', label: 'DSCR', value: div(ebitda, interest), formula: 'EBITDA / gasto financiero', missing: miss([['EBITDA', ebitda], ['Gasto financiero', interest]]) },
    { key: 'current_ratio', label: 'Razón Corriente', value: div(currentAssets, currentLiabilities), formula: 'Activo corriente / Pasivo corriente', missing: miss([['Activo corriente', currentAssets], ['Pasivo corriente', currentLiabilities]]) },
    { key: 'leverage', label: 'Apalancamiento', value: div(fundingDebt, totalAssets), formula: '(Bancos y fondos CP + LP) / total activo', missing: miss([['Bancos y fondos CP + LP', fundingDebt], ['Activos totales', totalAssets]]) },
    { key: 'debt_equity', label: 'Deuda / Capital', value: div(totalDebt, equity), formula: 'Deuda total / capital contable', missing: miss([['Deuda total', totalDebt], ['Capital contable', equity]]) },
    { key: 'capitalization', label: 'ICAP', value: div(equity, totalAssets), formula: 'Capital contable / activos totales', missing: miss([['Capital contable', equity], ['Activos totales', totalAssets]]) },
    { key: 'adjusted_capitalization', label: 'ICAP Ajustado', value: div(equity, netPortfolio), formula: 'Capital contable / cartera neta', missing: miss([['Capital contable', equity], ['Cartera neta', netPortfolio]]) },
    { key: 'roa', label: 'ROA', value: div(netIncome, totalAssets), formula: 'Utilidad neta / activos totales', missing: miss([['Utilidad neta', netIncome], ['Activos totales', totalAssets]]) },
    { key: 'roe', label: 'ROE', value: div(netIncome, equity), formula: 'Utilidad neta / capital contable', missing: miss([['Utilidad neta', netIncome], ['Capital contable', equity]]) },
    { key: 'past_due_portfolio', label: 'Cartera Vencida', value: div(pastDuePortfolio, managedPortfolio), formula: 'Cartera vencida / cartera administrada', missing: miss([['Cartera vencida', pastDuePortfolio], ['Cartera administrada', managedPortfolio]]) },
    { key: 'net_past_due_portfolio', label: 'Cartera Vencida Neta', value: div(subtractValues(pastDuePortfolio, loanLossReserves), managedPortfolio), formula: '(Cartera vencida - estimación preventiva) / cartera administrada', missing: miss([['Cartera vencida', pastDuePortfolio], ['Estimación preventiva', loanLossReserves], ['Cartera administrada', managedPortfolio]]) },
    { key: 'past_due_coverage', label: 'Índice de Cobertura de Cartera Vencida', value: div(loanLossReserves, pastDuePortfolio), formula: 'Estimación preventiva / cartera vencida', missing: miss([['Estimación preventiva', loanLossReserves], ['Cartera vencida', pastDuePortfolio]]) },
    { key: 'debt_coverage_productive_assets', label: 'Cobertura de Deuda', value: div(productiveAssets, totalLiabilities), formula: 'Activos productivos / total pasivo', missing: miss([['Activos productivos', productiveAssets], ['Total pasivo', totalLiabilities]]) },
    { key: 'funding_cost', label: 'Costo de Fondeo Aproximado', value: costOfFunding, formula: 'Gasto financiero / bancos y fondos CP + LP', missing: miss([['Gasto financiero', interest], ['Bancos y fondos CP + LP', fundingDebt]]) },
    { key: 'portfolio_yield', label: 'Rendimiento de Cartera (Yield)', value: portfolioYield, formula: 'Ingresos por intereses / cartera administrada', missing: miss([['Ingresos por intereses', interestIncome], ['Cartera administrada', managedPortfolio]]) },
    { key: 'financial_spread', label: 'Spread Financiero Aproximado', value: portfolioYield !== null && costOfFunding !== null ? portfolioYield - costOfFunding : null, formula: 'Rendimiento de cartera - costo de fondeo aproximado', missing: miss([['Rendimiento de cartera', portfolioYield], ['Costo de fondeo', costOfFunding]]) },
    { key: 'immediate_liquidity', label: 'Liquidez Inmediata', value: div(addValues(getMetric(stmt, 'cash'), getMetric(stmt, 'availableInvestments')), currentLiabilities), formula: '(Bancos + inversiones disponibles no comprometidas) / pasivo corriente', missing: miss([['Bancos + inversiones disponibles', addValues(getMetric(stmt, 'cash'), getMetric(stmt, 'availableInvestments'))], ['Pasivo corriente', currentLiabilities]]) },
    { key: 'past_due_to_equity', label: 'Cartera Vencida / Capital Contable', value: div(pastDuePortfolio, equity), formula: 'Cartera vencida / capital contable', missing: miss([['Cartera vencida', pastDuePortfolio], ['Capital contable', equity]]) },
  ];
}

export function standardRatioFormula(key: string): string {
  return (
    key === 'debt_ebitda' ? 'ratio:totalDebt/ebitda' :
    key === 'dscr' ? 'ratio:ebitda/interestExpense' :
    key === 'current_ratio' ? 'ratio:currentAssets/currentLiabilities' :
    key === 'leverage' ? 'expr:["(","ref:banksFundsShortTerm","+","ref:banksFundsLongTerm",")","/","ref:totalAssets"]' :
    key === 'debt_equity' ? 'ratio:totalDebt/equity' :
    key === 'capitalization' ? 'ratio:equity/totalAssets' :
    key === 'adjusted_capitalization' ? 'ratio:equity/netPortfolio' :
    key === 'roa' ? 'ratio:netIncome/totalAssets' :
    key === 'roe' ? 'ratio:netIncome/equity' :
    key === 'ifnb_financial_margin' ? 'ratio:adjustedFinancialMargin/coreBusinessIncome' :
    key === 'ifnb_operating_profitability' ? 'ratio:adjustedOperatingIncome/coreBusinessIncome' :
    key === 'ifnb_net_margin' ? 'ratio:netIncome/coreBusinessIncome' :
    key === 'ifnb_operating_efficiency' ? 'ratio:adminSellingOperatingExpenses/coreBusinessIncome' :
    key === 'past_due_portfolio' ? 'ratio:pastDuePortfolio/managedPortfolio' :
    key === 'net_past_due_portfolio' ? 'expr:["(","ref:pastDuePortfolio","-","ref:loanLossReserves",")","/","ref:managedPortfolio"]' :
    key === 'past_due_coverage' ? 'ratio:loanLossReserves/pastDuePortfolio' :
    key === 'debt_coverage_productive_assets' ? 'ratio:productiveAssets/totalLiabilities' :
    key === 'funding_cost' ? 'expr:["ref:interestExpense","/","(","ref:banksFundsShortTerm","+","ref:banksFundsLongTerm",")"]' :
    key === 'portfolio_yield' ? 'ratio:interestIncome/managedPortfolio' :
    key === 'financial_spread' ? 'expr:["ref:interestIncome","/","ref:managedPortfolio","-","ref:interestExpense","/","(","ref:banksFundsShortTerm","+","ref:banksFundsLongTerm",")"]' :
    key === 'immediate_liquidity' ? 'expr:["(","ref:cash","+","ref:availableInvestments",")","/","ref:currentLiabilities"]' :
    key === 'past_due_to_equity' ? 'ratio:pastDuePortfolio/equity' :
    key
  );
}

export function suggestedCovenants(statements: FinancialStatement_DB[]) {
  const latest = [...statements].sort((a, b) => a.periodDate.localeCompare(b.periodDate)).at(-1);
  if (!latest) return [];
  return standardRatios(latest)
    .filter(r => r.value !== null && !['revenue', 'ebitda'].includes(r.key))
    .map(r => ({
      name: r.label,
      formula: standardRatioFormula(r.key),
      description: `Sugerido por cuentas detectadas: ${r.formula}. Valor actual ${r.value?.toLocaleString('es-MX', { maximumFractionDigits: 4 })}.`,
      currentValue: r.value,
    }));
}

export function evaluateFormula(formula: string, stmt: FinancialStatement_DB): number | null {
  const f = formula.trim();
  if (f.startsWith('expr:')) {
    try {
      const tokens = JSON.parse(f.slice('expr:'.length)) as string[];
      return evaluateExpressionTokens(tokens, stmt);
    } catch {
      return null;
    }
  }
  if (f.startsWith('ratio:')) {
    const body = f.slice('ratio:'.length);
    const [num, den] = body.split('/');
    return div(getMetric(stmt, num), getMetric(stmt, den));
  }
  const low = f.toLowerCase();
  if (low.includes('deuda') && low.includes('ebitda')) return standardRatios(stmt).find(r => r.key === 'debt_ebitda')?.value ?? null;
  if (low.includes('dscr') || (low.includes('ebitda') && low.includes('interes'))) return standardRatios(stmt).find(r => r.key === 'dscr')?.value ?? null;
  if (low.includes('corriente') || low.includes('liquidez')) return standardRatios(stmt).find(r => r.key === 'current_ratio')?.value ?? null;
  if (low.includes('capitalizacion') || low.includes('capitalización') || (low.includes('capital') && (low.includes('activo') || low.includes('asset')))) return standardRatios(stmt).find(r => r.key === 'capitalization')?.value ?? null;
  if (low.includes('roa')) return standardRatios(stmt).find(r => r.key === 'roa')?.value ?? null;
  if (low.includes('roe')) return standardRatios(stmt).find(r => r.key === 'roe')?.value ?? null;
  if (low.includes('apalanc') || low.includes('equity') || low.includes('capital')) return standardRatios(stmt).find(r => r.key === 'leverage')?.value ?? null;
  return null;
}

function tokenValue(token: string, stmt: FinancialStatement_DB): number | null {
  if (token.startsWith('ref:')) return getMetric(stmt, token.slice(4));
  if (token.startsWith('num:')) {
    const n = Number(token.slice(4));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function evaluateExpressionTokens(tokens: string[], stmt: FinancialStatement_DB): number | null {
  const values: number[] = [];
  const ops: string[] = [];
  const precedence: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2, '^': 3 };
  const rightAssoc = (op: string) => op === '^';
  const apply = () => {
    const op = ops.pop();
    const b = values.pop();
    const a = values.pop();
    if (!op || a === undefined || b === undefined) return false;
    if (op === '/' && b === 0) return false;
    const result =
      op === '+' ? a + b :
      op === '-' ? a - b :
      op === '*' ? a * b :
      op === '/' ? a / b :
      Math.pow(a, b);
    if (!Number.isFinite(result)) return false;
    values.push(result);
    return true;
  };

  for (const token of tokens) {
    if (token === '(') {
      ops.push(token);
      continue;
    }
    if (token === ')') {
      while (ops.length && ops.at(-1) !== '(') {
        if (!apply()) return null;
      }
      if (ops.pop() !== '(') return null;
      continue;
    }
    if (['+', '-', '*', '/', '^'].includes(token)) {
      while (
        ops.length &&
        ops.at(-1) !== '(' &&
        (precedence[ops.at(-1)!] > precedence[token] ||
          (precedence[ops.at(-1)!] === precedence[token] && !rightAssoc(token)))
      ) {
        if (!apply()) return null;
      }
      ops.push(token);
      continue;
    }
    const value = tokenValue(token, stmt);
    if (value === null) return null;
    values.push(value);
  }
  while (ops.length) {
    if (ops.at(-1) === '(') return null;
    if (!apply()) return null;
  }
  return values.length === 1 ? values[0] : null;
}

export function formulaLabel(formula: string, labels: Record<string, string> = {}): string {
  const readableRef = (key: string) => labels[key] || metricLabels[key] || key;
  if (formula.startsWith('ratio:')) {
    const [num, den] = formula.slice('ratio:'.length).split('/');
    return num && den ? `${readableRef(num)} / ${readableRef(den)}` : formula;
  }
  if (!formula.startsWith('expr:')) return metricLabels[formula] || formula;
  try {
    const tokens = JSON.parse(formula.slice('expr:'.length)) as string[];
    return tokens.map(t => {
      if (t.startsWith('ref:')) return readableRef(t.slice(4));
      if (t.startsWith('num:')) return t.slice(4);
      return t;
    }).join(' ');
  } catch {
    return formula;
  }
}

export function evaluateCovenantForStatement(cov: Covenant_DB, stmt: FinancialStatement_DB): { value: number | null; status: RatioStatus; formula: string } {
  const formula = cov.formulaByPeriod?.[stmt.period] || cov.formula || cov.name;
  const value = evaluateFormula(formula, stmt);
  if (value === null || cov.operator === 'none') return { value, status: 'cumple', formula };
  const parsedThreshold = parseNullableFinancialNumber(cov.threshold);
  const threshold = parsedThreshold !== null && /%/.test(cov.threshold) ? parsedThreshold / 100 : parsedThreshold;
  if (threshold === null) return { value, status: 'cumple', formula };
  let ok = true;
  if (cov.operator === 'gt') ok = value > threshold;
  if (cov.operator === 'gte') ok = value >= threshold;
  if (cov.operator === 'lt') ok = value < threshold;
  if (cov.operator === 'lte') ok = value <= threshold;
  if (!ok) return { value, status: 'incumple', formula };
  return { value, status: Math.abs((value - threshold) / (threshold || 1)) < 0.15 ? 'alerta' : 'cumple', formula };
}

export function evaluateCovenantAuto(cov: Covenant_DB, statements: FinancialStatement_DB[]): { value: number | null; status: RatioStatus; mode: 'auto' | 'manual' } {
  const latest = [...statements].sort((a, b) => a.periodDate.localeCompare(b.periodDate)).at(-1);
  if (!latest || cov.type !== 'financial') return { value: null, status: 'cumple', mode: cov.complianceStatus ? 'manual' : 'auto' };
  if (cov.complianceStatus?.startsWith('manual:')) {
    return { value: null, status: cov.complianceStatus.replace('manual:', '') as RatioStatus, mode: 'manual' };
  }
  const result = evaluateCovenantForStatement(cov, latest);
  return { value: result.value, status: result.status, mode: 'auto' };
}

function movementFor(
  cov: Covenant_DB,
  value: number | null,
  previousValue: number | null,
  status: RatioStatus,
  previousStatus: RatioStatus | null,
): CovenantMovement {
  if (value === null) return 'insufficient';
  if (previousValue === null) return 'new';
  const rank: Record<RatioStatus, number> = { cumple: 0, alerta: 1, incumple: 2 };
  if (previousStatus && rank[status] > rank[previousStatus]) return 'deterioration';
  if (previousStatus && rank[status] < rank[previousStatus]) return 'betterment';
  const delta = value - previousValue;
  if (Math.abs(delta) < 0.000001) return 'stable';
  if (cov.operator === 'lte' || cov.operator === 'lt') return delta < 0 ? 'betterment' : 'deterioration';
  if (cov.operator === 'gte' || cov.operator === 'gt') return delta > 0 ? 'betterment' : 'deterioration';
  return 'stable';
}

export function movementLabel(movement: CovenantMovement): string {
  if (movement === 'betterment') return 'Mejora';
  if (movement === 'deterioration') return 'Deterioro';
  if (movement === 'new') return 'Nuevo';
  if (movement === 'insufficient') return 'Sin datos';
  return 'Estable';
}

export function covenantPerformanceHistory(cov: Covenant_DB, statements: FinancialStatement_DB[]): CovenantPeriodPerformance[] {
  if (cov.type !== 'financial') return [];
  const ordered = [...statements].sort((a, b) => a.periodDate.localeCompare(b.periodDate));
  let previousValue: number | null = null;
  let previousStatus: RatioStatus | null = null;
  return ordered.map(stmt => {
    const result = evaluateCovenantForStatement(cov, stmt);
    const delta = result.value !== null && previousValue !== null ? result.value - previousValue : null;
    const deltaPct = delta !== null && previousValue !== null && previousValue !== 0 ? delta / Math.abs(previousValue) : null;
    const movement = movementFor(cov, result.value, previousValue, result.status, previousStatus);
    const row: CovenantPeriodPerformance = {
      covenantId: cov.id,
      covenantName: cov.name,
      period: stmt.period,
      periodDate: stmt.periodDate,
      value: result.value,
      previousValue,
      delta,
      deltaPct,
      status: result.status,
      previousStatus,
      movement,
      movementLabel: movementLabel(movement),
      threshold: cov.threshold,
      operator: cov.operator,
      formula: result.formula,
    };
    if (result.value !== null) previousValue = result.value;
    previousStatus = result.status;
    return row;
  });
}

export function latestCovenantPerformance(covenants: Covenant_DB[], statements: FinancialStatement_DB[]): CovenantPeriodPerformance[] {
  return covenants
    .flatMap(cov => covenantPerformanceHistory(cov, statements).slice(-1))
    .sort((a, b) => {
      const rank: Record<CovenantMovement, number> = { deterioration: 0, betterment: 1, stable: 2, new: 3, insufficient: 4 };
      return rank[a.movement] - rank[b.movement] || a.covenantName.localeCompare(b.covenantName);
    });
}

export function isSelectedContractCovenant(cov: Covenant_DB, contractCovenantKeys: string[]): boolean {
  return contractCovenantKeys.some(key =>
    key === cov.id ||
    key === `formula:${cov.formula}` ||
    key === `name:${contractNameKey(cov.name)}`,
  );
}

export function prioritizedLatestCovenantPerformance(
  covenants: Covenant_DB[],
  statements: FinancialStatement_DB[],
  contractCovenantKeys: string[] = [],
): PrioritizedCovenantPerformance[] {
  const covenantsById = new Map(covenants.map(cov => [cov.id, cov]));
  const statusRank: Record<RatioStatus, number> = { incumple: 0, alerta: 1, cumple: 2 };
  const movementRank: Record<CovenantMovement, number> = { deterioration: 0, betterment: 1, stable: 2, new: 3, insufficient: 4 };
  return latestCovenantPerformance(covenants, statements)
    .map(row => {
      const cov = covenantsById.get(row.covenantId);
      const isContractCovenant = !!cov && isSelectedContractCovenant(cov, contractCovenantKeys);
      return {
        ...row,
        isContractCovenant,
        priority: (isContractCovenant ? 0 : 100) + (statusRank[row.status] * 10) + movementRank[row.movement],
      };
    })
    .sort((a, b) => a.priority - b.priority || a.covenantName.localeCompare(b.covenantName));
}

function compactPerformance(row: CovenantPeriodPerformance): string {
  const current = (row.value ?? 0).toLocaleString('es-MX', { maximumFractionDigits: 2 });
  const previous = row.previousValue === null ? 'sin comparativo' : row.previousValue.toLocaleString('es-MX', { maximumFractionDigits: 2 });
  return `${row.covenantName}: ${current} vs. ${previous} (${row.movementLabel.toLowerCase()}, ${row.status})`;
}

export function buildCovenantAnalystInsight(performance: PrioritizedCovenantPerformance[]): CovenantAnalystInsight {
  if (performance.length === 0) {
    return {
      headline: 'No hay información suficiente para elaborar el análisis de tendencia de covenants.',
      bullets: ['Cargar al menos un estado financiero y configurar los covenants financieros aplicables.'],
    };
  }

  const latestPeriod = performance[0]?.period || 'último corte';
  const deteriorations = performance.filter(row => row.movement === 'deterioration');
  const improvements = performance.filter(row => row.movement === 'betterment');
  const breaches = performance.filter(row => row.status === 'incumple');
  const warnings = performance.filter(row => row.status === 'alerta');
  const contractPriority = performance.filter(row =>
    row.isContractCovenant &&
    (row.status !== 'cumple' || row.movement === 'deterioration'),
  );
  const bullets: string[] = [];

  if (contractPriority.length > 0) {
    bullets.push(`Prioridad contractual: ${contractPriority.slice(0, 3).map(compactPerformance).join('; ')}.`);
  } else if (performance.some(row => row.isContractCovenant)) {
    bullets.push('Covenants de contrato: sin deterioros ni alertas en el último corte disponible.');
  }
  if (deteriorations.length > 0) {
    bullets.push(`Deterioros a revisar: ${deteriorations.slice(0, 3).map(compactPerformance).join('; ')}.`);
  }
  if (improvements.length > 0) {
    bullets.push(`Mejoras observadas: ${improvements.slice(0, 3).map(compactPerformance).join('; ')}.`);
  }
  if (breaches.length > 0 || warnings.length > 0) {
    bullets.push(`Seguimiento sugerido: documentar causas y plan de acción para ${breaches.length} incumplimiento${breaches.length === 1 ? '' : 's'} y ${warnings.length} alerta${warnings.length === 1 ? '' : 's'} antes del siguiente comité.`);
  } else {
    bullets.push('Seguimiento sugerido: confirmar que las cifras y fórmulas del corte estén conciliadas antes del siguiente comité.');
  }

  return {
    headline: `Al ${latestPeriod}, ${deteriorations.length} covenant${deteriorations.length === 1 ? '' : 's'} deterioraron, ${improvements.length} mejoraron y ${breaches.length} se encuentran en incumplimiento.`,
    bullets: bullets.slice(0, 4),
  };
}

export function buildCovenantInsightPrompt(clientName: string, performance: CovenantPeriodPerformance[]): string {
  const rows = performance.map(row => ({
    covenant: row.covenantName,
    period: row.period,
    value: row.value,
    previousValue: row.previousValue,
    delta: row.delta,
    deltaPct: row.deltaPct,
    status: row.status,
    movement: row.movementLabel,
    threshold: row.operator === 'none' ? 'N/A' : `${row.operator} ${row.threshold}`,
    formula: row.formula,
  }));
  return `Actúa como analista senior de crédito. Analiza el desempeño periodo contra periodo de los covenants financieros de ${clientName || 'este cliente'}.

Datos:
${JSON.stringify(rows, null, 2)}

Entrega insights ejecutivos en español:
1. Resumen de deterioros y mejoras relevantes.
2. Covenants con mayor riesgo de incumplimiento o cercanía al límite.
3. Explicación probable de los movimientos, usando solo los datos disponibles.
4. Preguntas o documentos que el analista debería solicitar.
5. Recomendación de seguimiento para el siguiente comité de crédito.

Sé concreto, separa hechos de hipótesis y evita inventar datos no incluidos.`;
}
