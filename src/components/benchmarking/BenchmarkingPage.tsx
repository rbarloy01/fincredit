import React, { useEffect, useMemo, useState } from 'react';
import { BarChart3, Download, Filter, Layers, TrendingUp } from 'lucide-react';
import { db, Client, Covenant_DB, CustomField, FinancialStatement_DB } from '../../db/index';
import { evaluateFormula, standardRatios } from '../../lib/financialMetrics';
import { exportToExcel, SheetDef } from '../../lib/export';
import WorkingOverlay from '../common/WorkingOverlay';

type BenchRow = {
  client: Client;
  fields: CustomField[];
  statements: FinancialStatement_DB[];
  covenants: Covenant_DB[];
};

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

function fieldValue(fields: CustomField[], patterns: RegExp[]) {
  const found = fields.find(f => patterns.some(re => re.test(f.label)));
  return found?.value?.trim() || '';
}

function geography(row: BenchRow) {
  return fieldValue(row.fields, [/ubic/i, /local/i, /geograf/i, /estado/i, /ciudad/i, /pais/i, /país/i]) || 'Sin dato';
}

function operationStart(row: BenchRow) {
  return fieldValue(row.fields, [/inicio.*oper/i, /fecha.*inicio/i, /start/i, /fundaci/i]) || 'Sin dato';
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

function segmentKey(row: BenchRow, dims: string[]) {
  if (dims.length === 0) return 'Global';
  return dims.map(dim => {
    if (dim === 'creditType') return row.client.creditType?.join(', ') || 'Sin dato';
    if (dim === 'geography') return geography(row);
    if (dim === 'industry') return row.client.industry || 'Sin dato';
    if (dim === 'analyst') return row.client.analystName || 'Sin dato';
    if (dim === 'operationStart') return operationStart(row);
    return 'Sin dato';
  }).join(' + ');
}

const BenchmarkingPage: React.FC = () => {
  const [rows, setRows] = useState<BenchRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [period, setPeriod] = useState('latest');
  const [dims, setDims] = useState<string[]>(['creditType']);
  const [creditType, setCreditType] = useState('all');
  const [geo, setGeo] = useState('all');
  const [industry, setIndustry] = useState('all');

  useEffect(() => {
    (async () => {
      setLoading(true);
      const clients = await db.getClients();
      const loaded = await Promise.all(clients.map(async client => {
        const [fields, statements, covenants] = await Promise.all([
          db.getCustomFields(client.id),
          db.getStatements(client.id),
          db.getCovenants(client.id),
        ]);
        return { client, fields, statements, covenants };
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

  const filtered = rows.filter(row => {
    const ct = row.client.creditType?.join(', ') || 'Sin dato';
    return (creditType === 'all' || ct === creditType) &&
      (geo === 'all' || geography(row) === geo) &&
      (industry === 'all' || row.client.industry === industry);
  });

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
    return {
      client: row.client.name,
      covenant: cov.name,
      value: stmt ? evaluateFormula(formula, stmt) : null,
      threshold: cov.threshold,
      operator: cov.operator,
      segment: segmentKey(row, dims),
    };
  }));

  const exportExcel = async () => {
    setExporting(true);
    try {
      const summary: SheetDef = {
        name: 'Benchmarking',
        rows: [
          ['BENCHMARKING'],
          [],
          ['Periodo', period === 'latest' ? 'Último disponible' : period],
          ['Clientes incluidos', filtered.length],
          ['Exposición total', filtered.reduce((s, r) => s + (r.client.totalCreditValue || 0), 0)],
          [],
          ['Segmento', 'Clientes', 'Exposición', ...ratioKeys.map(k => ratioLabels[k])],
          ...groups.map(g => [g.name, g.rows.length, g.exposure, ...ratioKeys.map(k => g.ratios[k] as number | null)]),
        ],
        colWidths: [36, 14, 18, ...ratioKeys.map(() => 14)],
      };
      const covSheet: SheetDef = {
        name: 'Covenants',
        rows: [
          ['COVENANTS POR CLIENTE'],
          [],
          ['Segmento', 'Cliente', 'Covenant', 'Valor', 'Operador', 'Umbral'],
          ...covenantRows.map(r => [r.segment, r.client, r.covenant, r.value, r.operator, r.threshold]),
        ],
        colWidths: [32, 28, 34, 14, 12, 14],
      };
      await exportToExcel([summary, covSheet], 'Benchmarking_Portafolio');
    } finally {
      setExporting(false);
    }
  };

  const unique = (vals: string[]) => Array.from(new Set(vals.filter(Boolean))).sort();
  const creditTypes = unique(rows.map(r => r.client.creditType?.join(', ') || 'Sin dato'));
  const geos = unique(rows.map(geography));
  const industries = unique(rows.map(r => r.client.industry || 'Sin dato'));

  return (
    <div className="flex-1 bg-slate-50 min-h-screen p-8">
      <WorkingOverlay show={loading || exporting} title={exporting ? 'Exportando benchmarking' : 'Cargando benchmarking'} />
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-black text-slate-900 tracking-tight">Benchmarking</h1>
          <p className="text-slate-500 text-sm mt-1">Promedios ponderados y segmentación del portafolio.</p>
        </div>
        <button onClick={exportExcel} disabled={loading || exporting} className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white font-bold px-4 py-2.5 rounded-xl text-sm disabled:opacity-50">
          <Download className="w-4 h-4" /> Excel
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
          <select value={creditType} onChange={e => setCreditType(e.target.value)} className="bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-sm font-bold">
            <option value="all">Todo tipo crédito</option>
            {creditTypes.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
          <select value={geo} onChange={e => setGeo(e.target.value)} className="bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-sm font-bold">
            <option value="all">Toda ubicación</option>
            {geos.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
          <select value={industry} onChange={e => setIndustry(e.target.value)} className="bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-sm font-bold">
            <option value="all">Toda industria</option>
            {industries.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
        <div className="flex flex-wrap gap-2 mt-4">
          {[
            ['creditType', 'Tipo crédito'],
            ['geography', 'Ubicación'],
            ['industry', 'Industria'],
            ['analyst', 'Analista'],
            ['operationStart', 'Inicio operación'],
          ].map(([key, label]) => (
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
