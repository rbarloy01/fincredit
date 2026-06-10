import { Covenant_DB, FinancialStatement_DB } from '../db/index';
import { findConsolidatedMetricValue, metricAliases } from './accountConsolidation';

export type RatioStatus = 'cumple' | 'alerta' | 'incumple';

export interface RatioResult {
  key: string;
  label: string;
  value: number | null;
  formula: string;
  missing: string[];
}

const norm = (v: string) => v.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');

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
    for (const item of stmt.rawLineItems) {
      const key = rawAccountKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ key, label: `${item.statementType || 'otro'} / ${item.name}` });
    }
  }
  return rows;
}

function findRaw(stmt: FinancialStatement_DB, names: string[], types?: string[]): number | null {
  const found = stmt.rawLineItems.find(item => {
    const n = norm(item.name);
    const typeOk = !types || types.includes(item.statementType || 'otro');
    return typeOk && names.some(name => n.includes(norm(name)));
  });
  return found?.value ?? null;
}

export function getMetric(stmt: FinancialStatement_DB, key: string): number | null {
  const m = (stmt.mappedData || {}) as FinancialStatement_DB['mappedData'];
  const raw = (names: string[], types?: string[]) => findRaw(stmt, names, types);
  switch (key) {
    case 'revenue': return m.revenue || findConsolidatedMetricValue(stmt, 'revenue') || raw(['ingresos', 'ventas', ...metricAliases('revenue')], ['estado_resultados']);
    case 'ebitda': return m.ebitda || findConsolidatedMetricValue(stmt, 'ebitda') || raw(['ebitda', ...metricAliases('ebitda')], ['estado_resultados']) || raw(['utilidad operacion', 'utilidad de operacion', 'resultado de operacion', 'utilidad antes de intereses'], ['estado_resultados']);
    case 'interestExpense': return m.interestExpense || findConsolidatedMetricValue(stmt, 'interestExpense') || raw(['gasto financiero', 'intereses pagados', 'intereses devengados', 'resultado integral de financiamiento', ...metricAliases('interestExpense')], ['estado_resultados']);
    case 'netIncome': return m.netIncome || findConsolidatedMetricValue(stmt, 'netIncome') || raw(['utilidad neta', 'resultado neto', 'utilidad o perdida', 'utilidad (o perdida)', 'perdida del ejercicio', ...metricAliases('netIncome')], ['estado_resultados']);
    case 'currentAssets': return m.currentAssets || findConsolidatedMetricValue(stmt, 'currentAssets') || raw(['activo circulante', 'activo corriente', 'total activo a corto plazo', 'activo a corto plazo', ...metricAliases('currentAssets')], ['balance_general']);
    case 'currentLiabilities': return m.currentLiabilities || findConsolidatedMetricValue(stmt, 'currentLiabilities') || raw(['pasivo circulante', 'pasivo corriente', 'total pasivo a corto plazo', 'pasivo a corto plazo', ...metricAliases('currentLiabilities')], ['balance_general']);
    case 'totalDebt': return m.totalDebt || findConsolidatedMetricValue(stmt, 'totalDebt') || raw(['deuda total', 'pasivo con costo', 'deuda', 'suma del pasivo', 'total pasivo', ...metricAliases('totalDebt')], ['balance_general']);
    case 'totalAssets': return m.totalAssets || findConsolidatedMetricValue(stmt, 'totalAssets') || raw(['total activo', 'activos totales', 'suma del activo', ...metricAliases('totalAssets')], ['balance_general']);
    case 'equity': return m.equity || findConsolidatedMetricValue(stmt, 'equity') || raw(['capital contable', 'patrimonio', 'suma del capital', 'total capital', ...metricAliases('equity')], ['balance_general']);
    default: {
      if (key.startsWith('concept:')) {
        const concept = localConcepts(stmt.clientId).find(c => c.id === key.slice('concept:'.length));
        return concept ? evaluateFormula(`expr:${JSON.stringify(concept.tokens)}`, stmt) : null;
      }
      if (key.startsWith('account:')) {
        const accountKey = key.slice('account:'.length);
        const item = stmt.rawLineItems.find(i => rawAccountKey(i) === accountKey);
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
  const revenue = getMetric(stmt, 'revenue');
  const ebitda = getMetric(stmt, 'ebitda');
  const interest = getMetric(stmt, 'interestExpense');
  const netIncome = getMetric(stmt, 'netIncome');
  const currentAssets = getMetric(stmt, 'currentAssets');
  const currentLiabilities = getMetric(stmt, 'currentLiabilities');
  const totalDebt = getMetric(stmt, 'totalDebt');
  const totalAssets = getMetric(stmt, 'totalAssets');
  const equity = getMetric(stmt, 'equity');
  const miss = (items: Array<[string, number | null]>) => items.filter(([, value]) => value === null).map(([label]) => label);
  return [
    { key: 'revenue', label: 'Ingresos', value: revenue, formula: 'Cuenta extraída: ingresos/ventas', missing: miss([['Ingresos', revenue]]) },
    { key: 'ebitda', label: 'EBITDA', value: ebitda, formula: 'EBITDA o utilidad de operación', missing: miss([['EBITDA', ebitda]]) },
    { key: 'debt_ebitda', label: 'Deuda / EBITDA', value: div(totalDebt, ebitda), formula: 'Deuda total / EBITDA', missing: miss([['Deuda total', totalDebt], ['EBITDA', ebitda]]) },
    { key: 'dscr', label: 'DSCR', value: div(ebitda, interest), formula: 'EBITDA / gasto financiero', missing: miss([['EBITDA', ebitda], ['Gasto financiero', interest]]) },
    { key: 'current_ratio', label: 'Razón Corriente', value: div(currentAssets, currentLiabilities), formula: 'Activo corriente / Pasivo corriente', missing: miss([['Activo corriente', currentAssets], ['Pasivo corriente', currentLiabilities]]) },
    { key: 'leverage', label: 'Deuda / Capital', value: div(totalDebt, equity), formula: 'Deuda total / capital contable', missing: miss([['Deuda total', totalDebt], ['Capital contable', equity]]) },
    { key: 'roa', label: 'ROA', value: div(netIncome, totalAssets), formula: 'Utilidad neta / activos totales', missing: miss([['Utilidad neta', netIncome], ['Activos totales', totalAssets]]) },
    { key: 'roe', label: 'ROE', value: div(netIncome, equity), formula: 'Utilidad neta / capital contable', missing: miss([['Utilidad neta', netIncome], ['Capital contable', equity]]) },
  ];
}

export function standardRatioFormula(key: string): string {
  return (
    key === 'debt_ebitda' ? 'ratio:totalDebt/ebitda' :
    key === 'dscr' ? 'ratio:ebitda/interestExpense' :
    key === 'current_ratio' ? 'ratio:currentAssets/currentLiabilities' :
    key === 'leverage' ? 'ratio:totalDebt/equity' :
    key === 'roa' ? 'ratio:netIncome/totalAssets' :
    key === 'roe' ? 'ratio:netIncome/equity' :
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
  if (!formula.startsWith('expr:')) return formula;
  try {
    const tokens = JSON.parse(formula.slice('expr:'.length)) as string[];
    return tokens.map(t => {
      if (t.startsWith('ref:')) return labels[t.slice(4)] || t.slice(4);
      if (t.startsWith('num:')) return t.slice(4);
      return t;
    }).join(' ');
  } catch {
    return formula;
  }
}

export function evaluateCovenantAuto(cov: Covenant_DB, statements: FinancialStatement_DB[]): { value: number | null; status: RatioStatus; mode: 'auto' | 'manual' } {
  const latest = [...statements].sort((a, b) => a.periodDate.localeCompare(b.periodDate)).at(-1);
  if (!latest || cov.type !== 'financial') return { value: null, status: 'cumple', mode: cov.complianceStatus ? 'manual' : 'auto' };
  if (cov.complianceStatus?.startsWith('manual:')) {
    return { value: null, status: cov.complianceStatus.replace('manual:', '') as RatioStatus, mode: 'manual' };
  }
  const formula = cov.formulaByPeriod?.[latest.period] || cov.formula || cov.name;
  const value = evaluateFormula(formula, latest);
  if (value === null || cov.operator === 'none') return { value, status: 'cumple', mode: 'auto' };
  const threshold = parseFloat(cov.threshold);
  if (!Number.isFinite(threshold)) return { value, status: 'cumple', mode: 'auto' };
  let ok = true;
  if (cov.operator === 'gt') ok = value > threshold;
  if (cov.operator === 'gte') ok = value >= threshold;
  if (cov.operator === 'lt') ok = value < threshold;
  if (cov.operator === 'lte') ok = value <= threshold;
  if (!ok) return { value, status: 'incumple', mode: 'auto' };
  return { value, status: Math.abs((value - threshold) / (threshold || 1)) < 0.15 ? 'alerta' : 'cumple', mode: 'auto' };
}
