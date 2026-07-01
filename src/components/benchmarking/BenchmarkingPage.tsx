import React, { useEffect, useMemo, useState } from 'react';
import { BarChart3, ClipboardList, FileSpreadsheet, Filter, Layers, TrendingUp } from 'lucide-react';
import { db, Client, ContractFile, Covenant_DB, CustomField, FinancialStatement_DB, Transaction } from '../../db/index';
import { evaluateFormula, standardRatios } from '../../lib/financialMetrics';
import type { SheetDef } from '../../lib/export';
import WorkingOverlay from '../common/WorkingOverlay';

type BenchRow = {
  client: Client;
  fields: CustomField[];
  statements: FinancialStatement_DB[];
  covenants: Covenant_DB[];
  transactions: Transaction[];
  contractFiles: ContractFile[];
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

const ratioKeys = ['revenue', 'ebitda', 'debt_ebitda', 'dscr', 'current_ratio', 'leverage', 'roa', 'roe'];
const ratioLabels: Record<string, string> = {
  revenue: 'Ingresos',
  ebitda: 'EBITDA',
  debt_ebitda: 'Deuda/EBITDA',
  dscr: 'DSCR',
  current_ratio: 'Razón corriente',
  leverage: 'Deuda/Capital',
  roa: 'ROA',
  roe: 'ROE',
};

const syntageRatioKeys = ['debt_ebitda', 'dscr', 'current_ratio', 'leverage', 'roa', 'roe'];
const ratioFormulaDescriptions: Record<string, string> = {
  revenue: 'Cuenta extraída: ingresos/ventas',
  ebitda: 'EBITDA o utilidad de operación',
  debt_ebitda: 'Deuda total / EBITDA',
  dscr: 'EBITDA / gasto financiero',
  current_ratio: 'Activo corriente / pasivo corriente',
  leverage: 'Deuda total / capital contable',
  roa: 'Utilidad neta / activos totales',
  roe: 'Utilidad neta / capital contable',
};

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

const normalizeText = (value: string) => value
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase();

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
  return Array.from(new Set(row.statements.map(s => yearFromText(`${s.periodDate} ${s.period}`)).filter(Boolean))).sort();
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
  const hasContract = row.contractFiles.length > 0 || Boolean(row.client.contractName?.trim());
  const hasCredit = row.transactions.length > 0 || (row.client.totalCreditValue || 0) > 0 || hasContract;
  if (hasCredit && hasContract) return 'Sí, con contrato';
  if (hasCredit) return 'Sí, sin contrato cargado';
  return 'No / sin dato';
}

function benchmarkValue(row: BenchRow, key: BenchmarkFilterKey) {
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

function filterOptions(rows: BenchRow[], key: BenchmarkFilterKey) {
  if (key === 'financialYears') return Array.from(new Set(rows.flatMap(years))).sort();
  return Array.from(new Set(rows.map(row => benchmarkValue(row, key)).filter(Boolean))).sort();
}

function matchesFilter(row: BenchRow, key: BenchmarkFilterKey, value: string) {
  if (value === 'all') return true;
  if (key === 'financialYears') return years(row).includes(value);
  return benchmarkValue(row, key) === value;
}

function latestStatement(row: BenchRow, period: string) {
  const sorted = [...row.statements].sort((a, b) => a.periodDate.localeCompare(b.periodDate));
  if (period === 'latest') return sorted.at(-1);
  return sorted.find(s => s.period === period || s.periodDate === period);
}

function ratioValue(stmt: FinancialStatement_DB | undefined, key: string) {
  if (!stmt) return null;
  return standardRatios(stmt).find(r => r.key === key)?.value ?? null;
}

function metricMap(stmt: FinancialStatement_DB | undefined) {
  return Object.fromEntries(ratioKeys.map(key => [key, ratioValue(stmt, key)])) as Record<string, number | null>;
}

function weightedAverage(rows: BenchRow[], period: string, key: string) {
  let num = 0;
  let den = 0;
  rows.forEach(row => {
    const value = ratioValue(latestStatement(row, period), key);
    const weight = row.client.totalCreditValue || 1;
    if (value !== null && Number.isFinite(value)) {
      num += value * weight;
      den += weight;
    }
  });
  return den ? num / den : null;
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
  const opts = key === 'roa' || key === 'roe'
    ? { style: 'percent' as const, maximumFractionDigits: 1 }
    : { maximumFractionDigits: 2 };
  return value.toLocaleString('es-MX', opts);
}

function thresholdNumber(value: string) {
  const n = Number(String(value || '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function covenantStatus(value: number | null, operator: Covenant_DB['operator'], threshold: string) {
  const limit = thresholdNumber(threshold);
  if (value === null || limit === null || operator === 'none') return 'Sin evaluar';
  if (operator === 'gt') return value > limit ? 'Cumple' : 'Incumple';
  if (operator === 'gte') return value >= limit ? 'Cumple' : 'Incumple';
  if (operator === 'lt') return value < limit ? 'Cumple' : 'Incumple';
  if (operator === 'lte') return value <= limit ? 'Cumple' : 'Incumple';
  return 'Sin evaluar';
}

function trendFor(row: BenchRow, key: string) {
  const statements = [...row.statements].sort((a, b) => a.periodDate.localeCompare(b.periodDate));
  const latest = statements.at(-1);
  const previous = statements.at(-2);
  const latestValue = ratioValue(latest, key);
  const previousValue = ratioValue(previous, key);
  if (latestValue === null || previousValue === null) return null;
  return latestValue - previousValue;
}

function qualityScore(row: BenchRow) {
  const latest = latestStatement(row, 'latest');
  const metrics = metricMap(latest);
  const financialCoverage = ratioKeys.filter(key => metrics[key] !== null).length / ratioKeys.length;
  const hasContract = creditGranted(row) === 'Sí, con contrato' ? 1 : 0;
  const hasYears = Math.min(1, years(row).length / 3);
  const hasCovenants = row.covenants.some(c => c.type === 'financial') ? 1 : 0;
  return Math.round((financialCoverage * 45) + (hasYears * 20) + (hasContract * 20) + (hasCovenants * 15));
}

function syntageBand(score: number) {
  if (score >= 80) return 'Alta';
  if (score >= 60) return 'Media alta';
  if (score >= 40) return 'Media';
  return 'Baja';
}

function segmentKey(row: BenchRow, dims: string[]) {
  if (dims.length === 0) return 'Global';
  return dims.map(dim => benchmarkValue(row, dim as BenchmarkFilterKey)).join(' + ');
}

const BenchmarkingPage: React.FC = () => {
  const [rows, setRows] = useState<BenchRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [period, setPeriod] = useState('latest');
  const [dims, setDims] = useState<string[]>([]);
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const clients = await db.getClients();
      const loaded = await Promise.all(clients.map(async client => {
        const [fields, statements, covenants, transactions] = await Promise.all([
          db.getCustomFields(client.id),
          db.getStatements(client.id),
          db.getCovenants(client.id),
          db.getTransactions(client.id),
        ]);
        const contractFiles = (await Promise.all(transactions.map(t => db.getContractFiles(t.id)))).flat();
        return { client, fields, statements, covenants, transactions, contractFiles };
      }));
      setRows(loaded);
      setLoading(false);
    })();
  }, []);

  const periods = useMemo(() => {
    const set = new Set<string>();
    rows.forEach(r => r.statements.forEach(s => set.add(s.period || s.periodDate)));
    return Array.from(set).sort();
  }, [rows]);

  const filtered = rows.filter(row => BENCHMARK_FILTERS.every(filter => matchesFilter(row, filter.key, filters[filter.key])));

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
      ratios: Object.fromEntries(ratioKeys.map(key => [key, weightedAverage(groupRows, period, key)])),
    })).sort((a, b) => b.exposure - a.exposure);
  }, [filtered, dims, period]);

  const covenantRows = filtered.flatMap(row => row.covenants.filter(c => c.type === 'financial').map(cov => {
    const stmt = latestStatement(row, period);
    const formula = cov.formulaByPeriod?.[stmt?.period || ''] || cov.formula || cov.name;
    const value = stmt ? evaluateFormula(formula, stmt) : null;
    return {
      client: row.client.name,
      covenant: cov.name,
      value,
      threshold: cov.threshold,
      operator: cov.operator,
      segment: segmentKey(row, dims),
      status: covenantStatus(value, cov.operator, cov.threshold),
    };
  }));

  const furtherAnalysisRows = useMemo(() => filtered.flatMap(row => {
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
      legalEntity(row),
      operatingAge(row),
      mainProduct(row),
      targetSegment(row),
      fundingModel(row),
      geography(row),
      originationChannel(row),
      maturityStage(row),
      ticketRange(row),
      statementType(row),
      rowYears,
      creditGranted(row),
      row.covenants.filter(c => c.type === 'financial').length,
      qualityScore(row),
      syntageBand(qualityScore(row)),
    ];
    const statements = period === 'latest'
      ? [latestStatement(row, 'latest')].filter((stmt): stmt is FinancialStatement_DB => Boolean(stmt))
      : row.statements.filter(stmt => stmt.period === period || stmt.periodDate === period);
    const scopedStatements = statements.length ? statements : [undefined];
    return scopedStatements.map(stmt => {
      const metrics = metricMap(stmt);
      return [
        ...base,
        stmt?.period || '',
        stmt?.periodDate || '',
        stmt?.documentType || '',
        stmt?.fileName || '',
        ...ratioKeys.map(key => metrics[key]),
        ...syntageRatioKeys.map(key => trendFor(row, key)),
      ];
    });
  }), [filtered, dims, period]);

  const syntageStudy = useMemo(() => {
    const exposure = filtered.reduce((sum, row) => sum + (row.client.totalCreditValue || 0), 0);
    const scores = filtered.map(qualityScore);
    const avgScore = average(scores);
    const latestMetrics = filtered.map(row => metricMap(latestStatement(row, period)));
    const debtMedian = percentile(latestMetrics.map(m => m.debt_ebitda), 0.5);
    const dscrMedian = percentile(latestMetrics.map(m => m.dscr), 0.5);
    const liquidityMedian = percentile(latestMetrics.map(m => m.current_ratio), 0.5);
    const covenantBreaches = covenantRows.filter(row => row.status === 'Incumple').length;
    const completeContracts = filtered.filter(row => creditGranted(row) === 'Sí, con contrato').length;
    const topSegments = groups.slice(0, 3).map(group => ({
      name: group.name,
      clients: group.rows.length,
      exposure: group.exposure,
      exposurePct: exposure ? group.exposure / exposure : 0,
    }));
    const strengths = [
      completeContracts ? `${completeContracts} de ${filtered.length} clientes tienen crédito respaldado con contrato cargado.` : 'La base permite identificar contratos faltantes por cliente.',
      dscrMedian !== null ? `DSCR mediano de ${formatMetric(dscrMedian, 'dscr')}, útil para comparar capacidad de servicio entre cohortes.` : 'La estructura deja preparado el cálculo de DSCR cuando existan intereses/EBITDA.',
      topSegments[0] ? `El segmento principal concentra ${(topSegments[0].exposurePct * 100).toLocaleString('es-MX', { maximumFractionDigits: 1 })}% de la exposición.` : 'No hay concentración segmentada con los filtros actuales.',
    ];
    const watchItems = [
      covenantBreaches ? `${covenantBreaches} covenants financieros aparecen en incumplimiento bajo el periodo seleccionado.` : 'No se detectan incumplimientos evaluables en los covenants filtrados.',
      debtMedian !== null && debtMedian > 4 ? `Deuda/EBITDA mediana elevada (${formatMetric(debtMedian, 'debt_ebitda')}).` : 'Monitorear deuda/EBITDA en clientes sin EBITDA reciente o con datos incompletos.',
      liquidityMedian !== null && liquidityMedian < 1 ? `Razón corriente mediana por debajo de 1.0x (${formatMetric(liquidityMedian, 'current_ratio')}).` : 'Completar cuentas de activo/pasivo corriente para robustecer el análisis de liquidez.',
    ];
    return {
      title: 'Covenant Metrics & Insights',
      periodLabel: period === 'latest' ? 'Último disponible' : period,
      exposure,
      clients: filtered.length,
      segments: groups.length,
      avgScore,
      band: avgScore === null ? 'Sin dato' : syntageBand(avgScore),
      debtMedian,
      dscrMedian,
      liquidityMedian,
      covenantBreaches,
      topSegments,
      strengths,
      watchItems,
    };
  }, [filtered, groups, covenantRows, period]);

  const exportExcel = async () => {
    setExporting(true);
    try {
      const summary: SheetDef = {
        name: 'Dashboard Benchmark',
        rows: [
          ['BENCHMARKING - FURTHER ANALYSIS'],
          [],
          ['Periodo', period === 'latest' ? 'Último disponible' : period],
          ['Clientes incluidos', filtered.length],
          ['Exposición total', filtered.reduce((s, r) => s + (r.client.totalCreditValue || 0), 0)],
          ['Segmentación activa', dims.length ? dims.map(dim => BENCHMARK_FILTERS.find(f => f.key === dim)?.label || dim).join(' + ') : 'Global'],
          ['Insight Readiness Score', syntageStudy.avgScore],
          ['Banda promedio', syntageStudy.band],
          [],
          ['Segmento', 'Clientes', 'Exposición', '% Exposición', ...ratioKeys.map(k => ratioLabels[k])],
          ...groups.map(g => [g.name, g.rows.length, g.exposure, syntageStudy.exposure ? g.exposure / syntageStudy.exposure : null, ...ratioKeys.map(k => g.ratios[k] as number | null)]),
        ],
        colWidths: [36, 16, 18, 14, ...ratioKeys.map(() => 14)],
      };
      const cohortSheet: SheetDef = {
        name: 'Cohortes',
        rows: [
          ['MATRIZ DE COHORTES'],
          [],
          ['Segmento', 'Métrica', 'Promedio pond.', 'Promedio simple', 'P25', 'Mediana', 'P75', 'Observaciones'],
          ...groups.flatMap(group => ratioKeys.map(key => {
            const values = group.rows.map(row => ratioValue(latestStatement(row, period), key));
            return [
              group.name,
              ratioLabels[key],
              group.ratios[key] as number | null,
              average(values),
              percentile(values, 0.25),
              percentile(values, 0.5),
              percentile(values, 0.75),
              values.filter(v => v !== null).length,
            ];
          })),
        ],
        colWidths: [36, 22, 16, 16, 14, 14, 14, 14],
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
            'Crédito / contrato', '# Covenants financieros', 'Insight Readiness Score', 'Readiness band',
            'Periodo', 'Fecha periodo', 'Tipo documento', 'Archivo fuente',
            ...ratioKeys.map(key => ratioLabels[key]),
            ...syntageRatioKeys.map(key => `Δ ${ratioLabels[key]}`),
          ],
          ...furtherAnalysisRows,
        ],
        colWidths: [28, 30, 18, 22, 10, 16, 16, 36, 18, 18, 22, 22, 22, 20, 20, 18, 14, 18, 20, 20, 12, 14, 14, 16, 14, 18, 26, ...ratioKeys.map(() => 14), ...syntageRatioKeys.map(() => 14)],
      };
      const covSheet: SheetDef = {
        name: 'Covenants',
        rows: [
          ['COVENANTS POR CLIENTE'],
          [],
          ['Segmento', 'Cliente', 'Covenant', 'Valor', 'Operador', 'Umbral', 'Estatus'],
          ...covenantRows.map(r => [r.segment, r.client, r.covenant, r.value, r.operator, r.threshold, r.status]),
        ],
        colWidths: [32, 28, 34, 14, 12, 14, 16],
      };
      const miniStudySheet: SheetDef = {
        name: 'Covenant Metrics',
        rows: [
          ['COVENANT METRICS & INSIGHTS'],
          [],
          ['Periodo analizado', syntageStudy.periodLabel],
          ['Clientes', syntageStudy.clients],
          ['Segmentos', syntageStudy.segments],
          ['Exposición total', syntageStudy.exposure],
          ['Insight Readiness Score', syntageStudy.avgScore],
          ['Banda promedio', syntageStudy.band],
          ['Mediana Deuda/EBITDA', syntageStudy.debtMedian],
          ['Mediana DSCR', syntageStudy.dscrMedian],
          ['Mediana Razón Corriente', syntageStudy.liquidityMedian],
          ['Covenants en incumplimiento', syntageStudy.covenantBreaches],
          [],
          ['Composición de exposición'],
          ['Segmento', 'Clientes', 'Exposición', '% Exposición'],
          ...syntageStudy.topSegments.map(row => [row.name, row.clients, row.exposure, row.exposurePct]),
          [],
          ['Fortalezas observadas'],
          ...syntageStudy.strengths.map(item => [item]),
          [],
          ['Focos de seguimiento'],
          ...syntageStudy.watchItems.map(item => [item]),
          [],
          ['Notas metodológicas'],
          ['Insight Readiness Score = cobertura financiera 45%, años históricos 20%, contrato 20%, covenants 15%.'],
          ['Este entregable usa los filtros activos y está diseñado para revisión rápida previa a comité.'],
        ],
        colWidths: [38, 18, 18, 16],
        wrapColumns: [1],
      };
      const dictionarySheet: SheetDef = {
        name: 'Diccionario',
        rows: [
          ['DICCIONARIO DE VARIABLES'],
          [],
          ['Variable', 'Definición'],
          ...BENCHMARK_FILTERS.map(filter => [filter.label, `Campo usado para segmentar benchmark: ${filter.key}`]),
          ...ratioKeys.map(key => [ratioLabels[key], ratioFormulaDescriptions[key] || key]),
          ['Insight Readiness Score', 'Índice 0-100 de completitud analítica: métricas financieras, años, contrato y covenants.'],
          ['Readiness band', 'Alta >=80, Media alta >=60, Media >=40, Baja <40.'],
        ],
        colWidths: [28, 80],
        wrapColumns: [2],
      };
      const { exportToExcel } = await import('../../lib/export');
      await exportToExcel([summary, cohortSheet, baseSheet, covSheet, miniStudySheet, dictionarySheet], 'Benchmarking_Covenant_Metrics_Insights');
    } finally {
      setExporting(false);
    }
  };

  const updateFilter = (key: BenchmarkFilterKey, value: string) => setFilters(prev => ({ ...prev, [key]: value }));
  const clearFilters = () => setFilters(EMPTY_FILTERS);

  return (
    <div className="flex-1 bg-slate-50 min-h-screen p-8">
      <WorkingOverlay show={loading || exporting} title={exporting ? 'Exportando benchmarking' : 'Cargando benchmarking'} />
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-black text-slate-900 tracking-tight">Benchmarking</h1>
          <p className="text-slate-500 text-sm mt-1">Promedios ponderados y segmentación del portafolio.</p>
        </div>
        <button onClick={exportExcel} disabled={loading || exporting} className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white font-bold px-4 py-2.5 rounded-xl text-sm disabled:opacity-50">
          <FileSpreadsheet className="w-4 h-4" /> Excel Further Analysis
        </button>
      </div>

      <div className="bg-white border border-slate-200 rounded-2xl p-5 mb-6">
        <div className="flex items-center gap-2 mb-4">
          <Filter className="w-4 h-4 text-indigo-600" />
          <h2 className="text-sm font-black text-slate-900 uppercase tracking-widest">Filtros y segmentación</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <select value={period} onChange={e => setPeriod(e.target.value)} className="bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-sm font-bold">
            <option value="latest">Último disponible</option>
            {periods.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
          {BENCHMARK_FILTERS.map(filter => (
            <select key={filter.key} value={filters[filter.key]} onChange={e => updateFilter(filter.key, e.target.value)} className="bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-sm font-bold">
              <option value="all">{filter.allLabel}</option>
              {filterOptions(rows, filter.key).map(v => <option key={v} value={v}>{v}</option>)}
            </select>
          ))}
        </div>
        <button onClick={clearFilters} className="mt-3 text-xs font-black text-slate-500 hover:text-slate-900 uppercase tracking-widest">Limpiar filtros</button>
        <div className="flex flex-wrap gap-2 mt-4">
          {BENCHMARK_FILTERS.map(({ key, label }) => (
            <button key={key} onClick={() => setDims(p => p.includes(key) ? p.filter(x => x !== key) : [...p, key])} className={`px-3 py-1.5 rounded-lg text-xs font-black border ${dims.includes(key) ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-500 border-slate-200'}`}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="bg-white border border-slate-200 rounded-2xl p-4">
          <p className="text-xs font-black text-slate-400 uppercase tracking-widest">Clientes</p>
          <p className="text-2xl font-black text-slate-900 mt-1">{filtered.length}</p>
        </div>
        <div className="bg-white border border-slate-200 rounded-2xl p-4">
          <p className="text-xs font-black text-slate-400 uppercase tracking-widest">Segmentos</p>
          <p className="text-2xl font-black text-slate-900 mt-1">{groups.length}</p>
        </div>
        <div className="bg-white border border-indigo-200 rounded-2xl p-4">
          <p className="text-xs font-black text-indigo-600 uppercase tracking-widest">Exposición total</p>
          <p className="text-2xl font-black text-indigo-700 mt-1">{filtered.reduce((s, r) => s + (r.client.totalCreditValue || 0), 0).toLocaleString('es-MX')}</p>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden mb-6">
        <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <ClipboardList className="w-4 h-4 text-indigo-600" />
            <h2 className="text-sm font-black text-slate-900 uppercase tracking-widest">Covenant Metrics & Insights</h2>
          </div>
          <span className="text-xs font-black text-indigo-600 uppercase tracking-widest">{syntageStudy.periodLabel}</span>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-[0.9fr_1.1fr] gap-0">
          <div className="p-5 border-b lg:border-b-0 lg:border-r border-slate-100">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-xs font-black text-slate-400 uppercase tracking-widest">Score</p>
                <p className="text-3xl font-black text-slate-900 mt-1">{syntageStudy.avgScore === null ? 'N/A' : syntageStudy.avgScore.toFixed(0)}</p>
                <p className="text-xs font-bold text-slate-500 mt-1">{syntageStudy.band}</p>
              </div>
              <div>
                <p className="text-xs font-black text-slate-400 uppercase tracking-widest">Incumplimientos</p>
                <p className="text-3xl font-black text-slate-900 mt-1">{syntageStudy.covenantBreaches}</p>
                <p className="text-xs font-bold text-slate-500 mt-1">covenants financieros</p>
              </div>
              <div className="border-t border-slate-100 pt-3">
                <p className="text-xs font-black text-slate-400 uppercase tracking-widest">Deuda/EBITDA</p>
                <p className="text-xl font-black text-slate-900 mt-1">{formatMetric(syntageStudy.debtMedian, 'debt_ebitda')}</p>
              </div>
              <div className="border-t border-slate-100 pt-3">
                <p className="text-xs font-black text-slate-400 uppercase tracking-widest">DSCR</p>
                <p className="text-xl font-black text-slate-900 mt-1">{formatMetric(syntageStudy.dscrMedian, 'dscr')}</p>
              </div>
            </div>
          </div>
          <div className="p-5 grid grid-cols-1 md:grid-cols-2 gap-5">
            <div>
              <p className="text-xs font-black text-slate-400 uppercase tracking-widest mb-3">Fortalezas observadas</p>
              <div className="space-y-2">
                {syntageStudy.strengths.map(item => (
                  <p key={item} className="text-sm text-slate-700 leading-snug border-l-2 border-emerald-400 pl-3">{item}</p>
                ))}
              </div>
            </div>
            <div>
              <p className="text-xs font-black text-slate-400 uppercase tracking-widest mb-3">Focos de seguimiento</p>
              <div className="space-y-2">
                {syntageStudy.watchItems.map(item => (
                  <p key={item} className="text-sm text-slate-700 leading-snug border-l-2 border-amber-400 pl-3">{item}</p>
                ))}
              </div>
            </div>
          </div>
        </div>
        <div className="px-5 py-3 bg-slate-50 border-t border-slate-100">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {syntageStudy.topSegments.map(segment => (
              <div key={segment.name} className="bg-white border border-slate-200 rounded-xl p-3">
                <p className="text-xs font-black text-slate-400 uppercase tracking-widest truncate">{segment.name}</p>
                <p className="text-sm font-black text-slate-900 mt-1">{segment.exposure.toLocaleString('es-MX')} <span className="text-xs text-slate-400">({(segment.exposurePct * 100).toLocaleString('es-MX', { maximumFractionDigits: 1 })}%)</span></p>
              </div>
            ))}
            {syntageStudy.topSegments.length === 0 && (
              <p className="text-sm text-slate-400">Sin segmentos disponibles para los filtros actuales.</p>
            )}
          </div>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100 flex items-center gap-2">
          <Layers className="w-4 h-4 text-indigo-600" />
          <h2 className="text-sm font-black text-slate-900 uppercase tracking-widest">Dashboard segmentado</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-slate-50">
                <th className="text-left px-4 py-2 font-black text-slate-600 uppercase">Segmento</th>
                <th className="text-right px-4 py-2 font-black text-slate-600 uppercase">Clientes</th>
                <th className="text-right px-4 py-2 font-black text-slate-600 uppercase">Exposición</th>
                {ratioKeys.map(k => <th key={k} className="text-right px-4 py-2 font-black text-slate-600 uppercase whitespace-nowrap">{ratioLabels[k]}</th>)}
              </tr>
            </thead>
            <tbody>
              {groups.map((g, i) => (
                <tr key={g.name} className={i % 2 ? 'bg-slate-50/50' : 'bg-white'}>
                  <td className="px-4 py-2 font-bold text-slate-800">{g.name}</td>
                  <td className="px-4 py-2 text-right font-mono">{g.rows.length}</td>
                  <td className="px-4 py-2 text-right font-mono">{g.exposure.toLocaleString('es-MX')}</td>
                  {ratioKeys.map(k => <td key={k} className="px-4 py-2 text-right font-mono">{g.ratios[k] === null ? 'N/A' : Number(g.ratios[k]).toLocaleString('es-MX', { maximumFractionDigits: 4 })}</td>)}
                </tr>
              ))}
              {groups.length === 0 && (
                <tr><td colSpan={11} className="px-4 py-8 text-center text-slate-400">Sin datos para estos filtros</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden mt-6">
        <div className="px-5 py-3 border-b border-slate-100 flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-indigo-600" />
          <h2 className="text-sm font-black text-slate-900 uppercase tracking-widest">Covenants por cliente</h2>
        </div>
        <div className="overflow-x-auto max-h-96">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-slate-50">
              <tr>
                <th className="text-left px-4 py-2 font-black text-slate-600 uppercase">Segmento</th>
                <th className="text-left px-4 py-2 font-black text-slate-600 uppercase">Cliente</th>
                <th className="text-left px-4 py-2 font-black text-slate-600 uppercase">Covenant</th>
                <th className="text-right px-4 py-2 font-black text-slate-600 uppercase">Valor</th>
              </tr>
            </thead>
            <tbody>
              {covenantRows.map((r, i) => (
                <tr key={`${r.client}-${r.covenant}-${i}`} className="border-t border-slate-100">
                  <td className="px-4 py-2">{r.segment}</td>
                  <td className="px-4 py-2 font-bold">{r.client}</td>
                  <td className="px-4 py-2">{r.covenant}</td>
                  <td className="px-4 py-2 text-right font-mono">{r.value === null ? 'N/A' : r.value.toLocaleString('es-MX', { maximumFractionDigits: 4 })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default BenchmarkingPage;
