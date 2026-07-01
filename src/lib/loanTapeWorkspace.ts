import { StructuredLoanTapeAnalysis } from '../services/ai';
import { MappingNote, StandardLoan, buildLoanTapeDataProfile } from './loanTapeAnalytics';

export type LoanTapeBlockType = 'kpi' | 'table' | 'bar' | 'line' | 'pie';

export interface LoanTapeBlockColumn {
  key: string;
  label: string;
  format?: 'money' | 'pct' | 'number' | 'text';
}

export interface LoanTapeWorkspaceBlock {
  id: string;
  prompt: string;
  title: string;
  description: string;
  type: LoanTapeBlockType;
  data: Record<string, any>[];
  columns?: LoanTapeBlockColumn[];
  xKey?: string;
  series?: Array<{ key: string; label: string; color: string; format?: 'money' | 'pct' | 'number' }>;
  createdAt: string;
}

export interface LoanTapeQaState {
  draft: string;
  question: string;
  answer: string;
  updatedAt?: string;
}

export interface LoanTapeAnalystState {
  workspaceBlocks: LoanTapeWorkspaceBlock[];
  qa: LoanTapeQaState;
  updatedAt?: string;
}

export function normalizeLoanTapeAnalystState(value: any): LoanTapeAnalystState {
  return {
    workspaceBlocks: Array.isArray(value?.workspaceBlocks) ? value.workspaceBlocks : [],
    qa: {
      draft: typeof value?.qa?.draft === 'string' ? value.qa.draft : '',
      question: typeof value?.qa?.question === 'string' ? value.qa.question : '',
      answer: typeof value?.qa?.answer === 'string' ? value.qa.answer : '',
      updatedAt: typeof value?.qa?.updatedAt === 'string' ? value.qa.updatedAt : undefined,
    },
    updatedAt: typeof value?.updatedAt === 'string' ? value.updatedAt : undefined,
  };
}

const COLORS = ['#6366f1', '#06b6d4', '#f59e0b', '#f43f5e', '#10b981', '#8b5cf6'];

function normalize(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function latestRows(rows: StandardLoan[]) {
  const dates = Array.from(new Set(rows.map(row => row.file_date).filter(Boolean) as string[])).sort();
  const latest = dates[dates.length - 1];
  return latest ? rows.filter(row => row.file_date === latest) : rows;
}

function totalBalance(rows: StandardLoan[]) {
  return rows.reduce((total, row) => total + (Number(row.outstanding_balance) || 0), 0);
}

function groupRows(rows: StandardLoan[], field: keyof StandardLoan, limit = 12) {
  const total = totalBalance(rows);
  const grouped = new Map<string, StandardLoan[]>();
  rows.forEach(row => {
    const name = String(row[field] || 'Sin dato').trim() || 'Sin dato';
    grouped.set(name, [...(grouped.get(name) || []), row]);
  });
  return Array.from(grouped.entries())
    .map(([name, items]) => {
      const balance = totalBalance(items);
      return { name, count: items.length, balance, pct: total ? balance / total : 0 };
    })
    .sort((a, b) => b.balance - a.balance)
    .slice(0, limit);
}

function portfolioTrend(rows: StandardLoan[]) {
  const dates = Array.from(new Set(rows.map(row => row.file_date).filter(Boolean) as string[])).sort();
  return dates.map(date => {
    const periodRows = rows.filter(row => row.file_date === date);
    const balance = totalBalance(periodRows);
    const overdueBalance = totalBalance(periodRows.filter(row => (row.days_overdue || 0) > 0));
    const severeBalance = totalBalance(periodRows.filter(row => (row.days_overdue || 0) > 90));
    return {
      period: date,
      balance,
      overduePct: balance ? overdueBalance / balance : 0,
      severePct: balance ? severeBalance / balance : 0,
    };
  });
}

function block(
  prompt: string,
  title: string,
  description: string,
  type: LoanTapeBlockType,
  data: Record<string, any>[],
  extras: Partial<LoanTapeWorkspaceBlock> = {},
): LoanTapeWorkspaceBlock {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    prompt,
    title,
    description,
    type,
    data,
    createdAt: new Date().toISOString(),
    ...extras,
  };
}

export function createLoanTapeWorkspaceBlock(
  prompt: string,
  rows: StandardLoan[],
  analysis: StructuredLoanTapeAnalysis | null,
  mappingReport: MappingNote[] = [],
): LoanTapeWorkspaceBlock {
  const q = normalize(prompt);
  const latest = latestRows(rows);
  const balance = totalBalance(latest);

  if (/(tendencia|evolucion|historico|cambio|mes anterior|periodo)/.test(q)) {
    const data = portfolioTrend(rows);
    return block(prompt, 'Evolución de la cartera', data.length > 1 ? 'Saldo y mora por fecha de corte.' : 'Solo hay un corte disponible; agrega otro periodo para ver la tendencia.', 'line', data, {
      xKey: 'period',
      series: [
        { key: 'balance', label: 'Saldo', color: COLORS[0], format: 'money' },
        { key: 'overduePct', label: 'Mora', color: COLORS[3], format: 'pct' },
      ],
    });
  }

  if (/(mora|dpd|vencid|atras)/.test(q)) {
    const data = analysis?.dpd_distribution || [];
    return block(prompt, 'Distribución de mora', 'Saldo de cartera por bucket de días vencidos.', 'bar', data, {
      xKey: 'bucket',
      series: [{ key: 'balance', label: 'Saldo', color: COLORS[3], format: 'money' }],
      columns: [
        { key: 'bucket', label: 'DPD' },
        { key: 'count', label: 'Créditos', format: 'number' },
        { key: 'balance', label: 'Saldo', format: 'money' },
        { key: 'pct', label: '% cartera', format: 'pct' },
      ],
    });
  }

  const dimensions: Array<{ pattern: RegExp; field: keyof StandardLoan; title: string }> = [
    { pattern: /(producto|tipo de credito|segmento)/, field: 'loan_type', title: 'Cartera por producto' },
    { pattern: /(estado|region|geograf)/, field: 'state', title: 'Cartera por estado' },
    { pattern: /(industria|sector|giro)/, field: 'industry', title: 'Cartera por industria' },
    { pattern: /(cliente|acreditado|concentracion)/, field: 'client', title: 'Concentración por cliente' },
  ];
  const dimension = dimensions.find(item => item.pattern.test(q));
  if (dimension) {
    const data = groupRows(latest, dimension.field);
    const requestedPie = /(pie|pastel|dona)/.test(q);
    return block(prompt, dimension.title, 'Agrupación por saldo outstanding del último corte.', requestedPie ? 'pie' : 'bar', data, {
      xKey: 'name',
      series: [{ key: 'balance', label: 'Saldo', color: COLORS[0], format: 'money' }],
      columns: [
        { key: 'name', label: 'Grupo' },
        { key: 'count', label: 'Créditos', format: 'number' },
        { key: 'balance', label: 'Saldo', format: 'money' },
        { key: 'pct', label: '% cartera', format: 'pct' },
      ],
    });
  }

  if (/(top|mayores|creditos|prestamos|operaciones)/.test(q)) {
    const data = [...latest]
      .sort((a, b) => (b.outstanding_balance || 0) - (a.outstanding_balance || 0))
      .slice(0, 15)
      .map(row => ({
        loan_id: row.loan_id,
        client: row.client,
        product: row.loan_type,
        balance: row.outstanding_balance,
        dpd: row.days_overdue,
      }));
    return block(prompt, 'Mayores exposiciones', 'Top 15 créditos por saldo outstanding.', 'table', data, {
      xKey: 'loan_id',
      series: [{ key: 'balance', label: 'Saldo', color: COLORS[0], format: 'money' }],
      columns: [
        { key: 'loan_id', label: 'Crédito' },
        { key: 'client', label: 'Cliente' },
        { key: 'product', label: 'Producto' },
        { key: 'balance', label: 'Saldo', format: 'money' },
        { key: 'dpd', label: 'DPD', format: 'number' },
      ],
    });
  }

  if (/(falta|calidad|mapeo|vacio|completitud)/.test(q)) {
    const profile = buildLoanTapeDataProfile(rows, mappingReport);
    const data = profile.missingFields.map(item => ({
      field: item.field,
      mapped: item.mapped ? 'Sí' : 'No',
      missingPct: item.missingPct,
      severity: item.severity,
      impact: item.impact,
    }));
    return block(prompt, 'Calidad y completitud', `Preparación general: ${profile.readinessScore}/100.`, 'table', data, {
      xKey: 'field',
      series: [{ key: 'missingPct', label: '% vacío', color: COLORS[2], format: 'pct' }],
      columns: [
        { key: 'field', label: 'Campo' },
        { key: 'mapped', label: 'Mapeado' },
        { key: 'missingPct', label: '% vacío', format: 'pct' },
        { key: 'severity', label: 'Severidad' },
        { key: 'impact', label: 'Impacto' },
      ],
    });
  }

  const overdue = totalBalance(latest.filter(row => (row.days_overdue || 0) > 0));
  const severe = totalBalance(latest.filter(row => (row.days_overdue || 0) > 90));
  const clients = new Set(latest.map(row => row.client).filter(Boolean)).size;
  return block(prompt, 'Resumen de cartera', analysis?.executiveSummary || 'Vista ejecutiva del último corte.', 'kpi', [
    { label: 'Saldo total', value: balance, format: 'money' },
    { label: 'Créditos', value: latest.length, format: 'number' },
    { label: 'Clientes', value: clients, format: 'number' },
    { label: 'Mora', value: balance ? overdue / balance : 0, format: 'pct' },
    { label: 'Vencida >90', value: balance ? severe / balance : 0, format: 'pct' },
    { label: 'Risk score', value: analysis?.riskScore || 0, format: 'number' },
  ]);
}
