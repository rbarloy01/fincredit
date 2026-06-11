import { db, Covenant_DB, FinancialStatement_DB } from '../db/index';

export type ConsolidationMetric =
  | 'revenue'
  | 'ebitda'
  | 'interestExpense'
  | 'netIncome'
  | 'currentAssets'
  | 'currentLiabilities'
  | 'totalDebt'
  | 'totalAssets'
  | 'equity'
  | 'cash'
  | 'operatingCashFlow';

export interface AccountConsolidationRule {
  id: string;
  metric: ConsolidationMetric;
  label: string;
  aliases: string[];
  statementType?: FinancialStatement_DB['rawLineItems'][number]['statementType'] | 'any';
  source: 'manual' | 'ai' | 'system';
  updatedAt: string;
}

export interface GlobalCovenantTemplate {
  id: string;
  name: string;
  formula: string;
  description: string;
  operator: Covenant_DB['operator'];
  threshold: string;
  source: 'manual' | 'ai' | 'existing' | 'system';
  active: boolean;
  seenCount: number;
  updatedAt: string;
}

export interface ParsedAccountCovenantMemory {
  id: string;
  accountName: string;
  statementType: FinancialStatement_DB['rawLineItems'][number]['statementType'] | 'otro';
  covenantName: string;
  covenantFormula: string;
  reason: string;
  confidence: number;
  source: 'manual' | 'ai' | 'heuristic';
  seenCount: number;
  updatedAt: string;
}

export const CONSOLIDATION_RULES_KEY = 'finmonitor_account_consolidation_rules';
export const GLOBAL_COVENANT_TEMPLATES_KEY = 'finmonitor_global_covenant_templates';
export const PARSED_ACCOUNT_COVENANT_MEMORY_KEY = 'finmonitor_parsed_account_covenant_memory';

let cachedCustomRules: AccountConsolidationRule[] = [];
let cachedTemplates: GlobalCovenantTemplate[] = [];
let cachedAccountCovenantMemory: ParsedAccountCovenantMemory[] = [];
let rulesCacheHydrated = false;
let templatesCacheHydrated = false;
let accountCovenantMemoryHydrated = false;

export const METRIC_LABELS: Record<ConsolidationMetric, string> = {
  revenue: 'Ingresos',
  ebitda: 'EBITDA',
  interestExpense: 'Gasto financiero / intereses',
  netIncome: 'Utilidad neta',
  currentAssets: 'Activo circulante',
  currentLiabilities: 'Pasivo circulante',
  totalDebt: 'Deuda / pasivo total',
  totalAssets: 'Activo total',
  equity: 'Capital contable',
  cash: 'Efectivo y equivalentes',
  operatingCashFlow: 'Flujo operativo',
};

export const BASE_CONSOLIDATION_RULES: AccountConsolidationRule[] = [
  { id: 'sys-revenue', metric: 'revenue', label: METRIC_LABELS.revenue, aliases: ['ingresos', 'ventas', 'rentas', 'ingresos por renta'], statementType: 'estado_resultados', source: 'system', updatedAt: 'system' },
  { id: 'sys-ebitda', metric: 'ebitda', label: METRIC_LABELS.ebitda, aliases: ['ebitda', 'utilidad de operacion', 'resultado de operacion'], statementType: 'estado_resultados', source: 'system', updatedAt: 'system' },
  { id: 'sys-interest', metric: 'interestExpense', label: METRIC_LABELS.interestExpense, aliases: ['gasto financiero', 'intereses', 'resultado integral de financiamiento'], statementType: 'estado_resultados', source: 'system', updatedAt: 'system' },
  { id: 'sys-net-income', metric: 'netIncome', label: METRIC_LABELS.netIncome, aliases: ['utilidad neta', 'resultado neto', 'perdida del ejercicio'], statementType: 'estado_resultados', source: 'system', updatedAt: 'system' },
  { id: 'sys-current-assets', metric: 'currentAssets', label: METRIC_LABELS.currentAssets, aliases: ['activo circulante', 'activo corriente', 'activo a corto plazo'], statementType: 'balance_general', source: 'system', updatedAt: 'system' },
  { id: 'sys-current-liabilities', metric: 'currentLiabilities', label: METRIC_LABELS.currentLiabilities, aliases: ['pasivo circulante', 'pasivo corriente', 'pasivo a corto plazo'], statementType: 'balance_general', source: 'system', updatedAt: 'system' },
  { id: 'sys-total-debt', metric: 'totalDebt', label: METRIC_LABELS.totalDebt, aliases: ['deuda total', 'pasivo con costo', 'suma del pasivo', 'total pasivo'], statementType: 'balance_general', source: 'system', updatedAt: 'system' },
  { id: 'sys-total-assets', metric: 'totalAssets', label: METRIC_LABELS.totalAssets, aliases: ['total activo', 'activos totales', 'suma del activo'], statementType: 'balance_general', source: 'system', updatedAt: 'system' },
  { id: 'sys-equity', metric: 'equity', label: METRIC_LABELS.equity, aliases: ['capital contable', 'patrimonio', 'total capital', 'suma del capital'], statementType: 'balance_general', source: 'system', updatedAt: 'system' },
  { id: 'sys-cash', metric: 'cash', label: METRIC_LABELS.cash, aliases: ['efectivo', 'bancos', 'equivalentes de efectivo'], statementType: 'balance_general', source: 'system', updatedAt: 'system' },
];

export function cleanText(value: string): string {
  return value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : fallback;
  } catch {
    return fallback;
  }
}

function mergeWithSystemRules(custom: AccountConsolidationRule[]): AccountConsolidationRule[] {
  const byId = new Map<string, AccountConsolidationRule>();
  [...BASE_CONSOLIDATION_RULES, ...custom].forEach(rule => byId.set(rule.id, rule));
  return Array.from(byId.values());
}

export function loadConsolidationRules(): AccountConsolidationRule[] {
  if (!rulesCacheHydrated) {
    cachedCustomRules = readJson<AccountConsolidationRule[]>(CONSOLIDATION_RULES_KEY, []);
    rulesCacheHydrated = true;
  }
  return mergeWithSystemRules(cachedCustomRules);
}

export async function loadOrgConsolidationRules(userId: string): Promise<AccountConsolidationRule[]> {
  cachedCustomRules = await db.getOrgSetting<AccountConsolidationRule[]>(userId, CONSOLIDATION_RULES_KEY, readJson<AccountConsolidationRule[]>(CONSOLIDATION_RULES_KEY, []));
  rulesCacheHydrated = true;
  return mergeWithSystemRules(cachedCustomRules);
}

export async function saveConsolidationRules(userId: string, rules: AccountConsolidationRule[]) {
  cachedCustomRules = rules.filter(r => r.source !== 'system');
  rulesCacheHydrated = true;
  await db.setOrgSetting(userId, CONSOLIDATION_RULES_KEY, cachedCustomRules);
}

export function loadGlobalCovenantTemplates(): GlobalCovenantTemplate[] {
  if (!templatesCacheHydrated) {
    cachedTemplates = readJson<GlobalCovenantTemplate[]>(GLOBAL_COVENANT_TEMPLATES_KEY, []);
    templatesCacheHydrated = true;
  }
  return cachedTemplates;
}

export async function loadOrgGlobalCovenantTemplates(userId: string): Promise<GlobalCovenantTemplate[]> {
  cachedTemplates = await db.getOrgSetting<GlobalCovenantTemplate[]>(userId, GLOBAL_COVENANT_TEMPLATES_KEY, readJson<GlobalCovenantTemplate[]>(GLOBAL_COVENANT_TEMPLATES_KEY, []));
  templatesCacheHydrated = true;
  return cachedTemplates;
}

export async function saveGlobalCovenantTemplates(userId: string, templates: GlobalCovenantTemplate[]) {
  cachedTemplates = templates;
  templatesCacheHydrated = true;
  await db.setOrgSetting(userId, GLOBAL_COVENANT_TEMPLATES_KEY, templates);
}

export function loadParsedAccountCovenantMemory(): ParsedAccountCovenantMemory[] {
  if (!accountCovenantMemoryHydrated) {
    cachedAccountCovenantMemory = readJson<ParsedAccountCovenantMemory[]>(PARSED_ACCOUNT_COVENANT_MEMORY_KEY, []);
    accountCovenantMemoryHydrated = true;
  }
  return cachedAccountCovenantMemory;
}

export async function loadOrgParsedAccountCovenantMemory(userId: string): Promise<ParsedAccountCovenantMemory[]> {
  cachedAccountCovenantMemory = await db.getOrgSetting<ParsedAccountCovenantMemory[]>(
    userId,
    PARSED_ACCOUNT_COVENANT_MEMORY_KEY,
    readJson<ParsedAccountCovenantMemory[]>(PARSED_ACCOUNT_COVENANT_MEMORY_KEY, [])
  );
  accountCovenantMemoryHydrated = true;
  return cachedAccountCovenantMemory;
}

export async function saveParsedAccountCovenantMemory(userId: string, memory: ParsedAccountCovenantMemory[]) {
  cachedAccountCovenantMemory = memory;
  accountCovenantMemoryHydrated = true;
  await db.setOrgSetting(userId, PARSED_ACCOUNT_COVENANT_MEMORY_KEY, memory);
}

export function metricAliases(metric: ConsolidationMetric): string[] {
  return loadConsolidationRules().filter(r => r.metric === metric).flatMap(r => r.aliases);
}

export function findConsolidatedMetricValue(stmt: FinancialStatement_DB, metric: ConsolidationMetric): number | null {
  const rules = loadConsolidationRules().filter(r => r.metric === metric);
  for (const rule of rules) {
    const aliases = rule.aliases.map(cleanText).filter(Boolean);
    const found = stmt.rawLineItems.find(item => {
      const typeOk = !rule.statementType || rule.statementType === 'any' || rule.statementType === item.statementType;
      const itemName = cleanText(item.name);
      return typeOk && aliases.some(alias => itemName.includes(alias) || alias.includes(itemName));
    });
    if (found) return found.value;
  }
  return null;
}

export function inferMetricForAccount(name: string, statementType?: string | null): ConsolidationMetric | '' {
  const cleaned = cleanText(name);
  const candidates = loadConsolidationRules().filter(rule => !rule.statementType || rule.statementType === 'any' || !statementType || rule.statementType === statementType);
  const hit = candidates.find(rule => rule.aliases.some(alias => {
    const a = cleanText(alias);
    return cleaned.includes(a) || a.includes(cleaned);
  }));
  return hit?.metric || '';
}

export async function upsertCovenantTemplates(userId: string, next: GlobalCovenantTemplate[]): Promise<GlobalCovenantTemplate[]> {
  const existing = await loadOrgGlobalCovenantTemplates(userId);
  const byKey = new Map<string, GlobalCovenantTemplate>();
  [...existing, ...next].forEach(t => {
    const key = cleanText(`${t.name}:${t.formula || ''}`);
    const prev = byKey.get(key);
    byKey.set(key, prev ? { ...prev, ...t, seenCount: Math.max(prev.seenCount || 1, t.seenCount || 1) } : t);
  });
  const merged = Array.from(byKey.values()).sort((a, b) => b.seenCount - a.seenCount || a.name.localeCompare(b.name));
  await saveGlobalCovenantTemplates(userId, merged);
  return merged;
}

export function templatesFromExistingCovenants(covenants: Covenant_DB[]): GlobalCovenantTemplate[] {
  const financial = covenants.filter(c => c.type === 'financial' && (c.formula || c.name));
  const grouped = new Map<string, Covenant_DB[]>();
  financial.forEach(c => {
    const key = cleanText(c.formula || c.name);
    grouped.set(key, [...(grouped.get(key) || []), c]);
  });
  return Array.from(grouped.values()).map(group => {
    const first = group[0];
    return {
      id: `tpl-${cleanText(first.formula || first.name) || Date.now()}`,
      name: first.name,
      formula: first.formula || first.name,
      description: first.description || 'Detectado desde covenants existentes.',
      operator: first.operator || 'none',
      threshold: first.threshold || '',
      source: 'existing',
      active: false,
      seenCount: group.length,
      updatedAt: new Date().toISOString(),
    };
  });
}

function covenantSearchText(covenant: Pick<Covenant_DB, 'name' | 'formula' | 'description'>): string {
  return cleanText(`${covenant.name} ${covenant.formula || ''} ${covenant.description || ''}`);
}

function accountMetricHints(accountName: string, statementType?: string | null): string[] {
  const metric = inferMetricForAccount(accountName, statementType);
  if (!metric) return [];
  return [metric, METRIC_LABELS[metric], ...metricAliases(metric)].map(cleanText);
}

export function inferParsedAccountCovenantMemory(
  statements: FinancialStatement_DB[],
  covenants: Covenant_DB[],
  existing: ParsedAccountCovenantMemory[] = []
): ParsedAccountCovenantMemory[] {
  const byKey = new Map<string, ParsedAccountCovenantMemory>();
  existing.forEach(item => {
    byKey.set(`${cleanText(item.accountName)}:${item.statementType}:${cleanText(item.covenantName)}:${cleanText(item.covenantFormula)}`, item);
  });

  const accounts = new Map<string, { name: string; statementType: ParsedAccountCovenantMemory['statementType'] }>();
  statements.forEach(stmt => {
    stmt.rawLineItems.forEach(item => {
      const statementType = item.statementType || 'otro';
      accounts.set(`${statementType}:${cleanText(item.name)}`, { name: item.name, statementType });
    });
  });

  accounts.forEach(account => {
    const accountText = cleanText(account.name);
    const hints = accountMetricHints(account.name, account.statementType);
    covenants.filter(c => c.type === 'financial').forEach(covenant => {
      const covenantText = covenantSearchText(covenant);
      const directHit = accountText.length >= 4 && covenantText.includes(accountText);
      const metricHit = hints.some(hint => hint.length >= 4 && covenantText.includes(hint));
      if (!directHit && !metricHit) return;

      const id = `mem-${cleanText(account.name)}-${cleanText(covenant.name)}-${Date.now()}`;
      const key = `${cleanText(account.name)}:${account.statementType}:${cleanText(covenant.name)}:${cleanText(covenant.formula || covenant.name)}`;
      const prev = byKey.get(key);
      byKey.set(key, {
        id: prev?.id || id,
        accountName: account.name,
        statementType: account.statementType,
        covenantName: covenant.name,
        covenantFormula: covenant.formula || covenant.name,
        reason: directHit ? 'La cuenta aparece en el texto/fórmula del covenant.' : 'La cuenta mapea a una métrica usada por el covenant.',
        confidence: prev?.confidence ?? (directHit ? 0.82 : 0.7),
        source: prev?.source || 'heuristic',
        seenCount: Math.max(prev?.seenCount || 0, 1),
        updatedAt: new Date().toISOString(),
      });
    });
  });

  return Array.from(byKey.values()).sort((a, b) => b.confidence - a.confidence || b.seenCount - a.seenCount || a.accountName.localeCompare(b.accountName));
}
