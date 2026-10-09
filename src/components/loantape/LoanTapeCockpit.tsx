import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ResponsiveContainer, ComposedChart, BarChart, LineChart,
  Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, Cell,
} from 'recharts';
import { CalendarRange, FileSpreadsheet, LayoutDashboard } from 'lucide-react';
import { db, LoanTape_DB } from '../../db/index';
import {
  buildCockpitData, buildVintage, snapshotAnalysis, buildCockpitNarrative,
  periodLabel, periodQuality, DPD_BUCKETS, type CockpitData,
} from '../../lib/loanTapeCockpit';
import { loadExportModule } from '../../lib/exportLoader';
import { reserveDownloadTarget } from '../../lib/browserDownload';
import { analyzePortfolio, buildLoanTapeInsights, type Insight } from '../../lib/loanTapeReport';
import { liveLoansDetail, QUALITY_RULES } from '../../lib/portfolioRules';
import ChartCard from './ChartCard';
import LoanTapePortfolioCharts from './LoanTapePortfolioCharts';

const C = { green: '#059669', amber: '#f59e0b', red: '#ef4444', indigo: '#4f46e5', cyan: '#06b6d4', slate: '#94a3b8' };
const CLIENT_COLORS = ['#4f46e5', '#06b6d4', '#059669', '#f59e0b', '#ef4444'];
const money = (v: number) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }).format(v || 0);
const moneyM = (v: number) => `${new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 1 }).format((v || 0) / 1e6)} M`;
const moneyMillions = (v: number) => `${new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 1 }).format(v || 0)} M`;
const pctS = (v: number) => `${((v || 0) * 100).toLocaleString('es-MX', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
const pctPoint = (v: number) => `${(Number(v) || 0).toLocaleString('es-MX', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
const intS = (v: number) => new Intl.NumberFormat('es-MX', { maximumFractionDigits: 0 }).format(Math.abs(Number(v) || 0));
const tooltipStyle = { borderRadius: 12, borderColor: '#e2e8f0', boxShadow: '0 12px 30px rgba(15, 23, 42, 0.10)' };

interface Props { tapes: LoanTape_DB[]; clientName?: string; }

export default function LoanTapeCockpit({ tapes, clientName }: Props) {
  const data: CockpitData = useMemo(() => buildCockpitData(tapes), [tapes]);
  const periodsKey = data.periods.join('|');

  const [selected, setSelected] = useState<string[]>(data.periods);
  const [compare, setCompare] = useState(false);
  const [focus, setFocus] = useState<string>(data.periods[data.periods.length - 1] || '');
  const [cmpA, setCmpA] = useState<string>(data.periods[data.periods.length - 2] || '');
  const [cmpB, setCmpB] = useState<string>(data.periods[data.periods.length - 1] || '');
  const [rangeStart, setRangeStart] = useState<string>(data.periods[0] || '');
  const [rangeEnd, setRangeEnd] = useState<string>(data.periods[data.periods.length - 1] || '');
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    setSelected(data.periods);
    setFocus(data.periods[data.periods.length - 1] || '');
    setCmpA(data.periods[data.periods.length - 2] || '');
    setCmpB(data.periods[data.periods.length - 1] || '');
    setRangeStart(data.periods[0] || '');
    setRangeEnd(data.periods[data.periods.length - 1] || '');
  }, [periodsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const nodesRef = useRef<Record<string, HTMLElement | null>>({});
  const registerNode = useCallback((id: string, node: HTMLElement | null) => { nodesRef.current[id] = node; }, []);

  if (!data.periods.length) {
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
  const focusPoint = data.series.find(s => s.period === focus) || sel[sel.length - 1] || data.series[data.series.length - 1];
  const focusIdxInSel = sel.findIndex(s => s.period === focusPoint.period);
  const prevPoint = focusIdxInSel > 0 ? sel[focusIdxInSel - 1] : null;
  const availableYears = Array.from(new Set(data.periods.map(p => p.slice(0, 4)))).sort();
  const selectedPeriodsText = selected.length === data.periods.length
    ? 'Todos los cortes'
    : selected.length === 1
      ? `Corte ${periodLabel(selected[0])}`
      : `${selected.length} cortes seleccionados`;

  const clearPeriodFilter = () => {
    setSelected(data.periods);
    setFocus(data.periods[data.periods.length - 1] || '');
    setRangeStart(data.periods[0] || '');
    setRangeEnd(data.periods[data.periods.length - 1] || '');
  };
  const togglePeriod = (p: string) => setSelected(prev => {
    if (prev.length === 1 && prev[0] === p) return data.periods;
    const next = prev.includes(p) ? prev.filter(x => x !== p) : [...prev, p].sort();
    const kept = next.length ? next : data.periods;
    // El foco (portada, concentraciones, calidad del reporte) es SIEMPRE el corte más reciente de la selección,
    // no el último botón presionado: seleccionar jun/jul/ago debe reportar agosto. "Mes foco" permite cambiarlo a mano.
    setFocus(kept[kept.length - 1]);
    return kept;
  });
  const isolatePeriod = (period: string) => {
    if (selected.length === 1 && selected[0] === period) {
      clearPeriodFilter();
      return;
    }
    setSelected([period]);
    setFocus(period);
    setRangeStart(period);
    setRangeEnd(period);
  };
  const chartPeriod = (event: any): string | undefined => (
    event?.activePayload?.[0]?.payload?.period
    || event?.payload?.period
    || event?.period
    || data.periods.find((p, index) => data.labels[index] === (event?.activeLabel || event?.payload?.label || event?.label))
  );
  const isolatePeriodFromChart = (event: any) => {
    const period = chartPeriod(event);
    if (period) isolatePeriod(period);
  };
  const setSelection = (periods: string[]) => {
    const next = periods.length ? periods : data.periods;
    setSelected(next);
    setFocus(next[next.length - 1] || '');
    setRangeStart(next[0] || '');
    setRangeEnd(next[next.length - 1] || '');
  };
  const preset = (which: 'todo' | 'u3' | 'trim') => {
    if (which === 'todo') return clearPeriodFilter();
    if (which === 'u3') return setSelection(data.periods.slice(-3));
    // trimestral: one period per quarter (last of each)
    const byQ = new Map<string, string>();
    for (const p of data.periods) { const q = `${p.slice(0, 4)}Q${Math.ceil((+p.slice(5, 7)) / 3)}`; byQ.set(q, p); }
    setSelection([...byQ.values()].sort());
  };
  const presetYear = (year: string) => setSelection(data.periods.filter(p => p.startsWith(year)));
  const applyRange = (from: string, to: string) => {
    const [a, b] = from <= to ? [from, to] : [to, from];
    setRangeStart(a);
    setRangeEnd(b);
    setSelection(data.periods.filter(p => p >= a && p <= b));
  };

  // chart datasets
  const evoData = sel.map(s => ({ period: s.period, label: s.label, saldo: s.saldo, venPct: +(s.venPct * 100).toFixed(2) }));
  const qualData = sel.map(s => ({ period: s.period, label: s.label, Vigente: +s.vigPct.toFixed(4), Atrasada: +s.atrPct.toFixed(4), Vencida: +s.venPct.toFixed(4) }));
  const hhiData = sel.map(s => ({ period: s.period, label: s.label, HHI: +s.hhi.toFixed(3), Top1: +(s.top1 * 100).toFixed(1) }));
  const rollData = mig.map(m => ({ period: m.period, label: m.label, Deteriorados: m.deteriorated, Curados: -m.cured }));
  const concData = [
    { n: 'Top 1', pct: +(focusPoint.top1 * 100).toFixed(1) },
    { n: 'Top 3', pct: +(focusPoint.top3 * 100).toFixed(1) },
    { n: 'Top 5', pct: +(focusPoint.top5 * 100).toFixed(1) },
    { n: 'Top 10', pct: +(focusPoint.top10 * 100).toFixed(1) },
  ];
  const cliData = sel.map(s => {
    const idx = data.periods.indexOf(s.period);
    const row: any = { period: s.period, label: s.label };
    data.clientTrends.forEach(ct => { const v = ct.values[idx]; row[ct.client] = v != null ? +(v / 1e6).toFixed(2) : null; });
    return row;
  });
  const vintage = useMemo(() => buildVintage(data, focusPoint.period), [data, focusPoint.period]);
  const vintData = vintage.map(v => ({ cohort: v.cohort, Vigente: +(v.vig / 1e6).toFixed(2), Atrasada: +(v.atr / 1e6).toFixed(2), Vencida: +(v.ven / 1e6).toFixed(2), venPct: +(v.venPct * 100).toFixed(1) }));
  const narrative = useMemo(() => buildCockpitNarrative(data, selected), [data, selected]);
  const snapFocus = useMemo(() => snapshotAnalysis(tapes, focusPoint.period), [tapes, focusPoint.period]);
  const [groupOverrides, setGroupOverrides] = useState<Record<string, string>>({});
  const tapeClientId = tapes[0]?.clientId;
  useEffect(() => {
    if (!tapeClientId) return;
    let active = true;
    db.getClientSetting<Record<string, string>>(tapeClientId, 'loan_tape_group_overrides', {}).then(v => { if (active) setGroupOverrides(v || {}); });
    return () => { active = false; };
  }, [tapeClientId]);
  const separateMember = (memberName: string) => {
    const next = { ...groupOverrides, [memberName]: '' };
    setGroupOverrides(next);
    if (tapeClientId) void db.setClientSetting(tapeClientId, 'loan_tape_group_overrides', next);
  };
  const portfolio = useMemo(() => analyzePortfolio(data, focusPoint.period, groupOverrides), [data, focusPoint.period, groupOverrides]);
  const insights = useMemo(() => (portfolio ? buildLoanTapeInsights(portfolio, data, (snapFocus as any)?.anomalies) : []), [portfolio, data, snapFocus]);
  const insightGroups = useMemo(() => {
    const groups = new Map<string, Insight[]>();
    insights.forEach(i => { (groups.get(i.category) || groups.set(i.category, []).get(i.category)!).push(i); });
    return [...groups.entries()];
  }, [insights]);
  const snapA = useMemo(() => (compare && cmpA ? snapshotAnalysis(tapes, cmpA) : null), [tapes, compare, cmpA]);
  const snapB = useMemo(() => (compare && cmpB ? snapshotAnalysis(tapes, cmpB) : null), [tapes, compare, cmpB]);

  const handleExcel = async () => {
    setExporting(true);
    const target = reserveDownloadTarget();
    try {
      const mod: any = await loadExportModule();
      await mod.exportLoanTapeCockpit(
        tapes, clientName || 'Cliente', selected,
        { data, vintage, snapshot: snapFocus, focusPeriod: focusPoint.period, focusLabel: focusPoint.label, groupOverrides },
        target,
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
          {([['todo', 'Todo'], ['u3', 'Últimos 3'], ['trim', 'Trimestral']] as const).map(([k, lbl]) => (
            <button key={k} onClick={() => preset(k)} className="text-[11px] font-bold px-2 py-1 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50">{lbl}</button>
          ))}
          {availableYears.map(year => (
            <button key={year} onClick={() => presetYear(year)} className="text-[11px] font-bold px-2 py-1 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50">{year}</button>
          ))}
          {selected.length !== data.periods.length && (
            <div className="flex items-center gap-1.5 rounded-lg border border-indigo-100 bg-indigo-50 px-2 py-1">
              <span className="text-[11px] font-black text-indigo-700">Filtrado: {selectedPeriodsText}</span>
              <button onClick={clearPeriodFilter} className="text-[10px] font-black uppercase tracking-wide text-indigo-500 hover:text-indigo-800">
                Quitar filtro
              </button>
            </div>
          )}
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <label className="flex items-center gap-1.5 text-xs font-bold text-slate-600">
            <CalendarRange className="h-3.5 w-3.5 text-slate-400" />
            Desde:
            <select value={rangeStart} onChange={e => applyRange(e.target.value, rangeEnd || e.target.value)} className="text-xs border border-slate-200 rounded-lg px-2 py-1">
              {data.periods.map((p, i) => <option key={p} value={p}>{data.labels[i]}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-xs font-bold text-slate-600">
            Hasta:
            <select value={rangeEnd} onChange={e => applyRange(rangeStart || e.target.value, e.target.value)} className="text-xs border border-slate-200 rounded-lg px-2 py-1">
              {data.periods.map((p, i) => <option key={p} value={p}>{data.labels[i]}</option>)}
            </select>
          </label>
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
                {sel.map(s => <option key={s.period} value={s.period}>{s.label}</option>)}
              </select>
            </label>
          )}
        </div>
      </div>

      {/* KPI strip (focus) */}
      {!compare && (
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
          {[
            { k: 'Saldo', v: moneyM(focusPoint.saldo), d: kpiDelta(focusPoint.saldo, prevPoint?.saldo ?? null, false, n => moneyM(n)) },
            { k: `Vencida ${QUALITY_RULES.atrasadaMaxDpd + 1}+ días`, v: focusPoint.isSummary ? 'N/D' : pctS(focusPoint.venPct), d: focusPoint.isSummary ? <span className="text-slate-400">Resumen</span> : kpiDelta(focusPoint.venPct, prevPoint?.venPct ?? null, true, n => `${(n * 100).toFixed(1)}pp`) },
            { k: `Atrasada ${QUALITY_RULES.vigenteMaxDpd + 1}-${QUALITY_RULES.atrasadaMaxDpd} días`, v: focusPoint.isSummary ? 'N/D' : pctS(focusPoint.atrPct), d: focusPoint.isSummary ? <span className="text-slate-400">Resumen</span> : kpiDelta(focusPoint.atrPct, prevPoint?.atrPct ?? null, true, n => `${(n * 100).toFixed(1)}pp`) },
            { k: 'Créditos vivos', v: focusPoint.isSummary ? 'N/D' : `${focusPoint.creditos}`, d: focusPoint.isSummary ? <span className="text-slate-400">Resumen</span> : <span>{kpiDelta(focusPoint.creditos, prevPoint?.creditos ?? null)}{focusPoint.registros > focusPoint.creditos && <span className="block text-slate-400 font-semibold">{liveLoansDetail(focusPoint.registros, focusPoint.creditos)}</span>}</span> },
            { k: 'Concentración Top-1', v: focusPoint.isSummary ? 'N/D' : pctS(focusPoint.top1), d: focusPoint.isSummary ? <span className="text-slate-400">Resumen</span> : kpiDelta(focusPoint.top1, prevPoint?.top1 ?? null, true, n => `${(n * 100).toFixed(1)}pp`) },
            { k: 'HHI', v: focusPoint.isSummary ? 'N/D' : focusPoint.hhi.toFixed(3), d: focusPoint.isSummary ? <span className="text-slate-400">Resumen</span> : kpiDelta(focusPoint.hhi, prevPoint?.hhi ?? null, true, n => n.toFixed(3)) },
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
      <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4">
        <p className="text-xs font-black text-slate-700 uppercase tracking-widest mb-2">Lectura cuantitativa</p>
        <ul className="space-y-1">
          {narrative.map((line, i) => <li key={i} className="text-sm text-slate-700 leading-relaxed flex gap-2"><span className="text-indigo-400">·</span>{line}</li>)}
        </ul>
      </div>

      {/* Insights */}
      {insightGroups.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-2xl p-5">
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <p className="text-xs font-black text-slate-700 uppercase tracking-widest">Insights de cartera — {focusPoint.label}</p>
            <p className="text-[11px] font-semibold text-slate-400">{insights.length} hallazgos · {insights.filter(i => i.level === 'alert').length} alertas · {insights.filter(i => i.level === 'warn').length} por revisar</p>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-6 gap-y-4">
            {insightGroups.map(([cat, list]) => (
              <div key={cat}>
                <p className="text-[11px] font-black uppercase tracking-wider text-indigo-600 mb-1.5">{cat}</p>
                <ul className="space-y-1.5">
                  {list.map((i, idx) => (
                    <li key={idx} className="text-[13px] text-slate-700 leading-snug flex gap-2">
                      <span className={`mt-1.5 h-2 w-2 rounded-full shrink-0 ${i.level === 'alert' ? 'bg-rose-500' : i.level === 'warn' ? 'bg-amber-500' : i.level === 'good' ? 'bg-emerald-500' : 'bg-indigo-300'}`} />
                      <span>{i.text}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Gráficas del corte: calidad, concentraciones, buckets, tasas, plazos, originación */}
      {portfolio && !portfolio.isSummary && (
        <div className="space-y-2">
          <p className="text-xs font-black text-slate-700 uppercase tracking-widest px-1">Análisis de cartera — {focusPoint.label}</p>
          <LoanTapePortfolioCharts portfolio={portfolio} clientName={clientName || 'Cliente'} onSeparateMember={separateMember} />
        </div>
      )}

      {/* Evolution */}
      <ChartCard title="Evolución de saldo & cartera vencida (90+ días)" subtitle="Barras = saldo · línea = % vencida" fileName={`Evolucion_${clientName}`} captureId="evo" registerNode={registerNode} legend={[{ label: 'Saldo', color: C.indigo }, { label: 'Vencida %', color: C.red }]}>
        <div style={{ height: 260 }}>
          <ResponsiveContainer>
            <ComposedChart data={evoData} onClick={isolatePeriodFromChart} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} />
              <YAxis yAxisId="l" tickFormatter={v => moneyM(Number(v))} tick={{ fontSize: 11 }} width={78} />
              <YAxis yAxisId="r" orientation="right" tickFormatter={v => pctPoint(Number(v))} tick={{ fontSize: 11 }} width={58} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v: any, n: any) => n === 'saldo' ? money(Number(v)) : pctPoint(Number(v))} />
              <Bar yAxisId="l" dataKey="saldo" fill={C.indigo} radius={[3, 3, 0, 0]} name="Saldo" cursor="pointer" onClick={isolatePeriodFromChart} />
              <Line yAxisId="r" dataKey="venPct" stroke={C.red} strokeWidth={2.4} dot={{ r: 4, cursor: 'pointer' }} activeDot={{ r: 6, onClick: isolatePeriodFromChart }} name="Vencida %" />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </ChartCard>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {/* Quality migration */}
        <ChartCard title="Migración de calidad de cartera" subtitle="% del saldo por estatus, por corte" fileName={`Calidad_${clientName}`} captureId="calidad" registerNode={registerNode} legend={[{ label: 'Vigente', color: C.green }, { label: 'Atrasada', color: C.amber }, { label: 'Vencida', color: C.red }]}>
          <div style={{ height: 240 }}>
            <ResponsiveContainer>
              <BarChart data={qualData} onClick={isolatePeriodFromChart} margin={{ top: 8, right: 12, left: 0, bottom: 0 }} stackOffset="expand">
                <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis tickFormatter={v => pctS(Number(v))} tick={{ fontSize: 11 }} width={58} />
                <Tooltip contentStyle={tooltipStyle} formatter={(v: any) => pctS(Number(v))} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="Vigente" stackId="q" fill={C.green} cursor="pointer" onClick={isolatePeriodFromChart} />
                <Bar dataKey="Atrasada" stackId="q" fill={C.amber} cursor="pointer" onClick={isolatePeriodFromChart} />
                <Bar dataKey="Vencida" stackId="q" fill={C.red} cursor="pointer" onClick={isolatePeriodFromChart} />
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
                    return <button key={s.period} onClick={() => isolatePeriod(s.period)} title={`${s.label} · ${b} · ${pctS(p)}`} className="h-6 rounded flex items-center justify-center text-[9px] font-black" style={{ background: `rgba(${base},${a})`, color: a > 0.5 ? '#fff' : '#94a3b8' }}>{p > 0.04 ? (p * 100).toFixed(0) : ''}</button>;
                  })}
                </React.Fragment>
              ))}
            </div>
          </div>
        </ChartCard>

        {/* Concentration cumulative at focus */}
      <ChartCard title={`Concentración acumulada — ${focusPoint.label}`} subtitle="% del portafolio por Top-N clientes" fileName={`Concentracion_${clientName}`} captureId="conc" registerNode={registerNode}>
          {focusPoint.isSummary ? (
            <div className="flex h-60 items-center justify-center rounded-xl border border-slate-200 bg-slate-50 px-6 text-center">
              <p className="text-sm font-bold text-slate-500">Este corte es resumen agregado; no trae acreditados para calcular Top-N clientes.</p>
            </div>
          ) : <div style={{ height: 240 }}>
            <ResponsiveContainer>
              <BarChart data={concData} layout="vertical" margin={{ top: 8, right: 40, left: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
                <XAxis type="number" tickFormatter={v => pctPoint(Number(v))} tick={{ fontSize: 11 }} />
                <YAxis type="category" dataKey="n" tick={{ fontSize: 11 }} width={48} />
                <Tooltip contentStyle={tooltipStyle} formatter={(v: any) => pctPoint(Number(v))} />
                <Bar dataKey="pct" radius={[0, 4, 4, 0]} name="% portafolio">
                  {concData.map((d, i) => <Cell key={i} fill={d.pct > 50 ? C.red : d.pct > 30 ? C.amber : C.indigo} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>}
        </ChartCard>

        {/* HHI over time */}
        <ChartCard title="HHI & Top-1 en el tiempo" subtitle="Índice Herfindahl (0-1) y concentración del cliente #1" fileName={`HHI_${clientName}`} captureId="hhi" registerNode={registerNode} legend={[{ label: 'HHI', color: C.indigo }, { label: 'Top-1 %', color: C.cyan }]}>
          <div style={{ height: 240 }}>
            <ResponsiveContainer>
              <ComposedChart data={hhiData} onClick={isolatePeriodFromChart} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis yAxisId="l" tick={{ fontSize: 11 }} tickFormatter={v => Number(v).toLocaleString('es-MX', { maximumFractionDigits: 3 })} width={54} />
                <YAxis yAxisId="r" orientation="right" tickFormatter={v => pctPoint(Number(v))} tick={{ fontSize: 11 }} width={58} />
                <Tooltip contentStyle={tooltipStyle} formatter={(v: any, n: any) => n === 'Top-1 %' ? pctPoint(Number(v)) : Number(v).toLocaleString('es-MX', { maximumFractionDigits: 3 })} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Line yAxisId="l" dataKey="HHI" stroke={C.indigo} strokeWidth={2.2} dot={{ r: 4, cursor: 'pointer' }} activeDot={{ r: 6, onClick: isolatePeriodFromChart }} />
                <Line yAxisId="r" dataKey="Top1" stroke={C.cyan} strokeWidth={2.2} dot={{ r: 4, cursor: 'pointer' }} activeDot={{ r: 6, onClick: isolatePeriodFromChart }} name="Top-1 %" />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </ChartCard>

        {/* Roll rate */}
        <ChartCard title="Roll-rate — deterioro vs. cura" subtitle="Créditos que empeoran (↑) vs. que se curan (↓) por corte" fileName={`RollRate_${clientName}`} captureId="roll" registerNode={registerNode} legend={[{ label: 'Deteriorados', color: C.red }, { label: 'Curados', color: C.green }]}>
          <div style={{ height: 240 }}>
            <ResponsiveContainer>
              <BarChart data={rollData} onClick={isolatePeriodFromChart} margin={{ top: 8, right: 12, left: 0, bottom: 0 }} stackOffset="sign">
                <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={v => intS(Number(v))} width={44} />
                <Tooltip contentStyle={tooltipStyle} formatter={(v: any) => intS(Number(v))} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="Deteriorados" fill={C.red} stackId="s" radius={[3, 3, 0, 0]} cursor="pointer" onClick={isolatePeriodFromChart} />
                <Bar dataKey="Curados" fill={C.green} stackId="s" radius={[0, 0, 3, 3]} cursor="pointer" onClick={isolatePeriodFromChart} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </ChartCard>

        {/* Client trends */}
        <ChartCard title="Tendencia de clientes principales" subtitle="Saldo (MXN M) por corte · top 5" fileName={`Clientes_${clientName}`} captureId="clientes" registerNode={registerNode} legend={data.topClients.map((c, i) => ({ label: c.length > 16 ? c.slice(0, 16) + '…' : c, color: CLIENT_COLORS[i % CLIENT_COLORS.length] }))}>
          <div style={{ height: 240 }}>
            <ResponsiveContainer>
              <LineChart data={cliData} onClick={isolatePeriodFromChart} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis tickFormatter={v => moneyMillions(Number(v))} tick={{ fontSize: 11 }} width={72} />
                <Tooltip contentStyle={tooltipStyle} formatter={(v: any) => moneyMillions(Number(v))} />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                {data.topClients.map((c, i) => <Line key={c} dataKey={c} stroke={CLIENT_COLORS[i % CLIENT_COLORS.length]} strokeWidth={2} dot={{ r: 3, cursor: 'pointer' }} activeDot={{ r: 5, onClick: isolatePeriodFromChart }} connectNulls name={c.length > 16 ? c.slice(0, 16) + '…' : c} />)}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </ChartCard>
      </div>

      {/* Vintage */}
      <ChartCard title={`Cosecha por año de originación — ${focusPoint.label}`} subtitle="Saldo (MXN M) por cohorte, coloreado por calidad" fileName={`Cosecha_${clientName}`} captureId="cosecha" registerNode={registerNode} legend={[{ label: 'Vigente', color: C.green }, { label: 'Atrasada', color: C.amber }, { label: 'Vencida', color: C.red }]}>
        <div style={{ height: 260 }}>
          <ResponsiveContainer>
            <BarChart data={vintData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
              <XAxis dataKey="cohort" tick={{ fontSize: 11 }} />
              <YAxis tickFormatter={v => moneyMillions(Number(v))} tick={{ fontSize: 11 }} width={72} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v: any) => moneyMillions(Number(v))} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="Vigente" stackId="v" fill={C.green} />
              <Bar dataKey="Atrasada" stackId="v" fill={C.amber} />
              <Bar dataKey="Vencida" stackId="v" fill={C.red} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </ChartCard>

      {/* Watchlist */}
      <ChartCard title="⚠ Watchlist — vencidos crónicos" subtitle="Créditos con 90+ días de atraso en 2+ cortes" fileName={`Watchlist_${clientName}`} captureId="watchlist" registerNode={registerNode}>
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
      </ChartCard>

      {/* Snapshot skill tables */}
      {compare ? (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <SnapshotColumn label={periodLabel(cmpA)} snap={snapA} quality={cmpA ? periodQuality(data, cmpA) : null} />
          <SnapshotColumn label={periodLabel(cmpB)} snap={snapB} quality={cmpB ? periodQuality(data, cmpB) : null} />
        </div>
      ) : (
        <SnapshotColumn label={focusPoint.label} snap={snapFocus} quality={periodQuality(data, focusPoint.period)} />
      )}
    </div>
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
