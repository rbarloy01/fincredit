import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ClipboardList, FileSpreadsheet, FileText, Filter, Layers, RotateCcw } from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { db, Client, CustomField, FinancialStatement_DB, normalizeFinancialWriteValue, Transaction } from '../../db/index';
import { standardRatios } from '../../lib/financialMetrics';
import { supabase } from '../../lib/supabase';
import type { SheetDef } from '../../lib/export';
import WorkingOverlay from '../common/WorkingOverlay';

type BenchRow = {
  client: Client;
  fields: CustomField[];
  statements: FinancialStatement_DB[];
  transactions: Transaction[];
  benchmarkValues?: Record<BenchmarkFilterKey, string>;
  yearsList?: string[];
  averageTicketValue?: number;
};

type RatioMetricMap = Record<string, number | null>;
type RatioStat = { weightedAverage: number | null; average: number | null; median: number | null; observations: number };
type BenchmarkPeriodType = 'mensual' | 'acumulado';
type PeriodComparabilityFilter = BenchmarkPeriodType | 'all';
type BenchmarkPeriodStandardization = {
  periodo_original: string;
  mes: number | null;
  anio: number | null;
  tipo_periodo: BenchmarkPeriodType;
  periodo_estandarizado: string;
};

type BenchmarkFilterKey =
  | 'legalEntity'
  | 'operatingAge'
  | 'mainProduct'
  | 'targetSegment'
  | 'fundingModel'
  | 'geography'
  | 'originationChannel'
  | 'maturityStage'
  | 'ticketRange'
  | 'statementType'
  | 'financialYears'
  | 'creditGranted';

type FilterState = Record<BenchmarkFilterKey, string>;

const ratioKeys = [
  'debt_ebitda',
  'dscr',
  'current_ratio',
  'leverage',
  'debt_equity',
  'capitalization',
  'adjusted_capitalization',
  'roa',
  'roe',
  'past_due_portfolio',
  'net_past_due_portfolio',
  'past_due_coverage',
  'debt_coverage_productive_assets',
  'immediate_liquidity',
];
const ratioLabels: Record<string, string> = {
  debt_ebitda: 'Deuda/EBITDA',
  dscr: 'DSCR',
  current_ratio: 'Razón corriente',
  leverage: 'Apalancamiento',
  debt_equity: 'Deuda/Capital',
  capitalization: 'ICAP',
  adjusted_capitalization: 'ICAP ajustado',
  roa: 'ROA',
  roe: 'ROE',
  past_due_portfolio: 'Cartera vencida',
  net_past_due_portfolio: 'Cartera vencida neta',
  past_due_coverage: 'Cobertura cartera vencida',
  debt_coverage_productive_assets: 'Cobertura de deuda',
  immediate_liquidity: 'Liquidez inmediata',
};

const trendRatioKeys = ratioKeys;
const ratioFormulaDescriptions: Record<string, string> = {
  debt_ebitda: 'Deuda total / EBITDA',
  dscr: 'EBITDA / gasto financiero',
  current_ratio: 'Activo corriente / pasivo corriente',
  leverage: '(Bancos y fondos CP + LP) / total activo',
  debt_equity: 'Deuda total / capital contable',
  capitalization: 'Capital contable / activos totales',
  adjusted_capitalization: 'Capital contable / cartera neta',
  roa: 'Utilidad neta / activos totales',
  roe: 'Utilidad neta / capital contable',
  past_due_portfolio: 'Cartera vencida / cartera administrada',
  net_past_due_portfolio: '(Cartera vencida - estimación preventiva) / cartera administrada',
  past_due_coverage: 'Estimación preventiva / cartera vencida',
  debt_coverage_productive_assets: 'Activos productivos / total pasivo',
  immediate_liquidity: '(Bancos + inversiones disponibles) / pasivo corriente',
};
const percentRatioKeys = new Set(['capitalization', 'adjusted_capitalization', 'roa', 'roe', 'past_due_portfolio', 'net_past_due_portfolio']);

const BENCHMARK_FILTERS: Array<{ key: BenchmarkFilterKey; label: string; allLabel: string }> = [
  { key: 'legalEntity', label: 'Entidad jurídica', allLabel: 'Toda entidad' },
  { key: 'operatingAge', label: 'Antigüedad operativa', allLabel: 'Toda antigüedad' },
  { key: 'mainProduct', label: 'Producto principal', allLabel: 'Todo producto' },
  { key: 'targetSegment', label: 'Segmento objetivo', allLabel: 'Todo segmento' },
  { key: 'fundingModel', label: 'Modelo de fondeo', allLabel: 'Todo fondeo' },
  { key: 'geography', label: 'Cobertura geográfica', allLabel: 'Toda cobertura' },
  { key: 'originationChannel', label: 'Canal de originación', allLabel: 'Todo canal' },
  { key: 'maturityStage', label: 'Etapa de madurez', allLabel: 'Toda etapa' },
  { key: 'ticketRange', label: 'Ticket promedio', allLabel: 'Todo ticket' },
  { key: 'statementType', label: 'Tipo de EF', allLabel: 'Todo tipo EF' },
  { key: 'financialYears', label: 'Años de info financiera', allLabel: 'Todos los años' },
  { key: 'creditGranted', label: 'Crédito otorgado / contrato', allLabel: 'Todos los créditos' },
];

const EMPTY_FILTERS = BENCHMARK_FILTERS.reduce((acc, filter) => ({ ...acc, [filter.key]: 'all' }), {} as FilterState);
const DEFAULT_REPORT_DIMS: BenchmarkFilterKey[] = ['legalEntity', 'mainProduct', 'ticketRange'];
const PRIMARY_FILTER_KEYS: BenchmarkFilterKey[] = ['legalEntity', 'mainProduct', 'ticketRange', 'statementType'];
const CHART_COLORS = ['#4f46e5', '#06b6d4', '#10b981', '#f59e0b', '#f43f5e', '#64748b'];
const KEY_RATIO_CHART_KEYS = ['debt_ebitda', 'dscr', 'current_ratio', 'capitalization', 'past_due_portfolio'];
const PERIOD_COMPARABILITY_OPTIONS: Array<{ value: PeriodComparabilityFilter; label: string }> = [
  { value: 'all', label: 'Mensual + acumulado' },
  { value: 'mensual', label: 'Solo mensual' },
  { value: 'acumulado', label: 'Solo acumulado' },
];

function friendlyLoadError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || '');
  if (/failed|fetch|network|load/i.test(message)) {
    return 'No se pudo conectar con el servidor de benchmarking. Revisa la sesión y vuelve a intentar.';
  }
  return message || 'No se pudo cargar el benchmarking.';
}

const normalizeText = (value: string) => value
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase();

const MONTH_ALIASES: Record<string, number> = {
  ene: 1,
  enero: 1,
  jan: 1,
  january: 1,
  janeiro: 1,
  feb: 2,
  febrero: 2,
  february: 2,
  fevereiro: 2,
  mar: 3,
  marzo: 3,
  march: 3,
  marco: 3,
  abr: 4,
  abril: 4,
  apr: 4,
  april: 4,
  maio: 5,
  may: 5,
  mayo: 5,
  jun: 6,
  junio: 6,
  june: 6,
  junho: 6,
  jul: 7,
  julio: 7,
  july: 7,
  julho: 7,
  ago: 8,
  agosto: 8,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  septiembre: 9,
  setembro: 9,
  september: 9,
  oct: 10,
  octubre: 10,
  october: 10,
  outubro: 10,
  nov: 11,
  noviembre: 11,
  november: 11,
  novembro: 11,
  dic: 12,
  diciembre: 12,
  dec: 12,
  december: 12,
  dezembro: 12,
};

const ACCUMULATED_PERIOD_PATTERNS = [
  /\bytd\b/,
  /\bfy\b/,
  /\bq[1-4]\b/,
  /\b[1-4]q\b/,
  /\bt[1-4]\b/,
  /\b[1-4]t\b/,
  /\bh[12]\b/,
  /\b[12]h\b/,
  /acumul/,
  /cumul/,
  /trimestr/,
  /quarter/,
  /semestr/,
  /anual/,
  /annual/,
  /year.to.date/,
  /a la fecha/,
  /ejercicio/,
];

function monthKeyFromParts(year: number | null, month: number | null) {
  if (!year || !month || month < 1 || month > 12) return '';
  return `${year}-${String(month).padStart(2, '0')}`;
}

function monthName(month: number | null) {
  if (!month) return '';
  return new Date(2000, month - 1, 1).toLocaleDateString('es-MX', { month: 'short' });
}

function detectPeriodType(raw: string): BenchmarkPeriodType {
  const normalized = normalizeText(raw);
  return periodFromQuarterOrHalf(raw) || ACCUMULATED_PERIOD_PATTERNS.some(pattern => pattern.test(normalized)) ? 'acumulado' : 'mensual';
}

function monthFromText(raw: string) {
  const normalized = normalizeText(raw).replace(/[._-]/g, ' ');
  const tokens = normalized.match(/[a-z]+/g) || [];
  const token = tokens.find(item => MONTH_ALIASES[item] !== undefined);
  return token ? MONTH_ALIASES[token] : null;
}

function periodFromQuarterOrHalf(raw: string) {
  const normalized = normalizeText(raw);
  const quarter = normalized.match(/\b(?:q|t)\s*([1-4])(?=\D|$|\d{4})|\b([1-4])\s*(?:q|t)(?=\D|$|\d{4})/);
  if (quarter) return Number(quarter[1] || quarter[2]) * 3;
  const half = normalized.match(/\bh\s*([12])(?=\D|$|\d{4})|\b([12])\s*h(?=\D|$|\d{4})|(?:semestre|sem)\s*([12])\b/);
  if (half) return Number(half[1] || half[2] || half[3]) * 6;
  return null;
}

function periodFromNumericText(raw: string) {
  const normalized = raw.trim();
  const compact = normalized.match(/\b((?:19|20)\d{2})(0[1-9]|1[0-2])\b/);
  if (compact) return { year: Number(compact[1]), month: Number(compact[2]) };

  const yearFirst = normalized.match(/\b((?:19|20)\d{2})[-/. ](0?[1-9]|1[0-2])\b/);
  if (yearFirst) return { year: Number(yearFirst[1]), month: Number(yearFirst[2]) };

  const monthFirst = normalized.match(/\b(0?[1-9]|1[0-2])[-/. ]((?:19|20)\d{2})\b/);
  if (monthFirst) return { year: Number(monthFirst[2]), month: Number(monthFirst[1]) };

  const dayMonthYear = normalized.match(/\b(?:0?[1-9]|[12]\d|3[01])[-/. ](0?[1-9]|1[0-2])[-/. ]((?:19|20)\d{2})\b/);
  if (dayMonthYear) return { year: Number(dayMonthYear[2]), month: Number(dayMonthYear[1]) };

  return null;
}

function standardizeBenchmarkPeriod(stmt: FinancialStatement_DB): BenchmarkPeriodStandardization {
  const periodo_original = stmt.period || stmt.periodDate || '';
  const source = [stmt.period, stmt.periodDate, stmt.documentType].filter(Boolean).join(' ');
  const numeric = periodFromNumericText(source);
  const year = Number(yearFromText(source)) || numeric?.year || null;
  const month = monthFromText(source) || periodFromQuarterOrHalf(source) || numeric?.month || (detectPeriodType(source) === 'acumulado' ? 12 : null);
  const periodo_estandarizado = monthKeyFromParts(year, month);

  return {
    periodo_original,
    mes: month,
    anio: year,
    tipo_periodo: detectPeriodType(source),
    periodo_estandarizado,
  };
}

function periodStandardization(stmt: FinancialStatement_DB | undefined): BenchmarkPeriodStandardization | null {
  return stmt ? standardizeBenchmarkPeriod(stmt) : null;
}

function fieldValue(fields: CustomField[], patterns: RegExp[]) {
  const found = fields.find(f => patterns.some(re => re.test(normalizeText(f.label))));
  return found?.value?.trim() || '';
}

function firstValue(values: string[], fallback = 'Sin dato') {
  return values.map(v => v.trim()).find(Boolean) || fallback;
}

function yearFromText(value: string) {
  return value.match(/\b(20\d{2}|19\d{2})\b/)?.[1] || '';
}

function years(row: BenchRow) {
  if (row.yearsList) return row.yearsList;
  return Array.from(new Set(row.statements.map(s => {
    const standardized = periodStandardization(s);
    return standardized?.anio ? String(standardized.anio) : yearFromText(`${s.periodDate} ${s.period}`);
  }).filter(Boolean))).sort();
}

function geography(row: BenchRow) {
  return fieldValue(row.fields, [/ubic/i, /local/i, /geograf/i, /estado/i, /ciudad/i, /pais/i]) || 'Sin dato';
}

function operationStart(row: BenchRow) {
  return fieldValue(row.fields, [/inicio.*oper/i, /fecha.*inicio/i, /start/i, /fundaci/i, /constituc/i]) || 'Sin dato';
}

function legalEntity(row: BenchRow) {
  const custom = fieldValue(row.fields, [/entidad.*jurid/i, /tipo.*entidad/i, /figura.*legal/i, /tipo.*sociedad/i]);
  const source = firstValue([custom, row.client.industry], '');
  const normalized = normalizeText(source);
  if (normalized.includes('sofom')) return 'SOFOM';
  if (normalized.includes('sofipo')) return 'SOFIPO';
  if (normalized.includes('sapi') || normalized.includes('s.a.p.i')) return 'SAPI';
  return source || 'Sin dato';
}

function operatingAge(row: BenchRow) {
  const custom = fieldValue(row.fields, [/antig/i, /anos.*oper/i, /edad.*oper/i]);
  if (custom) return custom;
  const start = operationStart(row);
  const year = Number(yearFromText(start));
  if (!year) return 'Sin dato';
  const age = new Date().getFullYear() - year;
  if (age >= 10) return '10+';
  if (age >= 5) return '5-10';
  if (age >= 3) return '3-5';
  if (age >= 1) return '1-3';
  return 'Menos de 1';
}

function mainProduct(row: BenchRow) {
  const custom = fieldValue(row.fields, [/producto.*principal/i, /producto/i, /tipo.*credito/i]);
  return firstValue([custom, row.client.creditType?.join(', ') || '']);
}

function targetSegment(row: BenchRow) {
  return fieldValue(row.fields, [/segmento.*objetivo/i, /mercado.*objetivo/i, /cliente.*objetivo/i, /target/i]) || 'Sin dato';
}

function fundingModel(row: BenchRow) {
  return fieldValue(row.fields, [/modelo.*fondeo/i, /fondeo/i, /funding/i, /linea.*credito/i]) || 'Sin dato';
}

function originationChannel(row: BenchRow) {
  return fieldValue(row.fields, [/canal.*origin/i, /originaci/i, /referid/i, /broker/i, /alianza/i, /digital/i]) || 'Sin dato';
}

function maturityStage(row: BenchRow) {
  const custom = fieldValue(row.fields, [/etapa.*madur/i, /madurez/i, /stage/i]);
  if (custom) return custom;
  const age = operatingAge(row);
  if (age === '1-3' || age === 'Menos de 1') return 'Temprana';
  if (age === '3-5') return 'Crecimiento';
  if (age === '5-10' || age === '10+') return 'Madura';
  return 'Sin dato';
}

function averageTicket(row: BenchRow) {
  if (row.averageTicketValue !== undefined) return row.averageTicketValue;
  const txAmounts = row.transactions.map(t => t.originalAmount).filter(amount => amount > 0);
  if (txAmounts.length) return txAmounts.reduce((sum, amount) => sum + amount, 0) / txAmounts.length;
  return row.client.totalCreditValue || 0;
}

function ticketRange(row: BenchRow) {
  const ticket = averageTicket(row);
  if (!ticket) return 'Sin dato';
  if (ticket < 5_000_000) return '< 5MM';
  if (ticket < 20_000_000) return '5-20MM';
  if (ticket < 50_000_000) return '20-50MM';
  if (ticket < 100_000_000) return '50-100MM';
  return '100MM+';
}

function statementType(row: BenchRow) {
  const custom = fieldValue(row.fields, [/tipo.*estado.*fin/i, /periodicidad.*estado/i, /estado.*fin.*tipo/i]);
  const source = firstValue([custom, ...row.statements.map(s => s.documentType || '')], '');
  const normalized = normalizeText(source);
  if (normalized.includes('acumul')) return 'Mensual acumulado';
  if (normalized.includes('mens')) return 'Mensual';
  if (normalized.includes('anual') || normalized.includes('audit')) return 'Anual';
  if (row.client.frequency === 'mensual') return 'Mensual';
  return row.statements.length ? 'Sin clasificar' : 'Sin estados financieros';
}

function financialYears(row: BenchRow) {
  const values = years(row);
  return values.length ? values.join(', ') : 'Sin dato';
}

function creditGranted(row: BenchRow) {
  const hasContract = Boolean(row.client.contractName?.trim());
  const hasCredit = row.transactions.length > 0 || (row.client.totalCreditValue || 0) > 0 || hasContract;
  if (hasCredit && hasContract) return 'Sí, con contrato';
  if (hasCredit) return 'Sí, sin contrato cargado';
  return 'No / sin dato';
}

function benchmarkValue(row: BenchRow, key: BenchmarkFilterKey) {
  const cachedValue = row.benchmarkValues?.[key];
  if (cachedValue) return cachedValue;
  if (key === 'legalEntity') return legalEntity(row);
  if (key === 'operatingAge') return operatingAge(row);
  if (key === 'mainProduct') return mainProduct(row);
  if (key === 'targetSegment') return targetSegment(row);
  if (key === 'fundingModel') return fundingModel(row);
  if (key === 'geography') return geography(row);
  if (key === 'originationChannel') return originationChannel(row);
  if (key === 'maturityStage') return maturityStage(row);
  if (key === 'ticketRange') return ticketRange(row);
  if (key === 'statementType') return statementType(row);
  if (key === 'financialYears') return financialYears(row);
  if (key === 'creditGranted') return creditGranted(row);
  return 'Sin dato';
}

function titleCaseSegment(value: string) {
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized || normalized === 'Sin dato') return 'Sin dato';
  if (/^[A-Z0-9\s./&+-]+$/.test(normalized) && normalized.length <= 12) return normalized;
  return normalized
    .toLowerCase()
    .replace(/\b\p{L}/gu, char => char.toLocaleUpperCase('es-MX'));
}

function canonicalBenchmarkValue(rawValue: string, key: BenchmarkFilterKey) {
  const compact = rawValue
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*[-–—]\s*/g, '-')
    .trim();
  const normalized = normalizeText(compact);
  if (!compact || ['n/a', 'na', 'null', 'undefined', 'sin dato', 'sin datos', 'no aplica', 's/d', 'sd'].includes(normalized)) {
    return 'Sin dato';
  }

  if (key === 'legalEntity') {
    if (normalized.includes('sofom')) return 'SOFOM';
    if (normalized.includes('sofipo')) return 'SOFIPO';
    if (normalized.includes('sapi') || normalized.includes('s.a.p.i')) return 'SAPI';
    if (normalized.includes('sa de cv') || normalized.includes('s.a. de c.v')) return 'SA de CV';
  }
  if (key === 'statementType') {
    if (normalized.includes('acumul')) return 'Mensual acumulado';
    if (normalized.includes('mens')) return 'Mensual';
    if (normalized.includes('anual') || normalized.includes('audit')) return 'Anual';
  }
  if (key === 'maturityStage') {
    if (/tempran|early|startup|inicial/.test(normalized)) return 'Temprana';
    if (/crecim|growth|scale/.test(normalized)) return 'Crecimiento';
    if (/madur|mature|estable/.test(normalized)) return 'Madura';
  }

  return titleCaseSegment(compact);
}

function splitBenchmarkValue(rawValue: string, key: BenchmarkFilterKey) {
  const value = canonicalBenchmarkValue(rawValue, key);
  if (value === 'Sin dato') return ['Sin dato'];
  if (['operatingAge', 'ticketRange', 'statementType', 'financialYears', 'creditGranted'].includes(key)) return [value];
  const parts = value
    .split(/\s*(?:,|;|\||\/|\+|\by\b|\be\b)\s*/i)
    .map(part => canonicalBenchmarkValue(part, key))
    .filter(part => part && part !== 'Sin dato');
  return Array.from(new Set(parts.length ? parts : [value])).sort((a, b) => a.localeCompare(b, 'es-MX'));
}

function benchmarkValues(row: BenchRow, key: BenchmarkFilterKey) {
  if (key === 'financialYears') return years(row);
  return splitBenchmarkValue(benchmarkValue(row, key), key);
}

function segmentValueLabel(row: BenchRow, key: BenchmarkFilterKey) {
  const values = benchmarkValues(row, key);
  return values.length ? values.join(' / ') : 'Sin dato';
}

function filterOptions(rows: BenchRow[], key: BenchmarkFilterKey) {
  return Array.from(new Set(rows.flatMap(row => benchmarkValues(row, key)).filter(Boolean)))
    .sort((a, b) => a.localeCompare(b, 'es-MX'));
}

function matchesFilter(row: BenchRow, key: BenchmarkFilterKey, value: string) {
  if (value === 'all') return true;
  return benchmarkValues(row, key).includes(value);
}

function latestStatement(row: BenchRow, period: string) {
  if (period === 'latest') return row.statements.at(-1);
  return [...row.statements].reverse().find(s => {
    const standardized = periodStandardization(s);
    return standardized?.periodo_estandarizado === period || s.period === period || s.periodDate === period;
  });
}

function periodKey(stmt: FinancialStatement_DB) {
  const standardized = periodStandardization(stmt);
  return standardized?.periodo_estandarizado || stmt.periodDate || normalizeText(stmt.period || '');
}

function periodSortValue(key: string) {
  const timestamp = Date.parse(key.length === 7 ? `${key}-01` : key);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function periodDisplayLabel(stmt: FinancialStatement_DB) {
  const standardized = periodStandardization(stmt);
  if (standardized?.periodo_estandarizado) {
    return `${monthName(standardized.mes)} ${standardized.anio}`;
  }
  if (stmt.periodDate && !Number.isNaN(Date.parse(stmt.periodDate))) {
    const date = new Date(`${stmt.periodDate}T00:00:00`);
    return date.toLocaleDateString('es-MX', { month: 'short', year: 'numeric' });
  }
  return stmt.period || stmt.periodDate || 'Sin periodo';
}

function selectedPeriodLabel(period: string, periodOptions: Array<{ value: string; label: string }>) {
  if (period === 'latest') return 'Último disponible';
  return periodOptions.find(option => option.value === period)?.label || period;
}

function periodTypeMatches(filter: PeriodComparabilityFilter, stmt: FinancialStatement_DB | undefined) {
  if (filter === 'all') return true;
  return periodStandardization(stmt)?.tipo_periodo === filter;
}

function statementYear(stmt: FinancialStatement_DB | undefined) {
  const standardized = periodStandardization(stmt);
  return standardized?.anio ? String(standardized.anio) : yearFromText(`${stmt?.periodDate || ''} ${stmt?.period || ''}`);
}

function statementMatchesYear(stmt: FinancialStatement_DB, financialYear: string) {
  return financialYear === 'all' || statementYear(stmt) === financialYear;
}

function statementMatchesBenchmarkPeriod(stmt: FinancialStatement_DB, selectedPeriod: string) {
  if (selectedPeriod === 'latest') return true;
  const standardized = periodStandardization(stmt);
  return standardized?.periodo_estandarizado === selectedPeriod || stmt.period === selectedPeriod || stmt.periodDate === selectedPeriod;
}

function benchmarkCandidateStatements(
  row: BenchRow,
  selectedPeriod: string,
  periodTypeFilter: PeriodComparabilityFilter,
  financialYear: string,
) {
  return row.statements.filter(stmt => (
    statementMatchesBenchmarkPeriod(stmt, selectedPeriod) &&
    periodTypeMatches(periodTypeFilter, stmt) &&
    statementMatchesYear(stmt, financialYear)
  ));
}

function selectedBenchmarkStatement(
  row: BenchRow,
  selectedPeriod: string,
  periodTypeFilter: PeriodComparabilityFilter,
  financialYear: string,
) {
  return benchmarkCandidateStatements(row, selectedPeriod, periodTypeFilter, financialYear).at(-1);
}

function benchmarkStatementsForExport(
  row: BenchRow,
  selectedPeriod: string,
  periodTypeFilter: PeriodComparabilityFilter,
  financialYear: string,
) {
  const statements = benchmarkCandidateStatements(row, selectedPeriod, periodTypeFilter, financialYear);
  return selectedPeriod === 'latest' ? statements.slice(-1) : statements;
}

function emptyMetricMap(): RatioMetricMap {
  return Object.fromEntries(ratioKeys.map(key => [key, null])) as RatioMetricMap;
}

function metricMap(stmt: FinancialStatement_DB | undefined): RatioMetricMap {
  if (!stmt) return emptyMetricMap();
  const ratios = new Map(standardRatios(stmt).map(ratio => [ratio.key, ratio.value]));
  return Object.fromEntries(ratioKeys.map(key => [key, ratios.get(key) ?? null])) as RatioMetricMap;
}

function weightedAverageFromMetrics(rows: BenchRow[], key: string, getMetrics: (row: BenchRow) => RatioMetricMap) {
  let num = 0;
  let den = 0;
  rows.forEach(row => {
    const value = getMetrics(row)[key];
    const weight = row.client.totalCreditValue || 1;
    if (value !== null && Number.isFinite(value)) {
      num += value * weight;
      den += weight;
    }
  });
  return den ? num / den : null;
}

function ratioValuesFromMetrics(rows: BenchRow[], key: string, getMetrics: (row: BenchRow) => RatioMetricMap) {
  return rows.map(row => getMetrics(row)[key]);
}

function ratioStats(rows: BenchRow[], getMetrics: (row: BenchRow) => RatioMetricMap) {
  return Object.fromEntries(ratioKeys.map(key => {
    const values = ratioValuesFromMetrics(rows, key, getMetrics);
    return [key, {
      weightedAverage: weightedAverageFromMetrics(rows, key, getMetrics),
      average: average(values),
      median: percentile(values, 0.5),
      observations: values.filter(value => value !== null).length,
    }];
  })) as Record<string, RatioStat>;
}

function cleanNumber(value: number | null | undefined) {
  return value !== null && value !== undefined && Number.isFinite(value) ? value : null;
}

function average(values: Array<number | null | undefined>) {
  const nums = values.map(cleanNumber).filter((value): value is number => value !== null);
  return nums.length ? nums.reduce((sum, value) => sum + value, 0) / nums.length : null;
}

function percentile(values: Array<number | null | undefined>, p: number) {
  const nums = values.map(cleanNumber).filter((value): value is number => value !== null).sort((a, b) => a - b);
  if (!nums.length) return null;
  const pos = (nums.length - 1) * p;
  const base = Math.floor(pos);
  const rest = pos - base;
  return nums[base + 1] !== undefined ? nums[base] + rest * (nums[base + 1] - nums[base]) : nums[base];
}

function formatMetric(value: number | null, key: string) {
  if (value === null) return 'N/A';
  const opts = percentRatioKeys.has(key)
    ? { style: 'percent' as const, maximumFractionDigits: 1 }
    : { maximumFractionDigits: 2 };
  return value.toLocaleString('es-MX', opts);
}

function formatMoneyCompact(value: number) {
  return value.toLocaleString('es-MX', {
    notation: 'compact',
    maximumFractionDigits: 1,
  });
}

function formatBenchmarkMetric(value: number | null, key: string) {
  if (value === null) return 'N/A';
  return formatMetric(value, key);
}

function formatPercent(value: number) {
  return value.toLocaleString('es-MX', {
    style: 'percent',
    maximumFractionDigits: 1,
  });
}

function trendFor(
  row: BenchRow,
  key: string,
  statement: FinancialStatement_DB | undefined,
  getStatementMetrics: (stmt: FinancialStatement_DB | undefined) => RatioMetricMap,
) {
  const latest = statement || row.statements.at(-1);
  const latestStandardized = periodStandardization(latest);
  const previous = latest
    ? row.statements
      .filter(stmt => (
        periodSortValue(periodKey(stmt)) < periodSortValue(periodKey(latest)) &&
        (!latestStandardized || periodStandardization(stmt)?.tipo_periodo === latestStandardized.tipo_periodo)
      ))
      .at(-1)
    : row.statements.at(-2);
  const latestValue = getStatementMetrics(latest)[key];
  const previousValue = getStatementMetrics(previous)[key];
  if (latestValue === null || previousValue === null) return null;
  return latestValue - previousValue;
}

function segmentKey(row: BenchRow, dims: string[]) {
  if (dims.length === 0) return 'Global';
  return dims.map(dim => segmentValueLabel(row, dim as BenchmarkFilterKey)).join(' + ');
}

function segmentParticipationReason(row: BenchRow, dims: string[]) {
  if (dims.length === 0) return 'Vista global';
  return dims.map(dim => {
    const filter = BENCHMARK_FILTERS.find(item => item.key === dim);
    return `${filter?.label || dim}: ${segmentValueLabel(row, dim as BenchmarkFilterKey)}`;
  }).join(' · ');
}

function hydrateBenchmarkRow(row: BenchRow): BenchRow {
  const yearsList = years(row);
  const averageTicketValue = averageTicket(row);
  const rowWithScalars = { ...row, yearsList, averageTicketValue };
  const benchmarkValues = Object.fromEntries(
    BENCHMARK_FILTERS.map(filter => [filter.key, benchmarkValue(rowWithScalars, filter.key)]),
  ) as Record<BenchmarkFilterKey, string>;
  return { ...rowWithScalars, benchmarkValues };
}

function participantNames(rows: BenchRow[], limit = 4) {
  const names = rows.map(row => row.client.name).filter(Boolean);
  const visible = names.slice(0, limit).join(', ');
  const remaining = names.length - limit;
  return remaining > 0 ? `${visible} +${remaining}` : visible;
}

function apiClient(row: any): Client {
  return {
    id: row.id,
    orgId: row.org_id || '',
    name: row.name || '',
    taxId: row.tax_id || '',
    industry: row.industry || '',
    score: row.score || '',
    currency: row.currency || 'MXN',
    totalCreditValue: normalizeFinancialWriteValue(row.total_credit_value),
    creditType: row.credit_type || [],
    contractName: row.contract_name || '',
    analystName: row.analyst_name || '',
    createdBy: row.created_by || '',
    createdAt: row.created_at || '',
    paymentHistory: row.payment_history || [],
    currentDue: normalizeFinancialWriteValue(row.current_due),
    maxDefaultDays: normalizeFinancialWriteValue(row.max_default_days),
    maxDefaultAmount: normalizeFinancialWriteValue(row.max_default_amount),
    defaultFrequency12m: normalizeFinancialWriteValue(row.default_frequency_12m),
    opinion: row.opinion || '',
    aforoRequerido: row.aforo_requerido || '',
    aforoHistory: row.aforo_history || [],
    documentation: row.documentation || [],
    reportDate: row.report_date || '',
    frequency: row.frequency || 'mensual',
    lastPeriod: row.last_period || '',
    logoLeft: row.logo_left,
    logoRight: row.logo_right,
  };
}

function apiCustomField(row: any): CustomField {
  return {
    id: row.id,
    clientId: row.client_id,
    label: row.label || '',
    value: row.value || '',
    fieldType: row.field_type || 'text',
  };
}

function jsonArray(value: any) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function jsonObject(value: any) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function apiStatement(row: any): FinancialStatement_DB {
  return {
    id: row.id,
    clientId: row.client_id,
    sourceDocumentId: row.source_document_id || undefined,
    sourceCompanyName: row.source_company_name,
    documentType: row.document_type,
    period: row.period || '',
    periodDate: row.period_date || '',
    uploadDate: row.upload_date || '',
    fileName: row.file_name || '',
    rawLineItems: jsonArray(row.raw_line_items),
    mappedData: jsonObject(row.mapped_data) as FinancialStatement_DB['mappedData'],
    extraAccounts: jsonArray(row.extra_accounts),
  };
}

function apiTransaction(row: any): Transaction {
  return {
    id: row.id,
    clientId: row.client_id,
    name: row.name || '',
    description: row.description || '',
    date: row.date || '',
    creditType: row.credit_type || '',
    originalAmount: normalizeFinancialWriteValue(row.original_amount),
    currency: row.currency || 'MXN',
    signedAt: row.signed_at || '',
    maturityAt: row.maturity_at || '',
    createdBy: row.created_by || '',
    createdAt: row.created_at || '',
  };
}

function groupByClient<T extends { clientId: string }>(items: T[]) {
  return items.reduce((acc, item) => {
    (acc[item.clientId] ||= []).push(item);
    return acc;
  }, {} as Record<string, T[]>);
}

async function loadBenchmarkRowsFromApi(): Promise<BenchRow[]> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error('No autenticado. Por favor inicia sesión nuevamente.');

  const response = await fetch('/api/benchmarking', {
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error || 'No se pudo cargar benchmarking desde el servidor.');

  const clients = (json.clients || []).map(apiClient);
  const fieldsByClient = groupByClient<CustomField>((json.customFields || []).map(apiCustomField));
  const statementsByClient = groupByClient<FinancialStatement_DB>((json.financialStatements || []).map(apiStatement));
  const transactionsByClient = groupByClient<Transaction>((json.transactions || []).map(apiTransaction));
  return clients.map(client => hydrateBenchmarkRow({
    client,
    fields: fieldsByClient[client.id] || [],
    statements: [...(statementsByClient[client.id] || [])].sort((a, b) => periodSortValue(periodKey(a)) - periodSortValue(periodKey(b))),
    transactions: transactionsByClient[client.id] || [],
  }));
}

async function loadBenchmarkRowsFromClient(): Promise<BenchRow[]> {
  const clients = await db.getClients();
  const clientIds = clients.map(client => client.id);
  const [fieldsByClient, statementsByClient, transactionsByClient] = await Promise.all([
    db.getCustomFieldsForClients(clientIds),
    db.getStatementsForClients(clientIds),
    db.getTransactionsForClients(clientIds),
  ]);
  return clients.map(client => hydrateBenchmarkRow({
    client,
    fields: fieldsByClient[client.id] || [],
    statements: [...(statementsByClient[client.id] || [])].sort((a, b) => periodSortValue(periodKey(a)) - periodSortValue(periodKey(b))),
    transactions: transactionsByClient[client.id] || [],
  }));
}

const BenchmarkingPage: React.FC = () => {
  const reportRef = useRef<HTMLDivElement>(null);
  const [rows, setRows] = useState<BenchRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadWarning, setLoadWarning] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [period, setPeriod] = useState('latest');
  const [periodTypeFilter, setPeriodTypeFilter] = useState<PeriodComparabilityFilter>('all');
  const [dims, setDims] = useState<string[]>(DEFAULT_REPORT_DIMS);
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);

  const loadBenchmarkRows = useCallback(async (active = () => true) => {
    try {
      setLoading(true);
      setLoadError(null);
      setLoadWarning(null);
      const loaded = await loadBenchmarkRowsFromApi().catch(async error => {
        console.warn('Benchmarking API load failed, retrying with browser queries:', error);
        const fallbackRows = await loadBenchmarkRowsFromClient();
        if (active()) {
          setLoadWarning('La API de benchmarking no respondió; se cargó la información disponible desde la sesión del navegador.');
        }
        return fallbackRows;
      });
      if (active()) setRows(loaded);
    } catch (err) {
      console.error('Benchmarking load error:', err);
      if (active()) {
        setRows([]);
        setLoadWarning(null);
        setLoadError(friendlyLoadError(err));
      }
    } finally {
      if (active()) setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    loadBenchmarkRows(() => active);
    return () => { active = false; };
  }, [loadBenchmarkRows]);

  const retryLoad = () => {
    loadBenchmarkRows();
  };

  const periodOptions = useMemo(() => {
    const map = new Map<string, string>();
    rows.forEach(row => row.statements.forEach(stmt => {
      const key = periodKey(stmt);
      if (!key) return;
      if (!map.has(key)) map.set(key, periodDisplayLabel(stmt));
    }));
    return Array.from(map.entries())
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => periodSortValue(a.value) - periodSortValue(b.value) || a.label.localeCompare(b.label));
  }, [rows]);

  const filterOptionsByKey = useMemo(() => Object.fromEntries(
    BENCHMARK_FILTERS.map(filter => [filter.key, filterOptions(rows, filter.key)]),
  ) as Record<BenchmarkFilterKey, string[]>, [rows]);

  const cohortFiltered = useMemo(
    () => rows.filter(row => BENCHMARK_FILTERS.every(filter => matchesFilter(row, filter.key, filters[filter.key]))),
    [rows, filters],
  );

  const selectedFinancialYear = filters.financialYears;

  const filtered = useMemo(
    () => cohortFiltered.filter(row => selectedBenchmarkStatement(row, period, periodTypeFilter, selectedFinancialYear)),
    [cohortFiltered, period, periodTypeFilter, selectedFinancialYear],
  );

  const statementMetrics = useMemo(() => {
    const cache = new Map<string, RatioMetricMap>();
    rows.forEach(row => row.statements.forEach(stmt => cache.set(stmt.id, metricMap(stmt))));
    return cache;
  }, [rows]);

  const getStatementMetrics = useCallback((stmt: FinancialStatement_DB | undefined) => {
    if (!stmt) return emptyMetricMap();
    return statementMetrics.get(stmt.id) || metricMap(stmt);
  }, [statementMetrics]);

  const getPeriodStatement = useCallback((row: BenchRow, overridePeriodType: PeriodComparabilityFilter = periodTypeFilter) => (
    selectedBenchmarkStatement(row, period, overridePeriodType, selectedFinancialYear)
  ), [period, periodTypeFilter, selectedFinancialYear]);

  const getPeriodMetrics = useCallback((row: BenchRow) => (
    getStatementMetrics(getPeriodStatement(row))
  ), [getPeriodStatement, getStatementMetrics]);

  const groups = useMemo(() => {
    const map = new Map<string, BenchRow[]>();
    filtered.forEach(row => {
      const key = segmentKey(row, dims);
      map.set(key, [...(map.get(key) || []), row]);
    });
    return Array.from(map.entries()).map(([name, groupRows]) => ({
      name,
      rows: groupRows,
      exposure: groupRows.reduce((s, r) => s + (r.client.totalCreditValue || 0), 0),
      ratios: Object.fromEntries(ratioKeys.map(key => [key, weightedAverageFromMetrics(groupRows, key, getPeriodMetrics)])),
      ratioStats: ratioStats(groupRows, getPeriodMetrics),
    })).sort((a, b) => b.exposure - a.exposure);
  }, [filtered, dims, getPeriodMetrics]);

  const buildFurtherAnalysisRows = useCallback(() => filtered.flatMap(row => {
    const rowYears = years(row).join(', ');
    const base = [
      row.client.id,
      row.client.name,
      row.client.taxId || '',
      row.client.industry || '',
      row.client.currency || 'MXN',
      row.client.totalCreditValue || 0,
      averageTicket(row),
      segmentKey(row, dims),
      segmentValueLabel(row, 'legalEntity'),
      segmentValueLabel(row, 'operatingAge'),
      segmentValueLabel(row, 'mainProduct'),
      segmentValueLabel(row, 'targetSegment'),
      segmentValueLabel(row, 'fundingModel'),
      segmentValueLabel(row, 'geography'),
      segmentValueLabel(row, 'originationChannel'),
      segmentValueLabel(row, 'maturityStage'),
      segmentValueLabel(row, 'ticketRange'),
      segmentValueLabel(row, 'statementType'),
      rowYears,
      segmentValueLabel(row, 'creditGranted'),
    ];
    const statements = benchmarkStatementsForExport(row, period, periodTypeFilter, selectedFinancialYear);
    const scopedStatements = statements.length ? statements : [undefined];
    return scopedStatements.map(stmt => {
      const metrics = getStatementMetrics(stmt);
      const standardized = periodStandardization(stmt);
      return [
        ...base,
        standardized?.periodo_original || stmt?.period || '',
        standardized?.mes || '',
        standardized?.anio || '',
        standardized?.tipo_periodo || '',
        standardized?.periodo_estandarizado || '',
        stmt?.periodDate || '',
        stmt?.documentType || '',
        stmt?.fileName || '',
        ...ratioKeys.map(key => metrics[key]),
        ...trendRatioKeys.map(key => trendFor(row, key, stmt, getStatementMetrics)),
      ];
    });
  }), [filtered, dims, getStatementMetrics, period, periodTypeFilter, selectedFinancialYear]);

  const ratioAnalysis = useMemo(() => {
    const exposure = filtered.reduce((sum, row) => sum + (row.client.totalCreditValue || 0), 0);
    const latestMetrics = filtered.map(getPeriodMetrics);
    const medians = Object.fromEntries(ratioKeys.map(key => [key, percentile(latestMetrics.map(m => m[key]), 0.5)])) as Record<string, number | null>;
    const topSegments = groups.map(group => ({
      name: group.name,
      clients: group.rows.length,
      exposure: group.exposure,
      exposurePct: exposure ? group.exposure / exposure : 0,
      ratios: group.ratios,
      ratioStats: group.ratioStats,
    })).sort((a, b) => b.clients - a.clients || b.exposure - a.exposure);
    const observations = [
      filtered.length
        ? `El filtro seleccionado deja ${filtered.length} clientes en ${groups.length || 1} segmento${groups.length === 1 ? '' : 's'} para comparación.`
        : 'El filtro seleccionado no tiene clientes comparables.',
      medians.debt_ebitda !== null
        ? medians.debt_ebitda > 4
          ? `La mediana Deuda/EBITDA es alta (${formatMetric(medians.debt_ebitda, 'debt_ebitda')}x), por lo que la cohorte luce más apalancada.`
          : `La mediana Deuda/EBITDA es ${formatMetric(medians.debt_ebitda, 'debt_ebitda')}x, útil como referencia de apalancamiento del filtro.`
        : 'No hay datos suficientes para calcular Deuda/EBITDA en esta cohorte.',
      medians.dscr !== null
        ? medians.dscr < 1.2
          ? `El DSCR mediano (${formatMetric(medians.dscr, 'dscr')}x) sugiere presión de servicio de deuda dentro del filtro.`
          : `El DSCR mediano (${formatMetric(medians.dscr, 'dscr')}x) muestra holgura relativa frente al servicio de deuda.`
        : 'No hay datos suficientes para calcular DSCR en esta cohorte.',
      medians.current_ratio !== null
        ? medians.current_ratio < 1
          ? `La razón corriente mediana (${formatMetric(medians.current_ratio, 'current_ratio')}x) apunta a presión de liquidez.`
          : `La razón corriente mediana (${formatMetric(medians.current_ratio, 'current_ratio')}x) funciona como benchmark de liquidez del filtro.`
        : 'No hay datos suficientes para calcular razón corriente en esta cohorte.',
      topSegments[0]
        ? `El segmento con más participantes es "${topSegments[0].name}" con ${topSegments[0].clients} cliente${topSegments[0].clients === 1 ? '' : 's'} en la cohorte filtrada.`
        : 'No hay concentración por segmento con los filtros actuales.',
    ];
    return {
      title: 'Benchmark Ratio Analysis',
      periodLabel: selectedPeriodLabel(period, periodOptions),
      exposure,
      clients: filtered.length,
      segments: groups.length,
      medians,
      debtMedian: medians.debt_ebitda,
      dscrMedian: medians.dscr,
      liquidityMedian: medians.current_ratio,
      topSegments,
      observations,
    };
  }, [filtered, getPeriodMetrics, groups, period, periodOptions]);

  const segmentChartData = useMemo(() => [...ratioAnalysis.topSegments]
    .sort((a, b) => b.clients - a.clients || b.exposure - a.exposure)
    .slice(0, 6)
    .map((segment, index) => ({
    name: segment.name,
    label: segment.name.length > 34 ? `${segment.name.slice(0, 31)}...` : segment.name,
    exposure: segment.exposure,
    exposureCompact: formatMoneyCompact(segment.exposure),
    clients: segment.clients,
    clientsPct: ratioAnalysis.clients ? segment.clients / ratioAnalysis.clients : 0,
    clientsPctLabel: formatPercent(ratioAnalysis.clients ? segment.clients / ratioAnalysis.clients : 0),
    fill: CHART_COLORS[index % CHART_COLORS.length],
  })), [ratioAnalysis.clients, ratioAnalysis.topSegments]);

  const segmentEmptyMessage = useMemo(() => {
    if (!rows.length) return 'No hay clientes cargados para construir el benchmark.';
    if (!cohortFiltered.length) return 'Los filtros seleccionados no dejan clientes en la cohorte.';
    if (!filtered.length) return 'No hay estados financieros comparables para el periodo seleccionado.';
    return 'La cohorte filtrada no tiene segmentos para graficar.';
  }, [cohortFiltered.length, filtered.length, rows.length]);

  const keyRatioChartData = useMemo(() => KEY_RATIO_CHART_KEYS.map(key => {
    const value = ratioAnalysis.medians[key];
    const isPercent = percentRatioKeys.has(key);
    return {
      key,
      ratio: ratioLabels[key],
      value: value === null ? 0 : isPercent ? value * 100 : value,
      formatted: formatBenchmarkMetric(value, key),
      unit: isPercent ? '%' : 'x',
      hasData: value !== null,
    };
  }).filter(item => item.hasData), [ratioAnalysis.medians]);

  const dataCoverageChartData = useMemo(() => ratioKeys.map(key => ({
    ratio: ratioLabels[key],
    shortRatio: ratioLabels[key].length > 18 ? `${ratioLabels[key].slice(0, 16)}...` : ratioLabels[key],
    coverage: filtered.length ? (ratioAnalysis.topSegments.reduce((sum, segment) => (
      sum + segment.ratioStats[key].observations
    ), 0) / filtered.length) * 100 : 0,
    observations: ratioAnalysis.topSegments.reduce((sum, segment) => (
      sum + segment.ratioStats[key].observations
    ), 0),
  })).sort((a, b) => b.coverage - a.coverage).slice(0, 8), [filtered.length, ratioAnalysis.topSegments]);

  const periodTrendChartData = useMemo(() => periodOptions.map(option => {
    const metrics = filtered.map(row => getStatementMetrics(
      selectedBenchmarkStatement(row, option.value, periodTypeFilter, selectedFinancialYear),
    ));
    return {
      period: option.label,
      periodKey: option.value,
      deuda: percentile(metrics.map(metric => metric.debt_ebitda), 0.5),
      dscr: percentile(metrics.map(metric => metric.dscr), 0.5),
      liquidez: percentile(metrics.map(metric => metric.current_ratio), 0.5),
    };
  }).filter(item => item.deuda !== null || item.dscr !== null || item.liquidez !== null).slice(-12), [filtered, getStatementMetrics, periodOptions, periodTypeFilter, selectedFinancialYear]);

  const riskScatterData = useMemo(() => ratioAnalysis.topSegments.map(segment => ({
    name: segment.name,
    debt: segment.ratioStats.debt_ebitda.median,
    dscr: segment.ratioStats.dscr.median,
    exposure: segment.exposure,
    exposureCompact: formatMoneyCompact(segment.exposure),
    clients: segment.clients,
  })).filter((item): item is {
    name: string;
    debt: number;
    dscr: number;
    exposure: number;
    exposureCompact: string;
    clients: number;
  } => item.debt !== null && item.dscr !== null), [ratioAnalysis.topSegments]);

  const exportExcel = async () => {
    setExporting(true);
    try {
      const furtherAnalysisRows = buildFurtherAnalysisRows();
      const summary: SheetDef = {
        name: 'Dashboard Benchmark',
        rows: [
          ['BENCHMARKING - FURTHER ANALYSIS'],
          [],
          ['Periodo', selectedPeriodLabel(period, periodOptions)],
          ['Comparabilidad temporal', periodTypeLabel],
          ['Año financiero', selectedFinancialYear === 'all' ? 'Todos' : selectedFinancialYear],
          ['Alerta mezcla mensual/acumulado', mixedPeriodTypes ? 'Sí' : 'No'],
          ['Clientes incluidos', filtered.length],
          ['Exposición total', filtered.reduce((s, r) => s + (r.client.totalCreditValue || 0), 0)],
          ['Segmentación activa', dims.length ? dims.map(dim => BENCHMARK_FILTERS.find(f => f.key === dim)?.label || dim).join(' + ') : 'Global'],
          [],
          ['Segmento', 'Participantes', 'Clientes', 'Exposición', '% Exposición', ...ratioKeys.flatMap(k => [`Prom. ${ratioLabels[k]}`, `Mediana ${ratioLabels[k]}`])],
          ...groups.map(g => [
            g.name,
            participantNames(g.rows, 12),
            g.rows.length,
            g.exposure,
            ratioAnalysis.exposure ? g.exposure / ratioAnalysis.exposure : null,
            ...ratioKeys.flatMap(k => [g.ratioStats[k].average, g.ratioStats[k].median]),
          ]),
        ],
        colWidths: [36, 60, 16, 18, 14, ...ratioKeys.flatMap(() => [14, 14])],
      };
      const cohortSheet: SheetDef = {
        name: 'Cohortes',
        rows: [
          ['MATRIZ DE COHORTES'],
          [],
          ['Segmento', 'Métrica', 'Promedio pond.', 'Promedio simple', 'P25', 'Mediana', 'P75', 'Observaciones'],
          ...groups.flatMap(group => ratioKeys.map(key => {
            const values = ratioValuesFromMetrics(group.rows, key, getPeriodMetrics);
            return [
              group.name,
              ratioLabels[key],
              group.ratioStats[key].weightedAverage,
              group.ratioStats[key].average,
              percentile(values, 0.25),
              group.ratioStats[key].median,
              percentile(values, 0.75),
              group.ratioStats[key].observations,
            ];
          })),
        ],
        colWidths: [36, 22, 16, 16, 14, 14, 14, 14],
      };
      const periodTypeSheet: SheetDef = {
        name: 'Mensual vs acumulado',
        rows: [
          ['BENCHMARKS SEPARADOS POR TIPO DE PERIODO'],
          [],
          ['Tipo benchmark', 'Clientes', 'Razón', 'Promedio pond.', 'Promedio simple', 'Mediana', 'Observaciones'],
          ...periodTypeBreakdowns.flatMap(item => ratioKeys.map(key => [
            item.label,
            item.rows.length,
            ratioLabels[key],
            item.stats[key].weightedAverage,
            item.stats[key].average,
            item.stats[key].median,
            item.stats[key].observations,
          ])),
          [],
          ['ALERTAS DE MEZCLA POR SEGMENTO'],
          ['Segmento', 'Tipos detectados'],
          ...mixedSegments.map(item => [item.name, item.types.join(', ')]),
        ],
        colWidths: [26, 12, 24, 16, 16, 14, 14],
      };
      const baseSheet: SheetDef = {
        name: 'Base Further Analysis',
        rows: [
          ['BASE NORMALIZADA PARA FURTHER ANALYSIS'],
          [],
          [
            'Client ID', 'Cliente', 'RFC', 'Industria', 'Moneda', 'Exposición', 'Ticket promedio', 'Segmento',
            'Entidad jurídica', 'Antigüedad operativa', 'Producto principal', 'Segmento objetivo', 'Modelo de fondeo',
            'Geografía', 'Canal originación', 'Etapa madurez', 'Rango ticket', 'Tipo EF', 'Años financieros',
            'Crédito / contrato',
            'periodo_original', 'mes', 'anio', 'tipo_periodo', 'periodo_estandarizado', 'Fecha periodo fuente', 'Tipo documento', 'Archivo fuente',
            ...ratioKeys.map(key => ratioLabels[key]),
            ...trendRatioKeys.map(key => `Δ ${ratioLabels[key]}`),
          ],
          ...furtherAnalysisRows,
        ],
        colWidths: [28, 30, 18, 22, 10, 16, 16, 36, 18, 18, 22, 22, 22, 20, 20, 18, 14, 18, 20, 20, 18, 10, 10, 16, 18, 18, 18, 26, ...ratioKeys.map(() => 14), ...trendRatioKeys.map(() => 14)],
      };
      const participantsSheet: SheetDef = {
        name: 'Participantes por segmento',
        rows: [
          ['PARTICIPANTES POR SEGMENTO'],
          [],
          [
            'Segmento', 'Cliente', 'RFC', 'Industria', 'Exposición', 'Moneda', 'Ticket promedio',
            'Motivo de participación', 'Entidad jurídica', 'Producto principal', 'Segmento objetivo',
            'Modelo de fondeo', 'Geografía', 'Tipo EF',
          ],
          ...groups.flatMap(group => group.rows.map(row => [
            group.name,
            row.client.name,
            row.client.taxId || '',
            row.client.industry || '',
            row.client.totalCreditValue || 0,
            row.client.currency || 'MXN',
            averageTicket(row),
            segmentParticipationReason(row, dims),
            segmentValueLabel(row, 'legalEntity'),
            segmentValueLabel(row, 'mainProduct'),
            segmentValueLabel(row, 'targetSegment'),
            segmentValueLabel(row, 'fundingModel'),
            segmentValueLabel(row, 'geography'),
            segmentValueLabel(row, 'statementType'),
          ])),
        ],
        colWidths: [36, 30, 18, 22, 16, 10, 16, 70, 18, 22, 22, 22, 22, 18],
        wrapColumns: [8],
      };
      const miniStudySheet: SheetDef = {
        name: 'Ratio Analysis',
        rows: [
          ['BENCHMARK RATIO ANALYSIS'],
          [],
          ['Periodo analizado', ratioAnalysis.periodLabel],
          ['Clientes', ratioAnalysis.clients],
          ['Segmentos', ratioAnalysis.segments],
          ['Exposición total', ratioAnalysis.exposure],
          [],
          ['Medianas de la cohorte filtrada'],
          ['Razón', 'Mediana'],
          ...ratioKeys.map(key => [ratioLabels[key], ratioAnalysis.medians[key]]),
          [],
          ['Benchmark por segmento'],
          ['Segmento', 'Razón', 'Promedio', 'Mediana', 'Observaciones'],
          ...ratioAnalysis.topSegments.flatMap(row => ratioKeys.map(key => [
            row.name,
            ratioLabels[key],
            row.ratioStats[key].average,
            row.ratioStats[key].median,
            row.ratioStats[key].observations,
          ])),
          [],
          ['Lectura según filtro'],
          ...ratioAnalysis.observations.map(item => [item]),
        ],
        colWidths: [38, 18, 18, 16, 14],
        wrapColumns: [1],
      };
      const dictionarySheet: SheetDef = {
        name: 'Diccionario',
        rows: [
          ['DICCIONARIO DE VARIABLES'],
          [],
          ['Variable', 'Definición'],
          ['periodo_original', 'Periodo leído tal como viene en el estado financiero del cliente; no se edita ni se persiste.'],
          ['mes', 'Mes interpretado para benchmarking, en número 1-12.'],
          ['anio', 'Año interpretado para benchmarking.'],
          ['tipo_periodo', 'Clasificación para benchmarking: mensual si representa un mes, acumulado si representa varios meses.'],
          ['periodo_estandarizado', 'Clave temporal uniforme AAAA-MM usada solo para comparar clientes en benchmarking.'],
          ...BENCHMARK_FILTERS.map(filter => [filter.label, `Campo usado para segmentar benchmark: ${filter.key}`]),
          ...ratioKeys.map(key => [ratioLabels[key], ratioFormulaDescriptions[key] || key]),
        ],
        colWidths: [28, 80],
        wrapColumns: [2],
      };
      const { exportToExcel } = await import('../../lib/export');
      await exportToExcel([summary, cohortSheet, periodTypeSheet, participantsSheet, baseSheet, miniStudySheet, dictionarySheet], 'Benchmarking_Ratio_Analysis');
    } finally {
      setExporting(false);
    }
  };

  const exportReportPdf = async () => {
    if (!reportRef.current) return;
    setExporting(true);
    try {
      const { exportToPdf } = await import('../../lib/export');
      await exportToPdf([reportRef.current], 'Benchmark_Ratio_Analysis');
    } finally {
      setExporting(false);
    }
  };

  const updateFilter = (key: BenchmarkFilterKey, value: string) => setFilters(prev => ({ ...prev, [key]: value }));
  const clearFilters = () => {
    setFilters(EMPTY_FILTERS);
    setPeriod('latest');
    setPeriodTypeFilter('all');
    setDims([]);
  };
  const clearSegmentations = () => setDims([]);
  const applyDefaultReportView = () => {
    setPeriod('latest');
    setPeriodTypeFilter('all');
    setFilters(EMPTY_FILTERS);
    setDims(DEFAULT_REPORT_DIMS);
  };
  const activeFilters = BENCHMARK_FILTERS.filter(filter => filters[filter.key] !== 'all');
  const activeDims = BENCHMARK_FILTERS.filter(filter => dims.includes(filter.key));
  const availableDims = BENCHMARK_FILTERS.filter(filter => !dims.includes(filter.key));
  const primaryFilters = BENCHMARK_FILTERS.filter(filter => PRIMARY_FILTER_KEYS.includes(filter.key));
  const advancedFilters = BENCHMARK_FILTERS.filter(filter => !PRIMARY_FILTER_KEYS.includes(filter.key));
  const segmentationLabel = activeDims.length ? activeDims.map(dim => dim.label).join(' + ') : 'Sin segmentación (vista global)';
  const segmentationDiagnostics = activeDims.map(filter => {
    const values = filtered.map(row => segmentValueLabel(row, filter.key));
    const missing = values.filter(value => value === 'Sin dato' || value.includes('Sin dato')).length;
    const uniqueValues = Array.from(new Set(values)).filter(Boolean);
    return {
      key: filter.key,
      label: filter.label,
      missing,
      coverage: filtered.length ? (filtered.length - missing) / filtered.length : 0,
      unique: uniqueValues.length,
      topValues: uniqueValues.slice(0, 3),
    };
  });
  const ratiosWithData = ratioKeys.filter(key => ratioAnalysis.medians[key] !== null).length;
  const periodTypeLabel = PERIOD_COMPARABILITY_OPTIONS.find(option => option.value === periodTypeFilter)?.label || 'Mensual + acumulado';
  const periodTransparencyRows = filtered.map(row => {
    const stmt = getPeriodStatement(row);
    const standardized = periodStandardization(stmt);
    return {
      client: row.client.name,
      original: standardized?.periodo_original || stmt?.period || stmt?.periodDate || 'Sin periodo',
      standardized: standardized?.periodo_estandarizado || 'Sin interpretar',
      type: standardized?.tipo_periodo || 'Sin clasificar',
    };
  });
  const periodTransparencyCounts = periodTransparencyRows.reduce((acc, item) => {
    acc[item.type] = (acc[item.type] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  const mixedPeriodTypes = Object.keys(periodTransparencyCounts).filter(type => type === 'mensual' || type === 'acumulado').length > 1;
  const mixedSegments = groups
    .map(group => {
      const types = Array.from(new Set(group.rows.map(row => periodStandardization(getPeriodStatement(row))?.tipo_periodo).filter(Boolean)));
      return { name: group.name, types };
    })
    .filter(item => item.types.length > 1);
  const periodTypeBreakdowns = (['mensual', 'acumulado'] as BenchmarkPeriodType[]).map(type => {
    const typeRows = cohortFiltered.filter(row => selectedBenchmarkStatement(row, period, type, selectedFinancialYear));
    const typeStats = ratioStats(typeRows, row => getStatementMetrics(selectedBenchmarkStatement(row, period, type, selectedFinancialYear)));
    return {
      type,
      label: type === 'mensual' ? 'Benchmark mensual' : 'Benchmark acumulado/YTD',
      rows: typeRows,
      stats: typeStats,
      debtMedian: typeStats.debt_ebitda.median,
      dscrMedian: typeStats.dscr.median,
      liquidityMedian: typeStats.current_ratio.median,
    };
  });

  return (
    <div className="flex-1 bg-slate-50 min-h-screen p-8">
      <WorkingOverlay show={loading || exporting} title={exporting ? 'Exportando benchmarking' : 'Cargando benchmarking'} />
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-black text-slate-900 tracking-tight">Benchmarking</h1>
          <p className="text-slate-500 text-sm mt-1">Promedios ponderados y segmentación del portafolio.</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={exportReportPdf} disabled={loading || exporting || Boolean(loadError)} className="flex items-center gap-2 bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 font-bold px-4 py-2.5 rounded-xl text-sm disabled:opacity-50">
            <FileText className="w-4 h-4" /> Reporte PDF
          </button>
          <button onClick={exportExcel} disabled={loading || exporting || Boolean(loadError)} className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white font-bold px-4 py-2.5 rounded-xl text-sm disabled:opacity-50">
            <FileSpreadsheet className="w-4 h-4" /> Excel Further Analysis
          </button>
        </div>
      </div>

      {loadError && (
        <div className="bg-rose-50 border border-rose-200 rounded-2xl p-5 mb-6">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <div>
              <h2 className="text-sm font-black text-rose-900 uppercase tracking-widest">No se pudo cargar benchmarking</h2>
              <p className="text-sm text-rose-700 mt-2">{loadError}</p>
            </div>
            <button onClick={retryLoad} className="bg-rose-600 hover:bg-rose-500 text-white font-black px-4 py-2.5 rounded-xl text-sm">
              Reintentar
            </button>
          </div>
        </div>
      )}

      {loadWarning && !loadError && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 mb-6">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-600 mt-0.5 flex-shrink-0" />
            <div>
              <h2 className="text-xs font-black text-amber-800 uppercase tracking-widest">Carga parcial</h2>
              <p className="text-sm text-amber-800 mt-1">{loadWarning}</p>
            </div>
          </div>
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-2xl p-5 mb-6">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3 mb-4">
          <div className="flex items-center gap-2">
            <Filter className="w-4 h-4 text-indigo-600" />
            <h2 className="text-sm font-black text-slate-900 uppercase tracking-widest">Filtros del benchmark</h2>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" onClick={clearFilters} className="text-xs font-black text-slate-500 hover:text-slate-900 uppercase tracking-widest">Limpiar todo</button>
            <button onClick={applyDefaultReportView} className="flex items-center gap-1.5 text-xs font-black text-indigo-600 hover:text-indigo-800 uppercase tracking-widest">
              <RotateCcw className="w-3.5 h-3.5" /> Vista base
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-6 gap-3">
          <label className="block">
            <span className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Periodo</span>
            <select value={period} onChange={e => setPeriod(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-sm font-bold">
              <option value="latest">Último disponible</option>
              {periodOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Comparabilidad</span>
            <select value={periodTypeFilter} onChange={e => setPeriodTypeFilter(e.target.value as PeriodComparabilityFilter)} className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-sm font-bold">
              {PERIOD_COMPARABILITY_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          {primaryFilters.map(filter => (
            <label key={filter.key} className="block">
              <span className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">{filter.label}</span>
              <select value={filters[filter.key]} onChange={e => updateFilter(filter.key, e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-sm font-bold">
                <option value="all">{filter.allLabel}</option>
                {filterOptionsByKey[filter.key].map(v => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
          ))}
        </div>

        {activeFilters.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-4">
            {activeFilters.map(filter => (
              <button
                type="button"
                key={filter.key}
                onClick={() => updateFilter(filter.key, 'all')}
                className="bg-indigo-50 text-indigo-700 border border-indigo-100 rounded-lg px-2.5 py-1 text-xs font-black"
              >
                {filter.label}: {filters[filter.key]} x
              </button>
            ))}
          </div>
        )}

        <div className="mt-4">
          <button onClick={() => setShowAdvancedFilters(value => !value)} className="text-xs font-black text-slate-500 hover:text-slate-900 uppercase tracking-widest">
            {showAdvancedFilters ? 'Ocultar filtros avanzados' : 'Mostrar filtros avanzados'}
          </button>
          {showAdvancedFilters && (
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mt-3 pt-4 border-t border-slate-100">
              {advancedFilters.map(filter => (
                <label key={filter.key} className="block">
                  <span className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">{filter.label}</span>
                  <select value={filters[filter.key]} onChange={e => updateFilter(filter.key, e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-sm font-bold">
                    <option value="all">{filter.allLabel}</option>
                    {filterOptionsByKey[filter.key].map(v => <option key={v} value={v}>{v}</option>)}
                  </select>
                </label>
              ))}
            </div>
          )}
        </div>

        <div className="mt-5 pt-4 border-t border-slate-100">
          <div className="flex flex-col lg:flex-row lg:items-end gap-3">
            <label className="block lg:w-80">
              <span className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Agregar segmentación</span>
              <select
                value=""
                onChange={e => {
                  const value = e.target.value as BenchmarkFilterKey;
                  if (value) setDims(prev => prev.includes(value) ? prev : [...prev, value]);
                }}
                className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-sm font-bold"
              >
                <option value="">Seleccionar campo</option>
                {availableDims.map(filter => (
                  <option key={filter.key} value={filter.key}>{filter.label}</option>
                ))}
              </select>
            </label>
            <button type="button" onClick={clearSegmentations} className="bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 font-bold px-4 py-2.5 rounded-xl text-sm">
              Quitar segmentación
            </button>
          </div>

          {activeDims.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-3">
              {activeDims.map(filter => (
                <button
                  type="button"
                  key={filter.key}
                  onClick={() => setDims(prev => prev.filter(dim => dim !== filter.key))}
                  className="bg-slate-900 text-white border border-slate-900 rounded-lg px-2.5 py-1 text-xs font-black"
                >
                  {filter.label} x
                </button>
              ))}
            </div>
          )}
          {segmentationDiagnostics.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-4">
              {segmentationDiagnostics.map(item => (
                <div key={item.key} className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Calidad segmento</p>
                      <p className="mt-1 truncate text-sm font-black text-slate-900">{item.label}</p>
                    </div>
                    <span className={`rounded-lg px-2 py-1 text-[10px] font-black uppercase ${item.coverage >= 0.8 ? 'bg-emerald-50 text-emerald-700' : item.coverage >= 0.5 ? 'bg-amber-50 text-amber-700' : 'bg-rose-50 text-rose-700'}`}>
                      {formatPercent(item.coverage)}
                    </span>
                  </div>
                  <p className="mt-2 text-xs font-bold text-slate-500">
                    {item.unique} valores · {item.missing} sin dato
                  </p>
                  <p className="mt-1 truncate text-[11px] font-semibold text-slate-400">
                    {item.topValues.length ? item.topValues.join(' | ') : 'Sin valores disponibles'}
                  </p>
                </div>
              ))}
            </div>
          )}
          {activeDims.length === 0 && (
            <p className="mt-3 text-sm font-bold text-slate-500">Vista global: no hay segmentos activos.</p>
          )}
        </div>

        <div className="mt-5 pt-4 border-t border-slate-100">
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-2 mb-3">
            <div>
              <p className="text-xs font-black text-slate-400 uppercase tracking-widest">Normalización de periodos</p>
              <p className="text-sm font-bold text-slate-600 mt-1">
                {periodTypeLabel} · {selectedFinancialYear === 'all' ? 'todos los años' : selectedFinancialYear} · {filtered.length} de {cohortFiltered.length} clientes comparables
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {Object.entries(periodTransparencyCounts).map(([type, count]) => (
                <span key={type} className="rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-black text-slate-600 uppercase">
                  {type}: {count}
                </span>
              ))}
            </div>
          </div>
          {mixedPeriodTypes && (
            <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
              <p className="text-xs font-black text-amber-800 uppercase tracking-widest">Alerta de comparabilidad</p>
              <p className="text-sm font-bold text-amber-900 mt-1">
                Esta cohorte mezcla benchmarking mensual y acumulado/YTD. Usa “Solo mensual” o “Solo acumulado”, o revisa los segmentos marcados antes de tomar la mediana como comparable.
              </p>
              {mixedSegments.length > 0 && (
                <p className="text-xs font-bold text-amber-800 mt-2">
                  Segmentos mixtos: {mixedSegments.slice(0, 3).map(item => item.name).join(' | ')}
                  {mixedSegments.length > 3 ? ` +${mixedSegments.length - 3}` : ''}
                </p>
              )}
            </div>
          )}
          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="w-full text-xs">
              <thead className="bg-slate-50">
                <tr>
                  <th className="text-left px-3 py-2 font-black text-slate-500 uppercase">Cliente</th>
                  <th className="text-left px-3 py-2 font-black text-slate-500 uppercase">Periodo original</th>
                  <th className="text-left px-3 py-2 font-black text-slate-500 uppercase">Estandarizado</th>
                  <th className="text-left px-3 py-2 font-black text-slate-500 uppercase">Tipo</th>
                </tr>
              </thead>
              <tbody>
                {periodTransparencyRows.slice(0, 8).map(row => (
                  <tr key={`${row.client}-${row.original}-${row.standardized}`} className="border-t border-slate-100">
                    <td className="px-3 py-2 font-bold text-slate-800">{row.client}</td>
                    <td className="px-3 py-2 font-mono text-slate-600">{row.original}</td>
                    <td className="px-3 py-2 font-mono font-black text-slate-900">{row.standardized}</td>
                    <td className="px-3 py-2">
                      <span className={row.type === 'acumulado' ? 'rounded-lg bg-amber-50 px-2 py-1 font-black text-amber-700 uppercase' : 'rounded-lg bg-emerald-50 px-2 py-1 font-black text-emerald-700 uppercase'}>
                        {row.type}
                      </span>
                    </td>
                  </tr>
                ))}
                {periodTransparencyRows.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-3 py-6 text-center font-bold text-slate-400">
                      Sin periodos comparables con los filtros actuales.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {periodTransparencyRows.length > 8 && (
            <p className="mt-2 text-xs font-bold text-slate-400">Mostrando 8 de {periodTransparencyRows.length}; el detalle completo se mantiene en el Excel.</p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        {periodTypeBreakdowns.map(item => (
          <div key={item.type} className={`bg-white border rounded-2xl p-5 ${item.type === 'mensual' ? 'border-emerald-200' : 'border-amber-200'}`}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className={`text-xs font-black uppercase tracking-widest ${item.type === 'mensual' ? 'text-emerald-700' : 'text-amber-700'}`}>{item.label}</p>
                <h3 className="text-lg font-black text-slate-900 mt-1">{item.rows.length} clientes comparables</h3>
              </div>
              <span className={`rounded-lg px-2.5 py-1 text-xs font-black uppercase ${item.type === 'mensual' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
                {selectedFinancialYear === 'all' ? 'multi-año' : selectedFinancialYear}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-3 mt-4">
              {[
                ['Deuda/EBITDA', formatBenchmarkMetric(item.debtMedian, 'debt_ebitda')],
                ['DSCR', formatBenchmarkMetric(item.dscrMedian, 'dscr')],
                ['Razón corriente', formatBenchmarkMetric(item.liquidityMedian, 'current_ratio')],
              ].map(([label, value]) => (
                <div key={`${item.type}-${label}`} className="rounded-xl bg-slate-50 px-3 py-3">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{label}</p>
                  <p className="text-lg font-black text-slate-900 mt-1">{value}</p>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <div className="bg-white border border-slate-200 rounded-2xl p-4">
          <p className="text-xs font-black text-slate-400 uppercase tracking-widest">Clientes filtrados</p>
          <p className="text-2xl font-black text-slate-900 mt-1">{filtered.length}</p>
        </div>
        <div className="bg-white border border-slate-200 rounded-2xl p-4">
          <p className="text-xs font-black text-slate-400 uppercase tracking-widest">Segmentación</p>
          <p className="text-sm font-black text-slate-900 mt-2 leading-snug">{segmentationLabel}</p>
        </div>
        <div className="bg-white border border-slate-200 rounded-2xl p-4">
          <p className="text-xs font-black text-slate-400 uppercase tracking-widest">Grupos calculados</p>
          <p className="text-2xl font-black text-slate-900 mt-1">{groups.length}</p>
          <p className="text-xs font-bold text-slate-400 mt-1">{dims.length ? 'por segmentación' : 'global'}</p>
        </div>
        <div className="bg-white border border-indigo-200 rounded-2xl p-4">
          <p className="text-xs font-black text-indigo-600 uppercase tracking-widest">Razones con datos</p>
          <p className="text-2xl font-black text-indigo-700 mt-1">{ratiosWithData}/{ratioKeys.length}</p>
          <p className="text-xs font-bold text-slate-400 mt-1">{formatMoneyCompact(ratioAnalysis.exposure)} exposición</p>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-6">
        <div className="bg-white border border-slate-200 rounded-2xl p-5">
          <div className="flex items-start justify-between gap-4 mb-4">
            <div>
              <p className="text-xs font-black text-slate-400 uppercase tracking-widest">Distribución de segmentos</p>
              <h3 className="text-lg font-black text-slate-900 mt-1">Top segmentos del benchmark</h3>
            </div>
            <p className="text-xs font-bold text-slate-500 text-right">
              {ratioAnalysis.clients ? `${ratioAnalysis.clients} clientes filtrados` : 'Sin clientes filtrados'}
            </p>
          </div>
          <div className="h-72">
            {segmentChartData.length ? (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={segmentChartData}
                    dataKey="clients"
                    nameKey="label"
                    innerRadius={62}
                    outerRadius={95}
                    paddingAngle={2}
                  >
                    {segmentChartData.map(item => <Cell key={item.name} fill={item.fill} />)}
                  </Pie>
                  <Tooltip
                    formatter={(_value: any, _name: any, item: any) => [`${item.payload.clients} clientes`, 'Participantes']}
                    labelFormatter={label => String(label)}
                  />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full flex items-center justify-center px-6 text-center text-sm font-bold text-slate-400">{segmentEmptyMessage}</div>
            )}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mt-2">
            {segmentChartData.slice(0, 4).map(item => (
              <div key={item.name} className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: item.fill }} />
                  <span className="text-xs font-black text-slate-700 truncate">{item.label}</span>
                </div>
                <span className="text-xs font-mono font-black text-slate-500 whitespace-nowrap">{item.clientsPctLabel}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl p-5">
          <div className="mb-4">
            <p className="text-xs font-black text-slate-400 uppercase tracking-widest">Medianas clave</p>
            <h3 className="text-lg font-black text-slate-900 mt-1">Ratios ejecutivos de la cohorte</h3>
          </div>
          <div className="h-80">
            {keyRatioChartData.length ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={keyRatioChartData} margin={{ top: 10, right: 12, left: 0, bottom: 28 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                  <XAxis dataKey="ratio" tick={{ fontSize: 11, fill: '#64748b' }} interval={0} angle={-12} textAnchor="end" height={48} />
                  <YAxis tick={{ fontSize: 11, fill: '#64748b' }} />
                  <Tooltip
                    formatter={(_value: any, _name: any, item: any) => [item.payload.formatted, 'Mediana']}
                    labelFormatter={label => String(label)}
                  />
                  <Bar dataKey="value" radius={[8, 8, 0, 0]} fill="#4f46e5" />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full flex items-center justify-center text-sm font-bold text-slate-400">Sin medianas suficientes para graficar.</div>
            )}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl p-5">
          <div className="mb-4">
            <p className="text-xs font-black text-slate-400 uppercase tracking-widest">Evolución histórica</p>
            <h3 className="text-lg font-black text-slate-900 mt-1">Medianas por periodo</h3>
          </div>
          <div className="h-80">
            {periodTrendChartData.length ? (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={periodTrendChartData} margin={{ top: 10, right: 20, left: 0, bottom: 32 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                  <XAxis dataKey="period" tick={{ fontSize: 11, fill: '#64748b' }} interval={0} angle={-18} textAnchor="end" height={48} />
                  <YAxis tick={{ fontSize: 11, fill: '#64748b' }} />
                  <Tooltip
                    formatter={(value: any, name: any) => [
                      typeof value === 'number' ? value.toLocaleString('es-MX', { maximumFractionDigits: 2 }) : value,
                      name,
                    ]}
                  />
                  <Line type="monotone" dataKey="deuda" name="Deuda/EBITDA" stroke="#4f46e5" strokeWidth={3} dot={{ r: 3 }} connectNulls />
                  <Line type="monotone" dataKey="dscr" name="DSCR" stroke="#10b981" strokeWidth={3} dot={{ r: 3 }} connectNulls />
                  <Line type="monotone" dataKey="liquidez" name="Razón corriente" stroke="#06b6d4" strokeWidth={3} dot={{ r: 3 }} connectNulls />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full flex items-center justify-center text-sm font-bold text-slate-400">Sin historia suficiente para graficar.</div>
            )}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl p-5">
          <div className="mb-4">
            <p className="text-xs font-black text-slate-400 uppercase tracking-widest">Mapa de riesgo relativo</p>
            <h3 className="text-lg font-black text-slate-900 mt-1">DSCR vs Deuda/EBITDA por segmento</h3>
          </div>
          <div className="h-80">
            {riskScatterData.length ? (
              <ResponsiveContainer width="100%" height="100%">
                <ScatterChart margin={{ top: 10, right: 18, left: 0, bottom: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="debt" name="Deuda/EBITDA" tick={{ fontSize: 11, fill: '#64748b' }} label={{ value: 'Deuda/EBITDA', position: 'insideBottom', offset: -8, fill: '#64748b', fontSize: 11 }} />
                  <YAxis dataKey="dscr" name="DSCR" tick={{ fontSize: 11, fill: '#64748b' }} label={{ value: 'DSCR', angle: -90, position: 'insideLeft', fill: '#64748b', fontSize: 11 }} />
                  <ReferenceLine x={4} stroke="#f59e0b" strokeDasharray="4 4" />
                  <ReferenceLine y={1.2} stroke="#f59e0b" strokeDasharray="4 4" />
                  <Tooltip
                    cursor={{ strokeDasharray: '3 3' }}
                    formatter={(value: any, name: any) => [
                      typeof value === 'number' ? value.toLocaleString('es-MX', { maximumFractionDigits: 2 }) : value,
                      name,
                    ]}
                    labelFormatter={(_label, payload) => payload?.[0]?.payload?.name || ''}
                  />
                  <Scatter name="Segmentos" data={riskScatterData} fill="#4f46e5" />
                </ScatterChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full flex items-center justify-center text-sm font-bold text-slate-400">Sin DSCR y Deuda/EBITDA suficientes para graficar.</div>
            )}
          </div>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-2xl p-5 mb-6">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-2 mb-4">
          <div>
            <p className="text-xs font-black text-slate-400 uppercase tracking-widest">Calidad de información</p>
            <h3 className="text-lg font-black text-slate-900 mt-1">Cobertura de ratios en la cohorte filtrada</h3>
          </div>
          <p className="text-xs font-bold text-slate-500">Observaciones disponibles / clientes filtrados</p>
        </div>
        <div className="h-72">
          {dataCoverageChartData.length ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={dataCoverageChartData} layout="vertical" margin={{ top: 5, right: 24, left: 34, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#e2e8f0" />
                <XAxis type="number" domain={[0, 100]} tickFormatter={value => `${value}%`} tick={{ fontSize: 11, fill: '#64748b' }} />
                <YAxis type="category" dataKey="shortRatio" tick={{ fontSize: 11, fill: '#64748b' }} width={120} />
                <Tooltip
                  formatter={(value: any, _name: any, item: any) => [
                    `${Number(value).toLocaleString('es-MX', { maximumFractionDigits: 1 })}% (${item.payload.observations} obs.)`,
                    'Cobertura',
                  ]}
                  labelFormatter={label => String(label)}
                />
                <Bar dataKey="coverage" radius={[0, 8, 8, 0]} fill="#06b6d4" />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-full flex items-center justify-center text-sm font-bold text-slate-400">Sin cobertura de datos para graficar.</div>
          )}
        </div>
      </div>

      <div id="benchmark-export-report" ref={reportRef} className="export-page bg-white border border-slate-200 rounded-lg overflow-hidden mb-6 shadow-sm">
        <div className="px-9 py-8 bg-slate-950 text-white">
          <div className="flex items-start justify-between gap-8">
            <div className="max-w-[720px]">
              <div className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-[11px] font-black uppercase tracking-widest text-cyan-100">
                <ClipboardList className="w-3.5 h-3.5 text-cyan-300" />
                Benchmark Ratio Analysis
              </div>
              <h2 className="mt-5 text-4xl font-black tracking-tight">Mini estudio de cohorte</h2>
              <p className="mt-3 text-[15px] leading-relaxed text-slate-200">
                Resumen ejecutivo de la cohorte filtrada: calidad de información, medianas clave, concentración y segmentos que deben revisarse antes de comité.
              </p>
            </div>
            <div className="w-[310px] rounded-xl border border-white/15 bg-white/10 p-4 text-sm text-slate-100">
              <p><span className="font-black text-white">Periodo:</span> {ratioAnalysis.periodLabel}</p>
              <p className="mt-2"><span className="font-black text-white">Comparabilidad:</span> {periodTypeLabel}</p>
              <p className="mt-2"><span className="font-black text-white">Vista:</span> {segmentationLabel}</p>
              <p className="mt-2"><span className="font-black text-white">Año:</span> {selectedFinancialYear === 'all' ? 'Todos' : selectedFinancialYear}</p>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-4 border-b border-slate-200 bg-white">
          {[
            ['Clientes', ratioAnalysis.clients, 'incluidos por filtros'],
            ['Exposición', formatMoneyCompact(ratioAnalysis.exposure), 'total filtrado'],
            ['Segmentos', ratioAnalysis.segments, dims.length ? 'grupos activos' : 'vista global'],
            ['Cobertura', `${ratiosWithData}/${ratioKeys.length}`, 'razones con datos'],
          ].map(([label, value, detail]) => (
            <div key={label} className="border-r border-slate-200 px-6 py-5 last:border-r-0">
              <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">{label}</p>
              <p className="mt-1 text-3xl font-black text-slate-950">{value}</p>
              <p className="mt-1 text-xs font-bold text-slate-500">{detail}</p>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-[1.05fr_0.95fr] gap-0">
          <div className="border-r border-slate-200 p-8">
            <p className="text-[11px] font-black uppercase tracking-widest text-slate-400">Lectura ejecutiva</p>
            <div className="mt-4 space-y-3">
              {ratioAnalysis.observations.slice(0, 5).map((item, index) => (
                <div key={item} className="flex gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                  <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-slate-950 text-[11px] font-black text-white">{index + 1}</div>
                  <p className="text-sm font-semibold leading-relaxed text-slate-700">{item}</p>
                </div>
              ))}
            </div>
            {mixedPeriodTypes && (
              <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
                <p className="text-[10px] font-black uppercase tracking-widest text-amber-700">Alerta de comparabilidad</p>
                <p className="mt-1 text-xs font-bold leading-relaxed text-amber-900">
                  La cohorte mezcla periodos mensuales y acumulados/YTD. Usa el Excel para validar segmentos antes de comparar medianas finas.
                </p>
              </div>
            )}
          </div>

          <div className="p-8">
            <p className="text-[11px] font-black uppercase tracking-widest text-slate-400">Ratios clave</p>
            <div className="mt-4 grid grid-cols-2 gap-3">
              {[
                ['Deuda/EBITDA', ratioAnalysis.debtMedian, 'debt_ebitda'],
                ['DSCR', ratioAnalysis.dscrMedian, 'dscr'],
                ['Razón corriente', ratioAnalysis.liquidityMedian, 'current_ratio'],
                ['ICAP', ratioAnalysis.medians.capitalization, 'capitalization'],
                ['Cartera vencida', ratioAnalysis.medians.past_due_portfolio, 'past_due_portfolio'],
                ['Liquidez inmediata', ratioAnalysis.medians.immediate_liquidity, 'immediate_liquidity'],
              ].map(([label, rawValue, key]) => (
                <div key={String(label)} className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                  <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">{label}</p>
                  <p className="mt-1 text-2xl font-black text-slate-950">{formatBenchmarkMetric(rawValue as number | null, key as string)}</p>
                  <p className="mt-1 text-[11px] font-semibold leading-snug text-slate-500">{ratioFormulaDescriptions[key as string]}</p>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="border-t border-slate-200 bg-slate-50 p-8">
          <div className="flex items-end justify-between gap-4">
            <div>
              <p className="text-[11px] font-black uppercase tracking-widest text-slate-400">Top segmentos</p>
              <h3 className="mt-1 text-xl font-black text-slate-950">Dónde se concentra la exposición</h3>
            </div>
            <p className="text-xs font-bold text-slate-500">Detalle completo disponible en Excel Further Analysis</p>
          </div>
          <div className="mt-5 grid grid-cols-2 gap-4">
            {ratioAnalysis.topSegments.slice(0, 4).map(segment => (
              <div key={segment.name} className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-black text-slate-950">{segment.name}</p>
                    <p className="mt-1 text-xs font-bold text-slate-500">{segment.clients} clientes · {formatPercent(segment.exposurePct)} de exposición</p>
                  </div>
                  <p className="font-mono text-sm font-black text-slate-900">{formatMoneyCompact(segment.exposure)}</p>
                </div>
                <div className="mt-4 grid grid-cols-3 gap-2">
                  {[
                    ['D/E', 'debt_ebitda'],
                    ['DSCR', 'dscr'],
                    ['Liquidez', 'current_ratio'],
                  ].map(([label, key]) => (
                    <div key={`${segment.name}-${key}`} className="rounded-lg bg-slate-50 px-3 py-2">
                      <p className="text-[9px] font-black uppercase tracking-widest text-slate-400">{label}</p>
                      <p className="mt-1 font-mono text-sm font-black text-slate-900">{formatBenchmarkMetric(segment.ratioStats[key].median, key)}</p>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            {ratioAnalysis.topSegments.length === 0 && (
              <div className="col-span-2 rounded-xl border border-slate-200 bg-white px-4 py-8 text-center text-sm font-bold text-slate-400">
                Sin segmentos disponibles para los filtros actuales.
              </div>
            )}
          </div>
        </div>

        <div className="grid grid-cols-[0.95fr_1.05fr] border-t border-slate-200 bg-white">
          <div className="border-r border-slate-200 p-8">
            <p className="text-[11px] font-black uppercase tracking-widest text-slate-400">Calidad de información</p>
            <div className="mt-4 space-y-3">
              {dataCoverageChartData.slice(0, 6).map(item => (
                <div key={item.ratio}>
                  <div className="mb-1 flex items-center justify-between text-xs font-bold text-slate-600">
                    <span>{item.ratio}</span>
                    <span>{item.coverage.toFixed(0)}% · {item.observations} obs.</span>
                  </div>
                  <div className="h-2.5 overflow-hidden rounded-full bg-slate-100">
                    <div className="h-full rounded-full bg-cyan-500" style={{ width: `${Math.min(100, Math.max(0, item.coverage))}%` }} />
                  </div>
                </div>
              ))}
              {dataCoverageChartData.length === 0 && <p className="text-sm font-bold text-slate-400">Sin cobertura de datos para esta cohorte.</p>}
            </div>
          </div>

          <div className="p-8">
            <p className="text-[11px] font-black uppercase tracking-widest text-slate-400">Participantes principales</p>
            <div className="mt-4 grid grid-cols-2 gap-3">
              {groups.slice(0, 4).map(group => (
                <div key={`participants-${group.name}`} className="rounded-xl border border-slate-200 bg-white p-4">
                  <p className="truncate text-sm font-black text-slate-950">{group.name}</p>
                  <p className="mt-1 text-xs font-bold text-slate-500">{group.rows.length} clientes · {formatMoneyCompact(group.exposure)}</p>
                  <div className="mt-3 space-y-2">
                    {group.rows.slice(0, 3).map(row => (
                      <div key={`${group.name}-${row.client.id}`} className="flex items-center justify-between gap-3 border-t border-slate-100 pt-2">
                        <p className="truncate text-xs font-black text-slate-700">{row.client.name}</p>
                        <p className="font-mono text-[11px] font-black text-slate-500">{formatMoneyCompact(row.client.totalCreditValue || 0)}</p>
                      </div>
                    ))}
                    {group.rows.length > 3 && <p className="border-t border-slate-100 pt-2 text-[11px] font-black text-slate-400">+{group.rows.length - 3} más en Excel</p>}
                  </div>
                </div>
              ))}
              {groups.length === 0 && (
                <div className="col-span-2 rounded-xl border border-slate-200 px-4 py-8 text-center text-sm font-bold text-slate-400">
                  Sin participantes para estos filtros.
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="border-t border-slate-200 bg-slate-950 px-8 py-4 text-xs font-bold text-slate-300">
          Benchmark generado por FinMonitor. Las medianas excluyen razones sin dato disponible; el Excel contiene base normalizada, cohortes y diccionario completo.
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100 flex items-center gap-2">
          <Layers className="w-4 h-4 text-indigo-600" />
          <h2 className="text-sm font-black text-slate-900 uppercase tracking-widest">Tabla por vista</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-slate-50">
                <th className="text-left px-4 py-2 font-black text-slate-600 uppercase">Segmento</th>
                <th className="text-left px-4 py-2 font-black text-slate-600 uppercase">Participantes</th>
                <th className="text-right px-4 py-2 font-black text-slate-600 uppercase">Clientes</th>
                <th className="text-right px-4 py-2 font-black text-slate-600 uppercase">Exposición</th>
                {ratioKeys.map(k => <th key={k} className="text-right px-4 py-2 font-black text-slate-600 uppercase whitespace-nowrap">{ratioLabels[k]} Prom / Med</th>)}
              </tr>
            </thead>
            <tbody>
              {groups.map((g, i) => (
                <tr key={g.name} className={i % 2 ? 'bg-slate-50/50' : 'bg-white'}>
                  <td className="px-4 py-2 font-bold text-slate-800">{g.name}</td>
                  <td className="px-4 py-2 text-slate-600 min-w-64">{participantNames(g.rows, 5)}</td>
                  <td className="px-4 py-2 text-right font-mono">{g.rows.length}</td>
                  <td className="px-4 py-2 text-right font-mono">{g.exposure.toLocaleString('es-MX')}</td>
                  {ratioKeys.map(k => (
                    <td key={k} className="px-4 py-2 text-right font-mono whitespace-nowrap">
                      {formatBenchmarkMetric(g.ratioStats[k].average, k)} / {formatBenchmarkMetric(g.ratioStats[k].median, k)}
                    </td>
                  ))}
                </tr>
              ))}
              {groups.length === 0 && (
                <tr><td colSpan={11} className="px-4 py-8 text-center text-slate-400">Sin datos para estos filtros</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default BenchmarkingPage;
