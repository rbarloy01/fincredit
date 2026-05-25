import { FinancialStatement } from '../types';

export const accountLabels: Record<keyof FinancialStatement['data'], string> = {
  revenue: 'Ingresos',
  cogs: 'Costos',
  operatingExpenses: 'Gastos operativos',
  ebitda: 'EBITDA',
  interestExpense: 'Gasto por intereses',
  netIncome: 'Resultado neto',
  currentAssets: 'Activo circulante',
  currentLiabilities: 'Pasivo circulante',
  totalDebt: 'Deuda total',
  totalAssets: 'Activo total',
  equity: 'Capital contable',
};

const allowed = new Set([...Object.keys(accountLabels), '+', '-', '*', '/', '(', ')']);
const precedence: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2 };

function compute(tokens: string[]) {
  const output: string[] = [];
  const ops: string[] = [];

  tokens.forEach(token => {
    if (/^-?\d/.test(token)) {
      output.push(token);
      return;
    }
    if (token === '(') {
      ops.push(token);
      return;
    }
    if (token === ')') {
      while (ops.length && ops[ops.length - 1] !== '(') output.push(ops.pop() as string);
      ops.pop();
      return;
    }
    while (ops.length && precedence[ops[ops.length - 1]] >= precedence[token]) output.push(ops.pop() as string);
    ops.push(token);
  });

  while (ops.length) output.push(ops.pop() as string);

  const stack: number[] = [];
  output.forEach(token => {
    if (/^-?\d/.test(token)) {
      stack.push(Number(token));
      return;
    }
    const b = stack.pop();
    const a = stack.pop();
    if (a === undefined || b === undefined) throw new Error('invalid');
    if (token === '+') stack.push(a + b);
    if (token === '-') stack.push(a - b);
    if (token === '*') stack.push(a * b);
    if (token === '/') stack.push(b === 0 ? NaN : a / b);
  });
  return stack.length === 1 ? stack[0] : NaN;
}

export function evaluateFormula(formula: string, data: FinancialStatement['data']) {
  const tokens = formula.match(/[A-Za-z][A-Za-z0-9_]*|\d+(?:\.\d+)?|[()+\-*/]/g) || [];
  const missing: string[] = [];
  const expression = tokens.map(token => {
    if (/^\d/.test(token) || ['+', '-', '*', '/', '(', ')'].includes(token)) return token;
    if (!(token in data)) missing.push(token);
    return String((data as any)[token] ?? 0);
  });

  if (missing.length) return { value: null, missing };
  if (tokens.some(token => !allowed.has(token) && !/^\d/.test(token))) return { value: null, missing: ['formula inválida'] };

  try {
    const value = compute(expression);
    return { value: Number.isFinite(value) ? Number(value) : null, missing: [] };
  } catch {
    return { value: null, missing: ['formula inválida'] };
  }
}

export function formatNumber(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'N/D';
  return value.toLocaleString('es-MX', { maximumFractionDigits: 2 });
}
