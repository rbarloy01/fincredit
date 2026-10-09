import type { Covenant_DB, FinancialStatement_DB } from '../db/index';
import { findConsolidatedMetricValue, metricAliases } from './accountConsolidation';
import { parseNullableFinancialNumber } from './numberParsing';

export type RatioStatus = 'cumple' | 'alerta' | 'incumple' | 'sin_dato';
export type CovenantMovement = 'betterment' | 'deterioration' | 'stable' | 'new' | 'insufficient';

export function isPercentCovenant(cov: Covenant_DB) {
  const text = `${cov.name} ${cov.formula} ${cov.description || ''}`.toLowerCase();
  return text.includes('%') || text.includes('capital') || text.includes('roa') || text.includes('roe') || text.includes('margen') || text.includes('margin')
    || text.includes('rentabilidad') || text.includes('eficiencia');
}

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

// norm() strips spaces entirely, so a single extra/missing letter anywhere in a
// phrase (most commonly Spanish plural/singular agreement \u2014 "credito" vs
// "creditos", "cuenta" vs "cuentas") shifts every character after it and silently
// breaks substring matching, even though the two phrases mean the same thing.
// This word-level fallback tokenizes on real word boundaries first, strips a
// trailing pluralizing "s"/"es", and drops connector words, so "cartera de
// creditos vencida" still matches the alias "cartera de credito vencida".
const SPANISH_STOPWORDS = new Set(['de', 'la', 'el', 'los', 'las', 'y', 'a', 'por', 'para', 'con', 'en', 'del', 'al', 'o', 'u', 'e']);

function singularizeWord(word: string): string {
  if (word.length > 5 && word.endsWith('ces')) return `${word.slice(0, -3)}z`;
  if (word.length > 4 && word.endsWith('es')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s')) return word.slice(0, -1);
  return word;
}

function wordSet(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .filter(w => !SPANISH_STOPWORDS.has(w))
      .map(singularizeWord),
  );
}
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

// Character-trigram Dice similarity (the same technique behind PostgreSQL's
// pg_trgm fuzzy search) — an unsupervised, untrained fallback that "learns"
// only from the two strings being compared, so it needs no labeled training
// data to auto-match an account name FinMonitor has never seen phrased that
// way before. It only fires once exact/contains/wordSet all fail, and scores
// below every other tier, so it can only ever win a match no rule caught.
function charTrigrams(value: string): Map<string, number> {
  const grams = new Map<string, number>();
  const padded = `  ${value}  `;
  for (let i = 0; i < padded.length - 2; i++) {
    const gram = padded.slice(i, i + 3);
    grams.set(gram, (grams.get(gram) || 0) + 1);
  }
  return grams;
}

// Performance: findRaw compares every line item × alias, and the same account names
// repeat across statements, so trigram sets are built once per distinct string.
const trigramCache = new Map<string, { grams: Map<string, number>; total: number }>();
function cachedTrigrams(value: string) {
  let hit = trigramCache.get(value);
  if (!hit) {
    const grams = charTrigrams(value);
    let total = 0;
    grams.forEach(count => { total += count; });
    hit = { grams, total };
    trigramCache.set(value, hit);
  }
  return hit;
}

function trigramSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const A = cachedTrigrams(a);
  const B = cachedTrigrams(b);
  let intersection = 0;
  A.grams.forEach((count, gram) => {
    const other = B.grams.get(gram);
    if (other) intersection += Math.min(count, other);
  });
  const total = A.total + B.total;
  return total === 0 ? 0 : (2 * intersection) / total;
}

// Normalized views of a statement's line items, computed once per rawLineItems array
// (WeakMap: released with the statement). Alias lists are likewise prepared once.
interface PreparedItem { value: number; n: string; words: Set<string>; section: string; type: string; misc: boolean; digits: string }
const preparedItemsCache = new WeakMap<object, PreparedItem[]>();
function preparedItems(stmt: FinancialStatement_DB): PreparedItem[] {
  const items = rawLineItems(stmt);
  const cached = preparedItemsCache.get(items);
  if (cached) return cached;
  const prepared = items.map(item => {
    const n = norm(item.name);
    return { value: item.value, n, words: wordSet(item.name), section: norm(item.sectionPath || ''), type: item.statementType || 'otro', misc: hasMiscellaneousPrefix(n), digits: n.replace(/\D/g, '') };
  });
  preparedItemsCache.set(items, prepared);
  return prepared;
}

interface PreparedAlias { value: string; words: Set<string>; index: number; digits: string; misc: boolean }
const preparedAliasCache = new Map<string, PreparedAlias[]>();
function preparedAliases(names: string[]): PreparedAlias[] {
  const key = names.join('\u0001');
  let hit = preparedAliasCache.get(key);
  if (!hit) {
    hit = names
      .map((name, index) => { const value = norm(name); return { value, words: wordSet(name), index, digits: value.replace(/\D/g, ''), misc: hasMiscellaneousPrefix(value) }; })
      .filter(alias => alias.value);
    preparedAliasCache.set(key, hit);
  }
  return hit;
}

const FUZZY_MATCH_MIN_LENGTH = 6;
const FUZZY_MATCH_THRESHOLD = 0.55;
const FUZZY_MAX_SCORE = 485;

// Spanish accounting convention: an "otros/otras"-prefixed line ("Otros
// ingresos de la operación") is explicitly a residual/miscellaneous account,
// distinct from the primary concept it textually contains ("ingresos de la
// operación"). A plain substring/word-superset check can't tell the
// difference, so it treats "other operating income" as if it were core
// operating income. Guard the two match directions where the item is the
// superset (contains the alias, or has all the alias's words plus more).
function hasMiscellaneousPrefix(value: string): boolean {
  return value.startsWith('otros') || value.startsWith('otras');
}

// findRaw depends only on the line items + alias list + types, so its result is cached
// per rawLineItems array (getMetric re-asks the same lookups via recursive metrics).
const findRawCache = new WeakMap<object, Map<string, number | null>>();
function findRaw(stmt: FinancialStatement_DB, names: string[], types?: string[], exclude?: RegExp): number | null {
  const items = rawLineItems(stmt);
  let perStmt = findRawCache.get(items);
  if (!perStmt) { perStmt = new Map(); findRawCache.set(items, perStmt); }
  const key = `${names.join('\u0001')}\u0002${types ? types.join(',') : '*'}\u0002${exclude ? exclude.source : ''}`;
  if (perStmt.has(key)) return perStmt.get(key) as number | null;
  const result = findRawUncached(stmt, names, types, exclude);
  perStmt.set(key, result);
  return result;
}

function findRawUncached(stmt: FinancialStatement_DB, names: string[], types?: string[], exclude?: RegExp): number | null {
  const aliases = preparedAliases(names);
  let best: { value: number; score: number } | null = null;
  preparedItems(stmt).forEach((item, itemIndex) => {
    const { n, words: itemWords, section } = item;
    const typeOk = !types || types.includes(item.type);
    if (!typeOk) return;
    if (exclude && exclude.test(item.n)) return;
    const itemIsMiscellaneous = item.misc;
    const itemDigits = item.digits;
    aliases.forEach(alias => {
      // Un alias con número ("etapa 3") nunca debe emparejar con otro número ("etapa 1"): el match aproximado los confunde.
      if (alias.digits && alias.digits !== itemDigits) return;
      const aliasIsMiscellaneous = alias.misc;
      const blockMiscellaneous = itemIsMiscellaneous && !aliasIsMiscellaneous;
      const exact = n === alias.value;
      const contains = !blockMiscellaneous && n.includes(alias.value);
      // Only treat "alias contains item" as a match when the item name is a genuine
      // abbreviation of the alias (close in length) — otherwise a short generic
      // account like "TOTAL ACTIVO" spuriously matches a longer, more specific
      // alias like "total activo a corto plazo" just because it's a text prefix.
      const reverseContains = alias.value.includes(n) && n.length >= alias.value.length * 0.6;
      // Fallback for phrases that mean the same thing but don't line up character-
      // for-character (plural/singular agreement, stray connector words) — compare
      // word sets instead. Guarded the same way as contains/reverseContains: the
      // smaller side must cover the larger closely enough to avoid short generic
      // phrases fuzzy-matching much longer, unrelated ones.
      const wordMatch = !exact && !contains && !reverseContains && alias.words.size >= 2 && itemWords.size >= 2 && (
        (!blockMiscellaneous && [...alias.words].every(w => itemWords.has(w))) ||
        ([...itemWords].every(w => alias.words.has(w)) && itemWords.size >= alias.words.size * 0.6)
      );
      // A fuzzy hit scores at most 150+100+120+80+35 = 485, so once a match above that
      // exists it can never win — skip the (expensive) trigram comparison.
      const fuzzySimilarity = !exact && !contains && !reverseContains && !wordMatch && !blockMiscellaneous
        && (!best || best.score <= FUZZY_MAX_SCORE)
        && alias.value.length >= FUZZY_MATCH_MIN_LENGTH && n.length >= FUZZY_MATCH_MIN_LENGTH
        ? trigramSimilarity(alias.value, n)
        : 0;
      const fuzzyMatch = fuzzySimilarity >= FUZZY_MATCH_THRESHOLD;
      if (!exact && !contains && !reverseContains && !wordMatch && !fuzzyMatch) return;
      let score = exact ? 1000 : contains ? 700 : reverseContains ? 450 : wordMatch ? 300 : 150 + fuzzySimilarity * 100;
      score += Math.max(0, 120 - alias.index);
      if (n.includes('total') || n.includes('subtotal') || section.includes('total')) score += 80;
      if (n.includes('neto') || n.includes('neta')) score += 35;
      score -= itemIndex / 1000;
      if (!best || score > best.score) best = { value: item.value, score };
    });
  });
  return best?.value ?? null;
}

// findRaw's fuzzy tiers (reverseContains, wordMatch) match on character/word
// *coverage*, so dropping one qualifying word from a longer alias (e.g.
// "margen financiero ajustado" -> "Margen Financiero") still clears their
// ~60% threshold. That's fine for most aliases, but wrong when the dropped
// word is the one thing distinguishing two real, different accounts — like
// the risk-adjusted margin vs. the plain one. This bypasses the fuzzy tiers
// entirely and requires a literal substring match on the qualifying word.
function findRawRequiringSubstring(stmt: FinancialStatement_DB, requiredSubstrings: string[], types?: string[]): number | null {
  const needles = requiredSubstrings.map(norm);
  const match = rawLineItems(stmt).find(item => {
    const typeOk = !types || types.includes(item.statementType || 'otro');
    if (!typeOk) return false;
    const n = norm(item.name);
    return needles.some(needle => n.includes(needle));
  });
  return match?.value ?? null;
}

function firstValue(...values: Array<number | null | undefined>): number | null {
  const found = values.find(value => value !== null && value !== undefined);
  return found ?? null;
}

// Treat an exact 0 as "not present" so a downstream firstValue() fallback can
// fire. Used for mapped fields where 0 is an extraction artifact rather than a
// real reported figure — notably mapped_data.ebitda, which the ingestion prompt
// computes as revenue − cogs − operatingExpenses; for IFNBs/SOFOMes (structured
// around financial margin) those three are all 0, so a 0 EBITDA really means
// "never computed", and the raw "utilidad de operación" fallback should win.
function nz(value: number | null | undefined): number | null {
  return value === null || value === undefined || value === 0 ? null : value;
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

// Línea de cartera vencida literal ("Cartera vencida", "Total de cartera vencida", "Créditos vencidos"): prefiere el
// total sobre los tramos por días y descarta líneas que mezclan vigente ("Cartera total (Vigente y Vencida)").
function overduePortfolio(stmt: FinancialStatement_DB): number | null {
  const items = rawLineItems(stmt).filter(item => {
    if ((item.statementType || 'otro') !== 'balance_general' || typeof item.value !== 'number') return false;
    const n = norm(item.name);
    return n.includes('vencid') && !/(vigente|estimacion|reserva|interes|dias)/.test(n);
  });
  if (!items.length) return null;
  const total = items.find(item => norm(item.name).includes('total')) || items.find(item => /^(cartera|creditos?|saldo)vencid/.test(norm(item.name)));
  return (total || items[0]).value as number;
}

function stagedPortfolioItems(stmt: FinancialStatement_DB, stage: '1' | '2' | '3') {
  return rawLineItems(stmt).filter(item =>
    (item.statementType || 'otro') === 'balance_general'
    && typeof item.value === 'number'
    && norm(item.name).includes(`etapa${stage}`),
  );
}

function stage3Portfolio(stmt: FinancialStatement_DB): number | null {
  const items = stagedPortfolioItems(stmt, '3');
  if (!items.length) return null;
  const total = items.find(item => norm(item.name).includes('total'));
  return total ? (total.value as number) : items.reduce((sum, item) => sum + (item.value as number), 0);
}

function hasStagedPortfolio(stmt: FinancialStatement_DB): boolean {
  return stagedPortfolioItems(stmt, '1').length > 0 || stagedPortfolioItems(stmt, '2').length > 0;
}

export function getMetric(stmt: FinancialStatement_DB, key: string): number | null {
  const m = asObject<FinancialStatement_DB['mappedData']>((stmt as any).mappedData);
  const raw = (names: string[], types?: string[]) => findRaw(stmt, names, types);
  switch (key) {
    case 'revenue': return firstValue(m.revenue, findConsolidatedMetricValue(stmt, 'revenue'), raw(['ingresos', 'ventas', ...metricAliases('revenue')], ['estado_resultados']));
    case 'interestIncome': return firstValue(findConsolidatedMetricValue(stmt, 'interestIncome'), raw(['ingresos por intereses', 'intereses cobrados', 'ingreso por interes', ...metricAliases('interestIncome')], ['estado_resultados']));
    case 'feeIncome': return firstValue(findConsolidatedMetricValue(stmt, 'feeIncome'), raw(['ingresos por comisiones', 'comisiones cobradas', 'ingreso por comision', ...metricAliases('feeIncome')], ['estado_resultados']));
    // Arrendadoras: el ingreso principal es la renta, no los intereses; sin sumarla, los márgenes salen en cientos de %.
    case 'coreBusinessIncome': return firstValue(findConsolidatedMetricValue(stmt, 'coreBusinessIncome'), addValues(getMetric(stmt, 'interestIncome'), getMetric(stmt, 'feeIncome'), findRawRequiringSubstring(stmt, ['ingresos por renta', 'ingresos por arrendamiento'], ['estado_resultados'])), getMetric(stmt, 'revenue'));
    // Even the full alias "margen financiero ajustado" fuzzy-matches a plain
    // "Margen Financiero" line via findRaw's reverseContains/wordMatch tiers
    // (dropping just the word "ajustado" still clears their ~60% coverage
    // threshold) — silently substituting the unadjusted margin for the
    // risk-adjusted one. This metric has no legitimate unadjusted fallback
    // (unlike adjustedOperatingIncome below), so require "ajustad" literally.
    case 'adjustedFinancialMargin': return firstValue(findRawRequiringSubstring(stmt, ['ajustad', ...metricAliases('adjustedFinancialMargin')], ['estado_resultados']), findConsolidatedMetricValue(stmt, 'adjustedFinancialMargin'));
    case 'adjustedOperatingIncome': return firstValue(raw(['utilidad o perdida de operacion', 'utilidad o pérdida de operación', 'utilidad de operacion', 'utilidad operativa ajustada', 'utilidad operacion ajustada', 'utilidad de operacion ajustada', 'resultado de operacion', ...metricAliases('adjustedOperatingIncome')], ['estado_resultados']), findConsolidatedMetricValue(stmt, 'adjustedOperatingIncome'));
    case 'adminSellingOperatingExpenses': return absoluteValue(firstValue(raw(['gastos de operacion total', 'gastos de operación total', 'gastos de operacion (total)', 'gastos de administracion venta y operacion', 'gastos adm venta opn', 'gastos administrativos', 'gastos de operacion', ...metricAliases('adminSellingOperatingExpenses')], ['estado_resultados']), findConsolidatedMetricValue(stmt, 'adminSellingOperatingExpenses')));
    case 'ebitda': return firstValue(nz(m.ebitda), findConsolidatedMetricValue(stmt, 'ebitda'), raw(['ebitda', ...metricAliases('ebitda')], ['estado_resultados']), raw(['utilidad operacion', 'utilidad de operacion', 'resultado de operacion', 'utilidad antes de intereses'], ['estado_resultados']));
    case 'interestExpense': return absoluteValue(firstValue(m.interestExpense, raw(['gastos por intereses', 'gasto por intereses', 'gasto financiero', 'intereses pagados', 'intereses devengados', 'resultado integral de financiamiento', ...metricAliases('interestExpense')], ['estado_resultados']), findConsolidatedMetricValue(stmt, 'interestExpense')));
    case 'netIncome': return firstValue(m.netIncome, findConsolidatedMetricValue(stmt, 'netIncome'), raw(['utilidad neta', 'resultado neto', 'utilidad o perdida', 'utilidad (o perdida)', 'perdida del ejercicio', ...metricAliases('netIncome')], ['estado_resultados']));
    // Literal: el match aproximado confundía "activo a corto plazo" con "total activo" (razón corriente = 15x en arrendadoras sin clasificación).
    case 'currentAssets': return firstValue(nz(m.currentAssets), findConsolidatedMetricValue(stmt, 'currentAssets'), findRawRequiringSubstring(stmt, ['activo circulante', 'activo corriente', 'total activo a corto plazo', 'activo a corto plazo', 'activo corto plazo'], ['balance_general']), raw(metricAliases('currentAssets'), ['balance_general']));
    case 'currentLiabilities': return firstValue(m.currentLiabilities, findConsolidatedMetricValue(stmt, 'currentLiabilities'), raw(['pasivo circulante', 'pasivo corriente', 'total pasivo a corto plazo', 'pasivo a corto plazo', ...metricAliases('currentLiabilities')], ['balance_general']));
    case 'totalDebt': return firstValue(m.totalDebt, addValues(getMetric(stmt, 'banksFundsShortTerm'), getMetric(stmt, 'banksFundsLongTerm')), raw(['deuda total', 'prestamos total', 'préstamos total', 'pasivo con costo', 'deuda', ...metricAliases('totalDebt')], ['balance_general']), findConsolidatedMetricValue(stmt, 'totalDebt'));
    case 'banksFundsShortTerm': return firstValue(raw(['prestamos total corto plazo', 'préstamos total corto plazo', 'prestamos (total corto plazo)', 'prestamos corto plazo', 'préstamos corto plazo', 'bancos y fondos corto plazo', 'bancos y fondos cp', 'fondeo corto plazo', 'prestamos bancarios y de otros organismos de corto plazo', 'prestamos interbancarios y de otros organismos de corto plazo', ...metricAliases('banksFundsShortTerm')], ['balance_general']), findConsolidatedMetricValue(stmt, 'banksFundsShortTerm'));
    case 'banksFundsLongTerm': return firstValue(raw(['prestamos total largo plazo', 'préstamos total largo plazo', 'prestamos (total largo plazo)', 'prestamos largo plazo', 'préstamos largo plazo', 'bancos y fondos largo plazo', 'bancos y fondos lp', 'fondeo largo plazo', 'prestamos bancarios y de otros organismos de largo plazo', 'prestamos interbancarios y de otros organismos de largo plazo', ...metricAliases('banksFundsLongTerm')], ['balance_general']), findConsolidatedMetricValue(stmt, 'banksFundsLongTerm'));
    case 'totalLiabilities': return firstValue(raw(['total de pasivo', 'total, de pasivo', 'total pasivo', 'suma del pasivo', 'pasivo total', ...metricAliases('totalLiabilities')], ['balance_general']), findConsolidatedMetricValue(stmt, 'totalLiabilities'), getMetric(stmt, 'totalDebt'));
    // Activos totales / capital contable en exactamente 0 = extracción fallida (Red Girasol abr-26), no un dato: se usa el renglón del balance.
    case 'totalAssets': return firstValue(nz(m.totalAssets), findConsolidatedMetricValue(stmt, 'totalAssets'), raw(['total activo', 'activos totales', 'suma del activo', ...metricAliases('totalAssets')], ['balance_general']));
    // "Total de Pasivo + Capital" NO es capital contable (tiene las palabras "total" y "capital"): ICAP salía 100% (Kredi jul-23).
    case 'equity': {
      // Un "capital" igual al renglón combinado "pasivo + capital" (o "liabilities and capital") es el total del balance,
      // venga del mapeo, de las reglas de consolidación o del texto: se descarta.
      const combined = rawLineItems(stmt)
        .filter(i => /(pasivo|liabilit)/i.test(i.name) && /(capital|equity|patrimonio)/i.test(i.name) && typeof i.value === 'number')
        .map(i => i.value as number);
      const valid = (v: number | null | undefined) => (v === null || v === undefined || combined.some(c => Math.abs(c - v) < 0.5) ? null : v);
      return firstValue(valid(nz(m.equity)), valid(findConsolidatedMetricValue(stmt, 'equity')), valid(findRaw(stmt, ['capital contable', 'patrimonio', 'suma del capital', 'total capital', ...metricAliases('equity')], ['balance_general'], /pasivo|liabilit/)));
    }
    case 'cash': return firstValue(findConsolidatedMetricValue(stmt, 'cash'), raw(['efectivo', 'bancos', 'equivalentes de efectivo', ...metricAliases('cash')], ['balance_general']));
    case 'availableInvestments': return firstValue(raw(['inversiones temporales', 'inversiones disponibles', 'inversiones en valores', 'inversiones no comprometidas', ...metricAliases('availableInvestments')], ['balance_general']), findConsolidatedMetricValue(stmt, 'availableInvestments'));
    case 'loanPortfolio': return firstValue(raw(['cartera de credito subtotal', 'cartera de credito (subtotal)', 'cartera de credito total', 'cartera de credito', 'cartera vigente', 'creditos vigentes', ...metricAliases('loanPortfolio')], ['balance_general']), findConsolidatedMetricValue(stmt, 'loanPortfolio'));
    case 'netPortfolio': return firstValue(raw(['cartera de credito neto', 'cartera de credito, neto', 'cartera neta', 'cartera de credito neta', ...metricAliases('netPortfolio')], ['balance_general']), findConsolidatedMetricValue(stmt, 'netPortfolio'), subtractValues(getMetric(stmt, 'managedPortfolio'), getMetric(stmt, 'loanLossReserves')));
    case 'managedPortfolio': return firstValue(raw(['cartera administrada', 'cartera total administrada', 'portafolio administrado', 'total cartera de credito', 'total, cartera de credito', ...metricAliases('managedPortfolio')], ['balance_general']), getMetric(stmt, 'loanPortfolio'), findConsolidatedMetricValue(stmt, 'managedPortfolio'));
    // "Etapa 3" se busca literal: el match aproximado de findRaw confunde "etapa 3" con "etapa 1" y tomaba la cartera
    // vigente completa como vencida (100%). Si el estado trae etapas pero ninguna 3, la cartera vencida es 0.
    case 'pastDuePortfolio': return firstValue(stage3Portfolio(stmt), overduePortfolio(stmt), findConsolidatedMetricValue(stmt, 'pastDuePortfolio'), hasStagedPortfolio(stmt) ? 0 : null);
    case 'loanLossReserves': return absoluteValue(firstValue(raw(['estimacion de cuentas incobrables', 'estimacion preventiva para riesgos crediticios', 'estimacion preventiva', 'reservas crediticias', 'reserva para perdidas crediticias', ...metricAliases('loanLossReserves')], ['balance_general']), findConsolidatedMetricValue(stmt, 'loanLossReserves')));
    // Arrendadoras: los bienes en arrendamiento son activo productivo (generan la renta), igual que la cartera.
    case 'productiveAssets': return firstValue(findConsolidatedMetricValue(stmt, 'productiveAssets'), addValues(getMetric(stmt, 'cash'), getMetric(stmt, 'availableInvestments'), getMetric(stmt, 'loanPortfolio'), findRawRequiringSubstring(stmt, ['bienes en arrendamiento', 'activos en arrendamiento', 'equipo en arrendamiento'], ['balance_general'])));
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

// Covenant formulas intentionally treat missing references as 0; division by 0 still returns null via div().
function metricValueOrZero(stmt: FinancialStatement_DB, key: string): number {
  return getMetric(stmt, key) ?? 0;
}

// ── Anualización de ratios de resultados ─────────────────────────────────────
// ROA, ROE, rendimiento, costo de fondeo y Deuda/EBITDA mezclan un flujo del estado de resultados con un saldo. Los EEFF
// mensuales mexicanos suelen venir ACUMULADOS enero→mes (abril = 4 meses), así que sin anualizar abril parece "deterioro"
// frente a diciembre (12 meses). Regla: se anualiza el flujo con 12 / meses del periodo.
//   1) la etiqueta lo dice (mensual / acumulado / trimestre); 2) si hay otros periodos del mismo año, se infiere por la serie
//   (ingresos que solo crecen = acumulado; que suben y bajan = mensual); 3) diciembre = 12 meses; 4) si no hay evidencia
//   se asume acumulado enero→mes (así viene el 77% de las series reales) y se dice en la fórmula.
export function incomeSpan(stmt: FinancialStatement_DB, siblings: FinancialStatement_DB[] = []): { months: number; basis: string } {
  const month = Math.min(12, Math.max(1, parseInt(String(stmt.periodDate || '').slice(5, 7), 10) || 12));
  const text = `${stmt.period || ''} ${stmt.fileName || ''}`.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (/mensual|monthly|del mes\b/.test(text)) return { months: 1, basis: 'mensual' };
  if (/acumul|ytd|ene[\s.-]*(a|-)|enero\s*(a|-)/.test(text)) return { months: month, basis: 'acumulado' };
  const year = String(stmt.periodDate || '').slice(0, 4);
  const sameYear = [...siblings, stmt]
    .filter((s, i, arr) => s.periodDate?.startsWith(year) && arr.findIndex(o => o.id === s.id) === i)
    .map(s => ({ date: s.periodDate, revenue: getMetric(s, 'revenue') }))
    .filter((r): r is { date: string; revenue: number } => r.revenue !== null && r.revenue > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (sameYear.length >= 3) {
    const rising = sameYear.every((r, i) => i === 0 || r.revenue >= sameYear[i - 1].revenue * 0.98) && sameYear[sameYear.length - 1].revenue > sameYear[0].revenue * 1.3;
    if (rising) return { months: month, basis: 'acumulado (inferido por la serie)' };
    return { months: 1, basis: 'mensual (inferido por la serie)' };
  }
  if (month === 12) return { months: 12, basis: 'anual' };
  return { months: month, basis: 'acumulado ene→mes (supuesto)' };
}

export function standardRatios(stmt: FinancialStatement_DB, siblings: FinancialStatement_DB[] = []): RatioResult[] {
  const span = incomeSpan(stmt, siblings);
  const f = 12 / span.months; // factor de anualización de flujos
  const annualNote = f === 1 ? '' : ` · flujo anualizado ×${f.toFixed(2)} (${span.basis}, ${span.months} meses)`;
  const scale = (v: number | null) => (v === null ? null : v * f);
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
  const costOfFunding = div(scale(interest), fundingDebt);
  const portfolioYield = div(scale(interestIncome), managedPortfolio);
  const miss = (items: Array<[string, number | null]>) => items.filter(([, value]) => value === null).map(([label]) => label);
  return [
    { key: 'revenue', label: 'Ingresos', value: revenue, formula: 'Cuenta extraída: ingresos/ventas', missing: miss([['Ingresos', revenue]]) },
    { key: 'ebitda', label: 'EBITDA', value: ebitda, formula: 'EBITDA o utilidad de operación', missing: miss([['EBITDA', ebitda]]) },
    { key: 'ifnb_financial_margin', label: 'Margen Financiero', value: div(adjustedFinancialMargin, coreBusinessIncome), formula: 'Margen financiero ajustado / (ingresos por intereses + ingresos por comisiones)', missing: miss([['Margen financiero ajustado', adjustedFinancialMargin], ['Ingresos core', coreBusinessIncome]]) },
    { key: 'ifnb_operating_profitability', label: 'Rentabilidad Operativa', value: div(adjustedOperatingIncome, coreBusinessIncome), formula: 'Utilidad operativa ajustada / ingresos core del negocio', missing: miss([['Utilidad operativa ajustada', adjustedOperatingIncome], ['Ingresos core', coreBusinessIncome]]) },
    { key: 'ifnb_net_margin', label: 'Margen Neto', value: div(netIncome, coreBusinessIncome), formula: 'Utilidad neta / ingresos core del negocio', missing: miss([['Utilidad neta', netIncome], ['Ingresos core', coreBusinessIncome]]) },
    { key: 'ifnb_operating_efficiency', label: 'Eficiencia Operativa', value: div(adminSellingOperatingExpenses, coreBusinessIncome), formula: 'Gastos de administración, venta y operación / ingresos core del negocio', missing: miss([['Gastos adm., venta y operación', adminSellingOperatingExpenses], ['Ingresos core', coreBusinessIncome]]) },
    { key: 'debt_ebitda', label: 'Deuda / EBITDA', value: div(totalDebt, scale(ebitda)), formula: `Deuda total / EBITDA${annualNote}`, missing: miss([['Deuda total', totalDebt], ['EBITDA', ebitda]]) },
    { key: 'dscr', label: 'DSCR', value: div(ebitda, interest), formula: 'EBITDA / gasto financiero', missing: miss([['EBITDA', ebitda], ['Gasto financiero', interest]]) },
    { key: 'current_ratio', label: 'Razón Corriente', value: div(currentAssets, currentLiabilities), formula: 'Activo corriente / Pasivo corriente', missing: miss([['Activo corriente', currentAssets], ['Pasivo corriente', currentLiabilities]]) },
    { key: 'leverage', label: 'Apalancamiento', value: div(fundingDebt, totalAssets), formula: '(Bancos y fondos CP + LP) / total activo', missing: miss([['Bancos y fondos CP + LP', fundingDebt], ['Activos totales', totalAssets]]) },
    { key: 'debt_equity', label: 'Deuda / Capital', value: div(totalDebt, equity), formula: 'Deuda total / capital contable', missing: miss([['Deuda total', totalDebt], ['Capital contable', equity]]) },
    { key: 'capitalization', label: 'ICAP', value: div(equity, totalAssets), formula: 'Capital contable / activos totales', missing: miss([['Capital contable', equity], ['Activos totales', totalAssets]]) },
    { key: 'adjusted_capitalization', label: 'ICAP Ajustado', value: div(equity, netPortfolio), formula: 'Capital contable / cartera neta', missing: miss([['Capital contable', equity], ['Cartera neta', netPortfolio]]) },
    { key: 'roa', label: 'ROA', value: div(scale(netIncome), totalAssets), formula: `Utilidad neta / activos totales${annualNote}`, missing: miss([['Utilidad neta', netIncome], ['Activos totales', totalAssets]]) },
    { key: 'roe', label: 'ROE', value: div(scale(netIncome), equity), formula: `Utilidad neta / capital contable${annualNote}`, missing: miss([['Utilidad neta', netIncome], ['Capital contable', equity]]) },
    { key: 'past_due_portfolio', label: 'Cartera Vencida', value: div(pastDuePortfolio, managedPortfolio), formula: 'Cartera vencida / cartera administrada', missing: miss([['Cartera vencida', pastDuePortfolio], ['Cartera administrada', managedPortfolio]]) },
    { key: 'net_past_due_portfolio', label: 'Cartera Vencida Neta', value: div(subtractValues(pastDuePortfolio, loanLossReserves), managedPortfolio), formula: '(Cartera vencida - estimación preventiva) / cartera administrada', missing: miss([['Cartera vencida', pastDuePortfolio], ['Estimación preventiva', loanLossReserves], ['Cartera administrada', managedPortfolio]]) },
    { key: 'past_due_coverage', label: 'Índice de Cobertura de Cartera Vencida', value: div(loanLossReserves, pastDuePortfolio), formula: 'Estimación preventiva / cartera vencida', missing: miss([['Estimación preventiva', loanLossReserves], ['Cartera vencida', pastDuePortfolio]]) },
    { key: 'debt_coverage_productive_assets', label: 'Cobertura de Deuda', value: div(productiveAssets, totalLiabilities), formula: 'Activos productivos / total pasivo', missing: miss([['Activos productivos', productiveAssets], ['Total pasivo', totalLiabilities]]) },
    { key: 'funding_cost', label: 'Costo de Fondeo Aproximado', value: costOfFunding, formula: `Gasto financiero / bancos y fondos CP + LP${annualNote}`, missing: miss([['Gasto financiero', interest], ['Bancos y fondos CP + LP', fundingDebt]]) },
    { key: 'portfolio_yield', label: 'Rendimiento de Cartera (Yield)', value: portfolioYield, formula: `Ingresos por intereses / cartera administrada${annualNote}`, missing: miss([['Ingresos por intereses', interestIncome], ['Cartera administrada', managedPortfolio]]) },
    { key: 'financial_spread', label: 'Spread Financiero Aproximado', value: portfolioYield !== null && costOfFunding !== null ? portfolioYield - costOfFunding : null, formula: `Rendimiento de cartera - costo de fondeo aproximado${annualNote}`, missing: miss([['Rendimiento de cartera', portfolioYield], ['Costo de fondeo', costOfFunding]]) },
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
    return div(metricValueOrZero(stmt, num), metricValueOrZero(stmt, den));
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
  if (token.startsWith('ref:')) return metricValueOrZero(stmt, token.slice(4));
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

// Percent-scale covenants (ICAP, márgenes, ROA/ROE, etc.) compute their value as
// a 0-1 fraction but display it ×100 with a "%" suffix, so an analyst typing a
// threshold like "15" naturally means "15%" (0.15), not the literal number 15.
// Only rescale when the threshold wasn't already entered as a small fraction
// (e.g. "0.15"), matching the >3 cutoff the UI uses to decide value display.
export function resolveCovenantThreshold(cov: Covenant_DB): number | null {
  const parsedThreshold = parseNullableFinancialNumber(cov.threshold);
  if (parsedThreshold === null) return null;
  const impliedPercentThreshold = isPercentCovenant(cov) && Math.abs(parsedThreshold) > 3;
  return /%/.test(cov.threshold) || impliedPercentThreshold ? parsedThreshold / 100 : parsedThreshold;
}

// Standard ratios that mix an income-statement flow with a balance. Interim statements are usually accumulated Jan→month, so
// comparing April (4 months) with December (12) as-is reads as a fake deterioration.
const ANNUALIZED_STANDARD_KEYS = ['debt_ebitda', 'roa', 'roe', 'funding_cost', 'portfolio_yield', 'financial_spread'];
export function annualizedStandardKey(formula: string): string | null {
  return ANNUALIZED_STANDARD_KEYS.find(key => standardRatioFormula(key) === formula) || null;
}

// Rule: an indicator WITH a contractual limit is measured literally (the contract defines how it is tested); an indicator
// WITHOUT a limit is pure monitoring and is compared on an annualized basis so periods of different length are comparable.
export function evaluateCovenantForStatement(cov: Covenant_DB, stmt: FinancialStatement_DB, siblings: FinancialStatement_DB[] = []): { value: number | null; status: RatioStatus; formula: string; annualized?: boolean } {
  const formula = cov.formulaByPeriod?.[stmt.period] || cov.formula || cov.name;
  const hasLimit = cov.operator !== 'none' && resolveCovenantThreshold(cov) !== null;
  const standardKey = hasLimit ? null : annualizedStandardKey(formula);
  if (standardKey) {
    const annual = standardRatios(stmt, siblings).find(r => r.key === standardKey)?.value ?? null;
    return { value: annual, status: 'cumple', formula, annualized: true };
  }
  const value = evaluateFormula(formula, stmt);
  // Sin valor no hay cumplimiento que afirmar: antes salía "cumple" y escondía el incumplimiento del corte previo.
  if (value === null) return { value, status: 'sin_dato', formula };
  if (cov.operator === 'none') return { value, status: 'cumple', formula };
  const threshold = resolveCovenantThreshold(cov);
  if (threshold === null) return { value, status: 'cumple', formula };
  let ok = true;
  if (cov.operator === 'gt') ok = value > threshold;
  if (cov.operator === 'gte') ok = value >= threshold;
  if (cov.operator === 'lt') ok = value < threshold;
  if (cov.operator === 'lte') ok = value <= threshold;
  if (!ok) return { value, status: 'incumple', formula };
  // "Alerta" flags values sitting within 15% of the threshold, scaled by the
  // threshold's own magnitude. That's undefined when threshold is 0 (nothing
  // is "close to zero" in relative terms), so a compliant value can't be
  // near-breach in that case — just report cumple.
  if (threshold === 0) return { value, status: 'cumple', formula };
  return { value, status: Math.abs((value - threshold) / threshold) < 0.15 ? 'alerta' : 'cumple', formula };
}

export function evaluateCovenantAuto(cov: Covenant_DB, statements: FinancialStatement_DB[]): { value: number | null; status: RatioStatus; mode: 'auto' | 'manual' } {
  const latest = [...statements].sort((a, b) => a.periodDate.localeCompare(b.periodDate)).at(-1);
  if (!latest || cov.type !== 'financial') return { value: null, status: 'cumple', mode: cov.complianceStatus ? 'manual' : 'auto' };
  if (cov.complianceStatus?.startsWith('manual:')) {
    return { value: null, status: cov.complianceStatus.replace('manual:', '') as RatioStatus, mode: 'manual' };
  }
  const result = evaluateCovenantForStatement(cov, latest, statements);
  return { value: result.value, status: result.status, mode: 'auto' };
}

// Which way is "better" for a covenant. With a real threshold the contract operator decides (gte/gt = higher is
// better, lte/lt = lower is better). Without a threshold the operator is meaningless (it is just the form default),
// so the direction comes from the ratio itself: ICAP, ROA, DSCR, márgenes… improve when they rise; apalancamiento,
// cartera vencida, eficiencia… improve when they fall.
const RATIO_POLARITY: Record<string, 'higher' | 'lower'> = {
  revenue: 'higher', ebitda: 'higher', ifnb_financial_margin: 'higher', ifnb_operating_profitability: 'higher', ifnb_net_margin: 'higher',
  dscr: 'higher', current_ratio: 'higher', capitalization: 'higher', adjusted_capitalization: 'higher', roa: 'higher', roe: 'higher',
  past_due_coverage: 'higher', debt_coverage_productive_assets: 'higher', immediate_liquidity: 'higher', portfolio_yield: 'higher', financial_spread: 'higher',
  ifnb_operating_efficiency: 'lower', debt_ebitda: 'lower', leverage: 'lower', debt_equity: 'lower', past_due_portfolio: 'lower',
  net_past_due_portfolio: 'lower', funding_cost: 'lower', past_due_to_equity: 'lower',
};
export const ratioPolarity = (key: string): 'higher' | 'lower' | null => RATIO_POLARITY[key] ?? null;
const plainText = (v: string) => v.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const HIGHER_NAME = /(icap|capitaliz|solvencia|cobertura|dscr|liquidez|razon corriente|\broa\b|\broe\b|margen|rentabilidad|spread|yield)/;
const LOWER_NAME = /(apalanc|leverage|endeud|deuda\s*\/|vencid|morosidad|\bmora\b|eficiencia|costo de fondeo|incobrab|castigo)/;

export function covenantDirection(cov: Pick<Covenant_DB, 'operator' | 'threshold' | 'formula' | 'name'>): 'higher' | 'lower' | null {
  const hasThreshold = parseNullableFinancialNumber(cov.threshold) !== null;
  if (hasThreshold) {
    if (cov.operator === 'gte' || cov.operator === 'gt') return 'higher';
    if (cov.operator === 'lte' || cov.operator === 'lt') return 'lower';
  }
  const key = Object.keys(RATIO_POLARITY).find(k => standardRatioFormula(k) === cov.formula);
  if (key) return RATIO_POLARITY[key];
  const text = plainText(`${cov.name || ''} ${cov.formula || ''}`);
  if (HIGHER_NAME.test(text)) return 'higher';
  if (LOWER_NAME.test(text)) return 'lower';
  if (cov.operator === 'gte' || cov.operator === 'gt') return 'higher';
  if (cov.operator === 'lte' || cov.operator === 'lt') return 'lower';
  return null;
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
  const rank: Record<RatioStatus, number> = { cumple: 0, sin_dato: 0, alerta: 1, incumple: 2 };
  if (previousStatus && rank[status] > rank[previousStatus]) return 'deterioration';
  if (previousStatus && rank[status] < rank[previousStatus]) return 'betterment';
  const delta = value - previousValue;
  if (Math.abs(delta) < 0.000001) return 'stable';
  const direction = covenantDirection(cov);
  if (direction === 'lower') return delta < 0 ? 'betterment' : 'deterioration';
  if (direction === 'higher') return delta > 0 ? 'betterment' : 'deterioration';
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
    const result = evaluateCovenantForStatement(cov, stmt, ordered);
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
  const statusRank: Record<RatioStatus, number> = { incumple: 0, alerta: 1, cumple: 2, sin_dato: 3 };
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
      bullets: ['Cargar al menos un estado financiero y configurar los indicadores financieros aplicables.'],
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
  return `Actúa como analista senior de crédito. Analiza el desempeño periodo contra periodo de los indicadores financieros de ${clientName || 'este cliente'}.

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
