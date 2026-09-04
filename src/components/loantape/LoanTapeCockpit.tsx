import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ResponsiveContainer, ComposedChart, BarChart, LineChart,
  Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, Cell,
} from 'recharts';
import { FileSpreadsheet, LayoutDashboard, RotateCcw, Search } from 'lucide-react';
import { LoanTape_DB } from '../../db/index';
import {
  buildCockpitData, buildVintage, snapshotAnalysis, buildCockpitNarrative,
  periodLabel, periodQuality, DPD_BUCKETS, type CockpitData,
} from '../../lib/loanTapeCockpit';
import type { StandardLoan } from '../../lib/loanTapeAnalytics';
import { loadExportModule } from '../../lib/exportLoader';
import { reserveDownloadTarget } from '../../lib/browserDownload';
import ChartCard from './ChartCard';

const C = { green: '#059669', amber: '#f59e0b', red: '#ef4444', indigo: '#4f46e5', cyan: '#06b6d4', slate: '#94a3b8' };
const CLIENT_COLORS = ['#4f46e5', '#06b6d4', '#059669', '#f59e0b', '#ef4444'];
const money = (v: number) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }).format(v || 0);
const moneyM = (v: number) => `$${((v || 0) / 1e6).toFixed(1)}M`;
const pctS = (v: number) => `${((v || 0) * 100).toFixed(1)}%`;
const clean = (v: any) => String(v ?? '').trim();
const norm = (v: any) => clean(v).toLowerCase();

type SlicerState = {
  product: string;
  status: string;
  dpdBucket: string;
  sector: string;
  borrower: string;
  query: string;
};

const EMPTY_SLICERS: SlicerState = { product: '', status: '', dpdBucket: '', sector: '', borrower: '', query: '' };

interface Props { tapes: LoanTape_DB[]; clientName?: string; }

function bucketForDpd(days: number | null | undefined) {
  if (days === null || days === undefined) return 'Sin DPD';
  if (days <= 0) return '0 dias';
  if (days <= 30) return '1-30';
  if (days <= 60) return '31-60';
  if (days <= 90) return '61-90';
  if (days <= 180) return '91-180';
  return '>180';
}

function topOptions(rows: StandardLoan[], field: keyof Pick<StandardLoan, 'client' | 'loan_type' | 'loan_status' | 'state'>, limit = 24) {
  const totals = new Map<string, { balance: number; count: number }>();
  rows.forEach(row => {
    const key = clean(row[field]);
    if (!key) return;
    const current = totals.get(key) || { balance: 0, count: 0 };
    current.balance += row.outstanding_balance || 0;
    current.count += 1;
    totals.set(key, current);
  });
  return [...totals.entries()]
    .sort((a, b) => b[1].balance - a[1].balance || b[1].count - a[1].count)
    .slice(0, limit)
    .map(([value, meta]) => ({ value, label: value, meta }));
}

function filterTapes(tapes: LoanTape_DB[], filters: SlicerState): LoanTape_DB[] {
  const q = norm(filters.query);
  return tapes.map(tape => {
    const data: any = tape.extractedData;
    const rows = Array.isArray(data?._standardized) ? data._standardized as StandardLoan[] : [];
    const filtered = rows.filter(row => {
      if (filters.product && clean(row.loan_type) !== filters.product) return false;
      if (filters.status && clean(row.loan_status) !== filters.status) return false;
      if (filters.dpdBucket && bucketForDpd(row.days_overdue) !== filters.dpdBucket) return false;
      if (filters.sector && clean(row.state) !== filters.sector) return false;
      if (filters.borrower && clean(row.client) !== filters.borrower) return false;
      if (q) {
        const haystack = `${row.loan_id || ''} ${row.client || ''} ${row.loan_type || ''} ${row.loan_status || ''} ${row.state || ''}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
    return { ...tape, extractedData: { ...(data || {}), _standardized: filtered } };
  });
}

export default function LoanTapeCockpit({ tapes, clientName }: Props) {
  const baseData: CockpitData = useMemo(() => buildCockpitData(tapes), [tapes]);
  const [filters, setFilters] = useState<SlicerState>(EMPTY_SLICERS);
  const filteredTapes = useMemo(() => filterTapes(tapes, filters), [tapes, filters]);
  const data: CockpitData = useMemo(() => buildCockpitData(filteredTapes), [filteredTapes]);
  const periodsKey = data.periods.join('|');

  const [selected, setSelected] = useState<string[]>(data.periods);
  const [compare, setCompare] = useState(false);
  const [focus, setFocus] = useState<string>(data.periods[data.periods.length - 1] || '');
  const [cmpA, setCmpA] = useState<string>(data.periods[data.periods.length - 2] || '');
  const [cmpB, setCmpB] = useState<string>(data.periods[data.periods.length - 1] || '');
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    setSelected(data.periods);
    setFocus(data.periods[data.periods.length - 1] || '');
    setCmpA(data.periods[data.periods.length - 2] || '');
    setCmpB(data.periods[data.periods.length - 1] || '');
  }, [periodsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const nodesRef = useRef<Record<string, HTMLElement | null>>({});
  const registerNode = useCallback((id: string, node: HTMLElement | null) => { nodesRef.current[id] = node; }, []);

  if (!baseData.periods.length) {
    return (
      <div className="bg-white border border-slate-200 rounded-2xl p-12 text-center">
        <LayoutDashboard className="w-10 h-10 text-slate-300 mx-auto mb-3" />
        <p className="text-sm font-bold text-slate-500">Aún no hay loan tapes estandarizados para consolidar.</p>
        <p className="text-xs text-slate-400 mt-1">Sube archivos en la pestaña “Archivos” y aparecerán aquí.</p>
      </div>
    );
  }

  const selSet = new Set(selected);
  const sel = data.series.filter(s => selSet.has(s.period));
  const mig = data.migration.filter(m => selSet.has(m.period));
  const emptyPoint = {
    period: '',
    label: '—',
    saldo: 0,
    creditos: 0,
    clientes: 0,
    wa_rate: null,
    vig: 0,
    atr: 0,
    ven: 0,
    sinDato: 0,
    vigPct: 0,
    atrPct: 0,
    venPct: 0,
    dpd: [0, 0, 0, 0, 0, 0],
    dpdPct: [0, 0, 0, 0, 0, 0],
    over180: 0,
    hhi: 0,
    top1: 0,
    top3: 0,
    top5: 0,
    top10: 0,
    runoff: null,
  };
  const focusPoint = data.series.find(s => s.period === focus) || sel[sel.length - 1] || data.series[data.series.length - 1] || emptyPoint;
  const focusIdxInSel = sel.findIndex(s => s.period === focusPoint.period);
  const prevPoint = focusIdxInSel > 0 ? sel[focusIdxInSel - 1] : null;

  const togglePeriod = (p: string) => setSelected(prev => (prev.includes(p) ? prev.filter(x => x !== p) : [...prev, p]).sort());
  const preset = (which: 'todo' | 'u3' | 'trim' | 'y2026') => {
    if (which === 'todo') return setSelected(data.periods);
    if (which === 'u3') return setSelected(data.periods.slice(-3));
    if (which === 'y2026') return setSelected(data.periods.filter(p => p.startsWith('2026')));
    // trimestral: one period per quarter (last of each)
    const byQ = new Map<string, string>();
    for (const p of data.periods) { const q = `${p.slice(0, 4)}Q${Math.ceil((+p.slice(5, 7)) / 3)}`; byQ.set(q, p); }
    setSelected([...byQ.values()].sort());
  };

  // chart datasets
  const evoData = sel.map(s => ({ label: s.label, saldo: s.saldo, venPct: +(s.venPct * 100).toFixed(2) }));
  const qualData = sel.map(s => ({ label: s.label, Vigente: +(s.vigPct * 100).toFixed(1), Atrasada: +(s.atrPct * 100).toFixed(1), Vencida: +(s.venPct * 100).toFixed(1) }));
  const hhiData = sel.map(s => ({ label: s.label, HHI: +s.hhi.toFixed(3), Top1: +(s.top1 * 100).toFixed(1) }));
  const rollData = mig.map(m => ({ label: m.label, Deteriorados: m.deteriorated, Curados: -m.cured }));
  const concData = [
    { n: 'Top 1', pct: +(focusPoint.top1 * 100).toFixed(1) },
    { n: 'Top 3', pct: +(focusPoint.top3 * 100).toFixed(1) },
    { n: 'Top 5', pct: +(focusPoint.top5 * 100).toFixed(1) },
    { n: 'Top 10', pct: +(focusPoint.top10 * 100).toFixed(1) },
  ];
  const cliData = sel.map(s => {
    const idx = data.periods.indexOf(s.period);
    const row: any = { label: s.label };
    data.clientTrends.forEach(ct => { const v = ct.values[idx]; row[ct.client] = v != null ? +(v / 1e6).toFixed(2) : null; });
    return row;
  });
  const vintage = useMemo(() => buildVintage(data, focusPoint.period), [data, focusPoint.period]);
  const vintData = vintage.map(v => ({ cohort: v.cohort, Vigente: +(v.vig / 1e6).toFixed(2), Atrasada: +(v.atr / 1e6).toFixed(2), Vencida: +(v.ven / 1e6).toFixed(2), venPct: +(v.venPct * 100).toFixed(1) }));
  const narrative = useMemo(() => buildCockpitNarrative(data, selected), [data, selected]);
  const snapFocus = useMemo(() => snapshotAnalysis(filteredTapes, focusPoint.period), [filteredTapes, focusPoint.period]);
  const snapA = useMemo(() => (compare && cmpA ? snapshotAnalysis(filteredTapes, cmpA) : null), [filteredTapes, compare, cmpA]);
  const snapB = useMemo(() => (compare && cmpB ? snapshotAnalysis(filteredTapes, cmpB) : null), [filteredTapes, compare, cmpB]);
  const filterOptions = useMemo(() => {
    const rows = baseData.allRows;
    const bucketTotals = new Map<string, { balance: number; count: number }>();
    rows.forEach(row => {
      const key = bucketForDpd(row.days_overdue);
      const current = bucketTotals.get(key) || { balance: 0, count: 0 };
      current.balance += row.outstanding_balance || 0;
      current.count += 1;
      bucketTotals.set(key, current);
    });
    return {
      product: topOptions(rows, 'loan_type'),
      status: topOptions(rows, 'loan_status'),
      sector: topOptions(rows, 'state'),
      borrower: topOptions(rows, 'client', 40),
      dpdBucket: [...DPD_BUCKETS, 'Sin DPD'].map(value => ({ value, label: value, meta: bucketTotals.get(value) || { balance: 0, count: 0 } })),
    };
  }, [baseData.allRows]);
  const activeFilterCount = Object.values(filters).filter(Boolean).length;
  const resetFilters = () => setFilters(EMPTY_SLICERS);
  const updateFilter = (key: keyof SlicerState, value: string) => setFilters(prev => ({ ...prev, [key]: value }));

  const handleExcel = async () => {
    setExporting(true);
    const target = reserveDownloadTarget();
    try {
      const mod: any = await loadExportModule();
      const images: Array<{ id: string; base64: string }> = [];
      for (const [id, node] of Object.entries(nodesRef.current)) {
        if (!node) continue;
        try { const b64 = await mod.captureNodePng(node); if (b64) images.push({ id, base64: b64 }); } catch { /* skip */ }
      }
      await mod.exportLoanTapeCockpit(
        filteredTapes, clientName || 'Cliente', selected,
        { data, vintage, narrative, snapshot: snapFocus, focusPeriod: focusPoint.period, focusLabel: focusPoint.label },
        images, target,
      );
    } catch (e: any) {
      alert(`No se pudo exportar el Excel: ${e?.message || e}`);
    } finally {
      setExporting(false);
    }
  };

  const kpiDelta = (cur: number, prev: number | null, invert = false, fmt: (n: number) => string = n => n.toFixed(0)) => {
    if (prev === null || prev === undefined) return <span className="text-slate-400">—</span>;
    const d = cur - prev; const worse = invert ? d > 0 : d < 0;
    const col = Math.abs(d) < 1e-9 ? 'text-slate-400' : worse ? 'text-rose-600' : 'text-emerald-600';
    return <span className={col}>{d >= 0 ? '+' : ''}{fmt(d)}</span>;
  };

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="bg-white border border-slate-200 rounded-2xl p-4 space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <p className="text-xs font-black text-slate-700 uppercase tracking-widest">Vista consolidada · {clientName}</p>
          <button onClick={handleExcel} disabled={exporting} className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-500 text-white font-bold px-3 py-2 rounded-xl text-xs disabled:opacity-60">
            <FileSpreadsheet className="w-3.5 h-3.5" /> {exporting ? 'Exportando…' : 'Exportar análisis completo (Excel)'}
          </button>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] font-black uppercase tracking-wider text-slate-400">Períodos:</span>
          {data.periods.map((p, i) => (
            <button key={p} onClick={() => togglePeriod(p)} className={`text-[11px] font-bold px-2 py-1 rounded-lg border ${selSet.has(p) ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-500 border-slate-200 hover:bg-slate-50'}`}>
              {data.labels[i]}
            </button>
          ))}
          <span className="mx-1 h-4 w-px bg-slate-200" />
          {([['todo', 'Todo'], ['u3', 'Últimos 3'], ['trim', 'Trimestral'], ['y2026', '2026']] as const).map(([k, lbl]) => (
            <button key={k} onClick={() => preset(k)} className="text-[11px] font-bold px-2 py-1 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50">{lbl}</button>
          ))}
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <label className="flex items-center gap-1.5 text-xs font-bold text-slate-600">
            <input type="checkbox" checked={compare} onChange={e => setCompare(e.target.checked)} /> Comparar 2 meses
          </label>
          {compare ? (
            <>
              <select value={cmpA} onChange={e => setCmpA(e.target.value)} className="text-xs border border-slate-200 rounded-lg px-2 py-1">
                {data.periods.map((p, i) => <option key={p} value={p}>{data.labels[i]}</option>)}
              </select>
              <span className="text-slate-400 text-xs">vs</span>
              <select value={cmpB} onChange={e => setCmpB(e.target.value)} className="text-xs border border-slate-200 rounded-lg px-2 py-1">
                {data.periods.map((p, i) => <option key={p} value={p}>{data.labels[i]}</option>)}
              </select>
            </>
          ) : (
            <label className="flex items-center gap-1.5 text-xs font-bold text-slate-600">
              Mes foco:
              <select value={focus} onChange={e => setFocus(e.target.value)} className="text-xs border border-slate-200 rounded-lg px-2 py-1">
                {data.periods.map((p, i) => <option key={p} value={p}>{data.labels[i]}</option>)}
              </select>
            </label>
          )}
        </div>
        <div className="border-t border-slate-100 pt-3">
          <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
            <div>
              <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">Segmentación</p>
              <p className="text-xs font-semibold text-slate-500">{data.allRows.length.toLocaleString('es-MX')} registros filtrados · {money(data.series.at(-1)?.saldo || 0)} último saldo visible</p>
            </div>
            {activeFilterCount > 0 && (
              <button onClick={resetFilters} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-black text-slate-600 hover:bg-slate-50">
                <RotateCcw className="h-3.5 w-3.5" />
                Limpiar filtros ({activeFilterCount})
              </button>
            )}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-6 gap-2">
            <Slicer label="Producto" value={filters.product} options={filterOptions.product} onChange={v => updateFilter('product', v)} />
            <Slicer label="Estatus" value={filters.status} options={filterOptions.status} onChange={v => updateFilter('status', v)} />
            <Slicer label="Bucket DPD" value={filters.dpdBucket} options={filterOptions.dpdBucket} onChange={v => updateFilter('dpdBucket', v)} />
            <Slicer label="Sector" value={filters.sector} options={filterOptions.sector} onChange={v => updateFilter('sector', v)} />
            <Slicer label="Acreditado" value={filters.borrower} options={filterOptions.borrower} onChange={v => updateFilter('borrower', v)} />
            <label className="min-w-0">
              <span className="mb-1 block text-[10px] font-black uppercase tracking-wider text-slate-400">Buscar</span>
              <span className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2 py-1.5 focus-within:border-indigo-300">
                <Search className="h-3.5 w-3.5 text-slate-400" />
                <input
                  value={filters.query}
                  onChange={e => updateFilter('query', e.target.value)}
                  placeholder="crédito, cliente..."
                  className="min-w-0 flex-1 bg-transparent text-xs font-semibold text-slate-700 outline-none placeholder:text-slate-400"
                />
              </span>
            </label>
          </div>
        </div>
      </div>

      {!data.periods.length && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6">
          <p className="text-sm font-black text-amber-900">Los filtros actuales no dejan cartera visible.</p>
          <p className="mt-1 text-xs font-semibold text-amber-700">Limpia algún slicer para volver a ver métricas, gráficas y tablas.</p>
        </div>
      )}

      {/* KPI strip (focus) */}
      {!compare && data.periods.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
          {[
            { k: 'Saldo', v: moneyM(focusPoint.saldo), d: kpiDelta(focusPoint.saldo, prevPoint?.saldo ?? null, false, n => moneyM(n)) },
            { k: 'Vencida >90d', v: pctS(focusPoint.venPct), d: kpiDelta(focusPoint.venPct, prevPoint?.venPct ?? null, true, n => `${(n * 100).toFixed(1)}pp`) },
            { k: 'Atrasada 1-90d', v: pctS(focusPoint.atrPct), d: kpiDelta(focusPoint.atrPct, prevPoint?.atrPct ?? null, true, n => `${(n * 100).toFixed(1)}pp`) },
            { k: 'Créditos', v: `${focusPoint.creditos}`, d: kpiDelta(focusPoint.creditos, prevPoint?.creditos ?? null) },
            { k: 'Concentración Top-1', v: pctS(focusPoint.top1), d: kpiDelta(focusPoint.top1, prevPoint?.top1 ?? null, true, n => `${(n * 100).toFixed(1)}pp`) },
            { k: 'HHI', v: focusPoint.hhi.toFixed(3), d: kpiDelta(focusPoint.hhi, prevPoint?.hhi ?? null, true, n => n.toFixed(3)) },
          ].map(t => (
            <div key={t.k} className="bg-white border border-slate-200 rounded-xl p-3">
              <p className="text-[10px] font-black uppercase tracking-wider text-slate-500">{t.k}</p>
              <p className="text-lg font-black text-slate-900 mt-0.5">{t.v}</p>
              <p className="text-[11px] font-bold mt-0.5">{t.d}</p>
            </div>
          ))}
        </div>
      )}

      {/* Narrative */}
      {data.periods.length > 0 && <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4">
        <p className="text-xs font-black text-slate-700 uppercase tracking-widest mb-2">Lectura cuantitativa</p>
        <ul className="space-y-1">
          {narrative.map((line, i) => <li key={i} className="text-sm text-slate-700 leading-relaxed flex gap-2"><span className="text-indigo-400">·</span>{line}</li>)}
        </ul>
      </div>}

      {/* Evolution */}
      {data.periods.length > 0 && <ChartCard title="Evolución de saldo & cartera vencida (>90d)" subtitle="Barras = saldo · línea = % vencida" fileName={`Evolucion_${clientName}`} captureId="evo" registerNode={registerNode} legend={[{ label: 'Saldo', color: C.indigo }, { label: 'Vencida %', color: C.red }]}>
        <div style={{ height: 260 }}>
          <ResponsiveContainer>
            <ComposedChart data={evoData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} />
              <YAxis yAxisId="l" tickFormatter={v => `$${(v / 1e6).toFixed(0)}M`} tick={{ fontSize: 11 }} />
              <YAxis yAxisId="r" orientation="right" tickFormatter={v => `${v}%`} tick={{ fontSize: 11 }} />
              <Tooltip formatter={(v: any, n: any) => n === 'saldo' ? money(v) : `${v}%`} />
              <Bar yAxisId="l" dataKey="saldo" fill={C.indigo} radius={[3, 3, 0, 0]} name="Saldo" />
              <Line yAxisId="r" dataKey="venPct" stroke={C.red} strokeWidth={2.4} dot={{ r: 3 }} name="Vencida %" />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </ChartCard>}

      {data.periods.length > 0 && <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {/* Quality migration */}
        <ChartCard title="Migración de calidad de cartera" subtitle="% del saldo por estatus, por corte" fileName={`Calidad_${clientName}`} captureId="calidad" registerNode={registerNode} legend={[{ label: 'Vigente', color: C.green }, { label: 'Atrasada', color: C.amber }, { label: 'Vencida', color: C.red }]}>
          <div style={{ height: 240 }}>
            <ResponsiveContainer>
              <BarChart data={qualData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }} stackOffset="expand">
                <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis tickFormatter={v => `${(v * 100).toFixed(0)}%`} tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v: any) => `${v}%`} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="Vigente" stackId="q" fill={C.green} />
                <Bar dataKey="Atrasada" stackId="q" fill={C.amber} />
                <Bar dataKey="Vencida" stackId="q" fill={C.red} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </ChartCard>

        {/* DPD heatmap */}
        <ChartCard title="Mapa de calor — Distribución DPD" subtitle="Intensidad = % del saldo en cada bucket" fileName={`DPD_${clientName}`} captureId="dpd" registerNode={registerNode}>
          <div className="overflow-x-auto">
            <div className="grid gap-1" style={{ gridTemplateColumns: `64px repeat(${sel.length}, minmax(28px,1fr))`, minWidth: sel.length * 30 + 64 }}>
              <div />
              {sel.map(s => <div key={s.period} className="text-[9px] text-slate-400 font-bold text-center self-end">{s.label}</div>)}
              {DPD_BUCKETS.map((b, bi) => (
                <React.Fragment key={b}>
                  <div className="text-[10px] text-slate-500 font-bold flex items-center">{b}</div>
                  {sel.map(s => {
                    const p = s.dpdPct[bi] || 0; const danger = bi >= 4; const base = danger ? '244,63,94' : bi >= 2 ? '245,158,11' : '5,150,105';
                    const a = Math.min(1, p * (danger ? 9 : 4) + 0.06);
                    return <div key={s.period} title={`${s.label} · ${b} · ${pctS(p)}`} className="h-6 rounded flex items-center justify-center text-[9px] font-black" style={{ background: `rgba(${base},${a})`, color: a > 0.5 ? '#fff' : '#94a3b8' }}>{p > 0.04 ? (p * 100).toFixed(0) : ''}</div>;
                  })}
                </React.Fragment>
              ))}
            </div>
          </div>
        </ChartCard>

        {/* Concentration cumulative at focus */}
        <ChartCard title={`Concentración acumulada — ${focusPoint.label}`} subtitle="% del portafolio por Top-N clientes" fileName={`Concentracion_${clientName}`} captureId="conc" registerNode={registerNode}>
          <div style={{ height: 240 }}>
            <ResponsiveContainer>
              <BarChart data={concData} layout="vertical" margin={{ top: 8, right: 40, left: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
                <XAxis type="number" tickFormatter={v => `${v}%`} tick={{ fontSize: 11 }} />
                <YAxis type="category" dataKey="n" tick={{ fontSize: 11 }} width={48} />
                <Tooltip formatter={(v: any) => `${v}%`} />
                <Bar dataKey="pct" radius={[0, 4, 4, 0]} name="% portafolio">
                  {concData.map((d, i) => <Cell key={i} fill={d.pct > 50 ? C.red : d.pct > 30 ? C.amber : C.indigo} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </ChartCard>

        {/* HHI over time */}
        <ChartCard title="HHI & Top-1 en el tiempo" subtitle="Índice Herfindahl (0-1) y concentración del cliente #1" fileName={`HHI_${clientName}`} captureId="hhi" registerNode={registerNode} legend={[{ label: 'HHI', color: C.indigo }, { label: 'Top-1 %', color: C.cyan }]}>
          <div style={{ height: 240 }}>
            <ResponsiveContainer>
              <ComposedChart data={hhiData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis yAxisId="l" tick={{ fontSize: 11 }} />
                <YAxis yAxisId="r" orientation="right" tickFormatter={v => `${v}%`} tick={{ fontSize: 11 }} />
                <Tooltip />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Line yAxisId="l" dataKey="HHI" stroke={C.indigo} strokeWidth={2.2} dot={{ r: 2 }} />
                <Line yAxisId="r" dataKey="Top1" stroke={C.cyan} strokeWidth={2.2} dot={{ r: 2 }} name="Top-1 %" />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </ChartCard>

        {/* Roll rate */}
        <ChartCard title="Roll-rate — deterioro vs. cura" subtitle="Créditos que empeoran (↑) vs. que se curan (↓) por corte" fileName={`RollRate_${clientName}`} captureId="roll" registerNode={registerNode} legend={[{ label: 'Deteriorados', color: C.red }, { label: 'Curados', color: C.green }]}>
          <div style={{ height: 240 }}>
            <ResponsiveContainer>
              <BarChart data={rollData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }} stackOffset="sign">
                <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v: any) => Math.abs(v)} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="Deteriorados" fill={C.red} stackId="s" radius={[3, 3, 0, 0]} />
                <Bar dataKey="Curados" fill={C.green} stackId="s" radius={[0, 0, 3, 3]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </ChartCard>

        {/* Client trends */}
        <ChartCard title="Tendencia de clientes principales" subtitle="Saldo (MXN M) por corte · top 5" fileName={`Clientes_${clientName}`} captureId="clientes" registerNode={registerNode} legend={data.topClients.map((c, i) => ({ label: c.length > 16 ? c.slice(0, 16) + '…' : c, color: CLIENT_COLORS[i % CLIENT_COLORS.length] }))}>
          <div style={{ height: 240 }}>
            <ResponsiveContainer>
              <LineChart data={cliData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis tickFormatter={v => `$${v}M`} tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v: any) => `$${v}M`} />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                {data.topClients.map((c, i) => <Line key={c} dataKey={c} stroke={CLIENT_COLORS[i % CLIENT_COLORS.length]} strokeWidth={2} dot={false} connectNulls name={c.length > 16 ? c.slice(0, 16) + '…' : c} />)}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </ChartCard>
      </div>}

      {/* Vintage */}
      {data.periods.length > 0 && <ChartCard title={`Cosecha por año de originación — ${focusPoint.label}`} subtitle="Saldo (MXN M) por cohorte, coloreado por calidad" fileName={`Cosecha_${clientName}`} captureId="cosecha" registerNode={registerNode} legend={[{ label: 'Vigente', color: C.green }, { label: 'Atrasada', color: C.amber }, { label: 'Vencida', color: C.red }]}>
        <div style={{ height: 260 }}>
          <ResponsiveContainer>
            <BarChart data={vintData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
              <XAxis dataKey="cohort" tick={{ fontSize: 11 }} />
              <YAxis tickFormatter={v => `$${v}M`} tick={{ fontSize: 11 }} />
              <Tooltip formatter={(v: any) => `$${v}M`} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="Vigente" stackId="v" fill={C.green} />
              <Bar dataKey="Atrasada" stackId="v" fill={C.amber} />
              <Bar dataKey="Vencida" stackId="v" fill={C.red} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </ChartCard>}

      {/* Watchlist */}
      {data.periods.length > 0 && <ChartCard title="Watchlist — vencidos crónicos" subtitle="Créditos con >90 días de atraso en 2+ cortes" fileName={`Watchlist_${clientName}`} captureId="watchlist" registerNode={registerNode}>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead><tr className="bg-slate-50 text-left">
              {['Crédito', 'Cliente', 'Cortes vencido', 'Máx DPD', 'Saldo actual'].map(h => <th key={h} className="px-3 py-2 font-black text-slate-600 uppercase tracking-wider">{h}</th>)}
            </tr></thead>
            <tbody>
              {data.watchlist.length === 0 && <tr><td colSpan={5} className="px-3 py-6 text-center text-slate-400 font-semibold">Sin vencidos recurrentes.</td></tr>}
              {data.watchlist.map(w => (
                <tr key={w.loan_id} className="border-t border-slate-100">
                  <td className="px-3 py-1.5 font-bold text-slate-700">{w.loan_id}</td>
                  <td className="px-3 py-1.5 text-slate-600">{w.client}</td>
                  <td className="px-3 py-1.5"><span className={`text-[10px] font-black px-2 py-0.5 rounded-full ${w.monthsOverdue >= Math.max(3, sel.length - 2) ? 'bg-rose-50 text-rose-700' : 'bg-amber-50 text-amber-700'}`}>{w.monthsOverdue}</span></td>
                  <td className={`px-3 py-1.5 text-right font-bold ${w.maxDpd > 365 ? 'text-rose-600' : 'text-amber-600'}`}>{w.maxDpd}</td>
                  <td className="px-3 py-1.5 text-right font-semibold text-slate-700">{money(w.saldoActual)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ChartCard>}

      {/* Snapshot skill tables */}
      {data.periods.length > 0 && (compare ? (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <SnapshotColumn label={periodLabel(cmpA)} snap={snapA} quality={cmpA ? periodQuality(data, cmpA) : null} />
          <SnapshotColumn label={periodLabel(cmpB)} snap={snapB} quality={cmpB ? periodQuality(data, cmpB) : null} />
        </div>
      ) : (
        <SnapshotColumn label={focusPoint.label} snap={snapFocus} quality={periodQuality(data, focusPoint.period)} />
      ))}
    </div>
  );
}

function Slicer({ label, value, options, onChange }: { label: string; value: string; options: Array<{ value: string; label: string; meta?: { balance: number; count: number } }>; onChange: (value: string) => void }) {
  return (
    <label className="min-w-0">
      <span className="mb-1 block text-[10px] font-black uppercase tracking-wider text-slate-400">{label}</span>
      <select value={value} onChange={e => onChange(e.target.value)} className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs font-bold text-slate-700 outline-none focus:border-indigo-300">
        <option value="">Todo</option>
        {options.map(option => (
          <option key={option.value} value={option.value}>
            {option.label}{option.meta ? ` · ${option.meta.count}` : ''}
          </option>
        ))}
      </select>
    </label>
  );
}

function SnapshotColumn({ label, snap, quality }: { label: string; snap: any; quality: any }) {
  if (!snap) return null;
  const q = quality || snap.portfolioQuality || {};
  const byClient = (snap.concentrations?.by_client || []).slice(0, 8);
  const byType = (snap.concentrations?.by_loan_type || []).slice(0, 6);
  const det = (snap.anomalies?.dpd_deterioration || []).slice(0, 8);
  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-5 space-y-4">
      <p className="text-xs font-black text-slate-700 uppercase tracking-widest">Análisis del corte — {label}</p>
      <div className="grid grid-cols-3 gap-2">
        {['vigente', 'atrasada', 'vencida'].map(k => (
          <div key={k} className="border border-slate-200 rounded-xl p-3">
            <p className="text-[10px] font-black uppercase tracking-wider text-slate-500">{k}</p>
            <p className="text-sm font-black text-slate-900 mt-0.5">{money(q[k]?.balance || 0)}</p>
            <p className="text-[11px] text-slate-500 font-semibold">{q[k]?.count || 0} · {pctS(q[k]?.pct || 0)}</p>
          </div>
        ))}
      </div>
      <MiniTable title="Concentración por cliente (Top 8)" rows={byClient} cols={[['name', 'Cliente'], ['count', 'Créd.'], ['balance', 'Saldo', money], ['pct', '%', pctS]]} />
      <MiniTable title="Por producto" rows={byType} cols={[['name', 'Producto'], ['count', 'Créd.'], ['balance', 'Saldo', money], ['pct', '%', pctS]]} />
      <MiniTable title="Deterioro DPD (mes vs. mes previo)" rows={det} cols={[['loan_id', 'Crédito'], ['days_overdue_prev', 'DPD ant.'], ['days_overdue_latest', 'DPD act.']]} />
    </div>
  );
}

function MiniTable({ title, rows, cols }: { title: string; rows: any[]; cols: Array<[string, string, ((v: any) => string)?]> }) {
  if (!rows?.length) return <div><p className="text-[11px] font-black uppercase tracking-wider text-slate-500 mb-1">{title}</p><p className="text-xs text-slate-400">Sin datos.</p></div>;
  return (
    <div>
      <p className="text-[11px] font-black uppercase tracking-wider text-slate-500 mb-1">{title}</p>
      <div className="overflow-x-auto">
        <table className="w-full text-[11px]">
          <thead><tr className="bg-slate-50 text-left">{cols.map(c => <th key={c[0]} className="px-2 py-1 font-black text-slate-500 uppercase">{c[1]}</th>)}</tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-slate-100">
                {cols.map(c => <td key={c[0]} className="px-2 py-1 text-slate-700">{c[2] ? c[2](r[c[0]]) : String(r[c[0]] ?? '—')}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
