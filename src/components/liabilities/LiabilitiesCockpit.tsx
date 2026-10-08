import React, { useMemo } from 'react';
import {
  ResponsiveContainer, ComposedChart, BarChart, PieChart, Pie,
  Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, Cell, ReferenceLine,
} from 'recharts';
import type { InstitutionalLiability_DB } from '../../db/index';
import type { LiabilitiesAnalysis, LiabilityInsight } from '../../lib/institutionalLiabilitiesAnalytics';
import type { AssetLiabilityAnalysis } from '../../lib/assetLiabilityAnalysis';
import ChartCard from '../loantape/ChartCard';

const C = { green: '#059669', amber: '#f59e0b', red: '#ef4444', indigo: '#4f46e5', cyan: '#06b6d4', slate: '#94a3b8', lime: '#84cc16' };
const SERIES = ['#4f46e5', '#06b6d4', '#059669', '#f59e0b', '#ef4444', '#64748b', '#8b5cf6', '#14b8a6'];
const moneyM = (v: number) => `${new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 1 }).format((v || 0) / 1e6)} M`;
const pctS = (v: number | null) => (v === null || !Number.isFinite(v) ? 'N/D' : `${(v * 100).toLocaleString('es-MX', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`);
const pct2 = (v: number | null) => (v === null || !Number.isFinite(v) ? 'N/D' : `${(v * 100).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`);
const xS = (v: number | null) => (v === null || !Number.isFinite(v) ? 'N/D' : `${v.toFixed(2)}x`);
const tooltipStyle = { borderRadius: 12, borderColor: '#e2e8f0', boxShadow: '0 12px 30px rgba(15, 23, 42, 0.10)' };
const axisM = (v: number) => `${(v / 1e6).toLocaleString('es-MX', { maximumFractionDigits: 0 })}M`;

interface Props {
  liabilities: InstitutionalLiability_DB[];
  analysis: LiabilitiesAnalysis;
  insights: LiabilityInsight[];
  assetLiability: AssetLiabilityAnalysis | null;
  clientName: string;
}

export default function LiabilitiesCockpit({ analysis: a, insights, assetLiability: al, clientName }: Props) {
  const k = a.kpi;
  const sevTone = (v: number | null, warn: number, alert: number, higherIsBad = true) => {
    if (v === null) return 'text-slate-400';
    const bad = higherIsBad ? v >= alert : v <= alert;
    const meh = higherIsBad ? v >= warn : v <= warn;
    return bad ? 'text-rose-600' : meh ? 'text-amber-600' : 'text-emerald-600';
  };

  const kpis = [
    { k: 'Saldo pasivos', v: moneyM(k.totalBalance), d: <span className="text-slate-400">{k.facilities} facilities · {k.lenders} fondeadores</span> },
    { k: 'Tasa pasiva pond.', v: pct2(k.waRate), d: <span className="text-slate-400">Costo anual {moneyM(k.annualInterest)}</span> },
    { k: 'Utilización', v: pctS(k.utilization), d: <span className="text-slate-400">Disponible {moneyM(k.available)}</span> },
    { k: 'Vence ≤ 12m', v: pctS(k.due12mPct), d: <span className={sevTone(k.due12mPct, 0.25, 0.5)}>{moneyM(k.due12mBalance)}</span> },
    { k: 'Concentración Top-1', v: pctS(k.top1Pct), d: <span className={sevTone(k.top1Pct, 0.5, 0.7)}>HHI {k.hhi.toFixed(3)}</span> },
    { k: 'Plazo remanente', v: k.waRemainingMonths === null ? 'N/D' : `${k.waRemainingMonths.toFixed(1)} m`, d: k.overdueBalance > 0 ? <span className="text-rose-600">Vencido {moneyM(k.overdueBalance)}</span> : <span className="text-slate-400">Ponderado por saldo</span> },
  ];

  const insightGroups = useMemo(() => {
    const rows: Array<[string, LiabilityInsight[]]> = [];
    if (al?.insights.length) rows.push(['Activo vs. pasivo', al.insights]);
    if (insights.length) rows.push(['Estructura de fondeo', insights]);
    return rows;
  }, [al, insights]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        {kpis.map(t => (
          <div key={t.k} className="bg-white border border-slate-200 rounded-xl p-3">
            <p className="text-[10px] font-black uppercase tracking-wider text-slate-500">{t.k}</p>
            <p className="text-lg font-black text-slate-900 mt-0.5">{t.v}</p>
            <p className="text-[11px] font-bold mt-0.5">{t.d}</p>
          </div>
        ))}
      </div>

      {/* Activo vs pasivo */}
      {al ? (
        <div className="bg-white border border-slate-200 rounded-2xl p-5 space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <p className="text-xs font-black text-slate-700 uppercase tracking-widest">Activo vs. pasivo — cartera {al.portfolioLabel}</p>
            <p className="text-[11px] font-semibold text-slate-400">Cartera que cobra = vigente 0-30 DPD · cobranza {al.asset.collectionsSource === 'cuota' ? 'con cuota reportada' : al.asset.collectionsSource === 'mixta' ? 'cuota reportada + estimada' : 'estimada (capital lineal + interés)'}</p>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
            {[
              { k: 'Tasa activa', v: pct2(al.asset.waRate), d: 'Cartera vigente' },
              { k: 'Tasa pasiva', v: pct2(al.liability.waRate), d: 'Fondeo institucional' },
              { k: 'Spread', v: al.spread === null ? 'N/D' : `${(al.spread * 100).toFixed(2)} pp`, d: `Margen anual ${moneyM(al.annualMargin)}`, tone: sevTone(al.spread, 0.03, 0, false) },
              { k: 'Aforo vigente', v: xS(al.aforoVigente), d: `Vigente ${moneyM(al.asset.vigente)}`, tone: sevTone(al.aforoVigente, 1.2, 1, false) },
              { k: 'Cobranza / servicio', v: xS(al.serviceCoverage), d: `${moneyM(al.asset.monthlyCollections)} vs ${moneyM(al.liability.monthlyDebtService)} /mes`, tone: sevTone(al.serviceCoverage, 1.2, 1, false) },
              { k: 'Descalce de plazo', v: al.termGapMonths === null ? 'N/D' : `${al.termGapMonths > 0 ? '+' : ''}${al.termGapMonths.toFixed(1)} m`, d: 'Activo − pasivo', tone: sevTone(al.termGapMonths, 6, 12) },
            ].map(t => (
              <div key={t.k} className="bg-slate-50 border border-slate-200 rounded-xl p-3">
                <p className="text-[10px] font-black uppercase tracking-wider text-slate-500">{t.k}</p>
                <p className={`text-lg font-black mt-0.5 ${t.tone || 'text-slate-900'}`}>{t.v}</p>
                <p className="text-[11px] font-bold text-slate-400 mt-0.5">{t.d}</p>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <ChartCard title="Cobranza vs. servicio de deuda" subtitle="Por trimestre · barras = entradas de cartera y salidas a fondeadores · línea = flujo acumulado" fileName={`ALM_${clientName}`} legend={[{ label: 'Cobranza', color: C.green }, { label: 'Servicio deuda', color: C.red }, { label: 'Acumulado', color: C.indigo }]}>
              <ResponsiveContainer width="100%" height={260}>
                <ComposedChart data={al.quarters.map(q => ({ label: q.label, cobranza: q.assetPrincipal + q.assetInterest, servicio: -(q.liabilityPrincipal + q.liabilityInterest), acumulado: q.cumulative }))}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="label" fontSize={10} />
                  <YAxis fontSize={10} tickFormatter={axisM} width={50} />
                  <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => moneyM(Math.abs(v))} />
                  <ReferenceLine y={0} stroke="#94a3b8" />
                  <Bar dataKey="cobranza" name="Cobranza" fill={C.green} radius={[4, 4, 0, 0]} />
                  <Bar dataKey="servicio" name="Servicio deuda" fill={C.red} radius={[0, 0, 4, 4]} />
                  <Line dataKey="acumulado" name="Acumulado" stroke={C.indigo} strokeWidth={2} dot={{ r: 3 }} />
                </ComposedChart>
              </ResponsiveContainer>
            </ChartCard>
            <ChartCard title="Spread por fondeador" subtitle="Tasa activa ponderada − tasa de cada fondeador (rojo = fondeo más caro que la cartera)" fileName={`Spread_${clientName}`}>
              <ResponsiveContainer width="100%" height={Math.max(220, al.lenderSpreads.length * 30 + 40)}>
                <BarChart data={al.lenderSpreads.filter(l => l.spread !== null)} layout="vertical" margin={{ left: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                  <XAxis type="number" fontSize={10} tickFormatter={(v: number) => `${(v * 100).toFixed(0)}pp`} />
                  <YAxis type="category" dataKey="lender" fontSize={10} width={130} />
                  <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => `${(v * 100).toFixed(2)} pp`} />
                  <ReferenceLine x={0} stroke="#94a3b8" />
                  <Bar dataKey="spread" name="Spread" radius={[0, 4, 4, 0]}>
                    {al.lenderSpreads.filter(l => l.spread !== null).map((l, i) => <Cell key={i} fill={(l.spread as number) < 0 ? C.red : C.indigo} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
          </div>
        </div>
      ) : (
        <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 text-sm text-slate-500">
          Sube un loan tape del cliente para ver el cruce <span className="font-bold">activo vs. pasivo</span> (tasa activa vs. pasiva, aforo, cobranza vs. servicio de deuda y gap de liquidez).
        </div>
      )}

      {/* Insights */}
      {insightGroups.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-2xl p-5">
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <p className="text-xs font-black text-slate-700 uppercase tracking-widest">Insights de pasivos</p>
            <p className="text-[11px] font-semibold text-slate-400">
              {insightGroups.reduce((s, [, l]) => s + l.length, 0)} hallazgos · {insightGroups.reduce((s, [, l]) => s + l.filter(i => i.severity === 'critical').length, 0)} alertas
            </p>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-6 gap-y-4">
            {insightGroups.map(([cat, list]) => (
              <div key={cat}>
                <p className="text-[11px] font-black uppercase tracking-wider text-indigo-600 mb-1.5">{cat}</p>
                <ul className="space-y-1.5">
                  {list.map((i, idx) => (
                    <li key={idx} className="text-[13px] text-slate-700 leading-snug flex gap-2">
                      <span className={`mt-1.5 h-2 w-2 rounded-full shrink-0 ${i.severity === 'critical' ? 'bg-rose-500' : i.severity === 'warning' ? 'bg-amber-500' : 'bg-indigo-300'}`} />
                      <span><span className="font-bold">{i.title}.</span> {i.detail}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <ChartCard title="Concentración por fondeador" subtitle="Saldo (MXN M) · línea = % acumulado" fileName={`Fondeadores_${clientName}`} legend={[{ label: 'Saldo', color: C.indigo }, { label: '% acumulado', color: C.cyan }]}>
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart data={a.lenders.slice(0, 12)}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="lender" fontSize={10} interval={0} angle={-20} textAnchor="end" height={60} tickFormatter={(v: string) => (v.length > 14 ? v.slice(0, 14) + '…' : v)} />
              <YAxis yAxisId="l" fontSize={10} tickFormatter={axisM} width={50} />
              <YAxis yAxisId="r" orientation="right" fontSize={10} tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`} domain={[0, 1]} width={40} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v: number, n: string) => (n === '% acumulado' ? pctS(v) : moneyM(v))} />
              <Bar yAxisId="l" dataKey="currentBalance" name="Saldo" fill={C.indigo} radius={[4, 4, 0, 0]} />
              <Line yAxisId="r" dataKey="cumPct" name="% acumulado" stroke={C.cyan} strokeWidth={2} dot={{ r: 3 }} />
            </ComposedChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Mezcla por tipo de pasivo" subtitle="% del saldo" fileName={`Tipos_${clientName}`} legend={a.byType.map((b, i) => ({ label: b.label, color: SERIES[i % SERIES.length] }))}>
          <ResponsiveContainer width="100%" height={260}>
            <PieChart>
              <Pie data={a.byType} dataKey="currentBalance" nameKey="label" innerRadius={60} outerRadius={95} label={({ pctOfTotal }: any) => pctS(pctOfTotal)}>
                {a.byType.map((_, i) => <Cell key={i} fill={SERIES[i % SERIES.length]} />)}
              </Pie>
              <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => moneyM(v)} />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Calendario proyectado de amortización" subtitle="Capital a pagar por mes (36m) · línea = saldo remanente" fileName={`Calendario_${clientName}`} legend={[{ label: 'Capital', color: C.indigo }, { label: 'Saldo remanente', color: C.cyan }]}>
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart data={a.monthlySchedule}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" fontSize={9} interval={2} />
              <YAxis yAxisId="l" fontSize={10} tickFormatter={axisM} width={50} />
              <YAxis yAxisId="r" orientation="right" fontSize={10} tickFormatter={axisM} width={50} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => moneyM(v)} />
              <Bar yAxisId="l" dataKey="principal" name="Capital" fill={C.indigo} radius={[3, 3, 0, 0]} />
              <Line yAxisId="r" dataKey="endingBalance" name="Saldo remanente" stroke={C.cyan} strokeWidth={2} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
          {a.unscheduledBalance > 0 && <p className="text-[11px] text-amber-700 font-semibold mt-1">{moneyM(a.unscheduledBalance)} sin fecha de vencimiento no entran al calendario.</p>}
        </ChartCard>

        <ChartCard title="Plazo remanente" subtitle="Saldo por rango de meses al vencimiento" fileName={`Plazos_${clientName}`}>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={a.termBuckets}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" fontSize={10} />
              <YAxis fontSize={10} tickFormatter={axisM} width={50} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => moneyM(v)} />
              <Bar dataKey="currentBalance" name="Saldo" radius={[4, 4, 0, 0]}>
                {a.termBuckets.map((b, i) => <Cell key={i} fill={b.label === 'Vencida' ? C.red : b.label.startsWith('0') || b.label.startsWith('6') ? C.amber : b.label === 'Sin fecha' ? C.slate : C.indigo} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Tasa y costo por fondeador" subtitle="Barras = costo anual estimado · línea = tasa ponderada" fileName={`Costo_${clientName}`} legend={[{ label: 'Costo anual', color: C.indigo }, { label: 'Tasa', color: C.amber }]}>
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart data={a.lenders.slice(0, 12)}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="lender" fontSize={10} interval={0} angle={-20} textAnchor="end" height={60} tickFormatter={(v: string) => (v.length > 14 ? v.slice(0, 14) + '…' : v)} />
              <YAxis yAxisId="l" fontSize={10} tickFormatter={axisM} width={50} />
              <YAxis yAxisId="r" orientation="right" fontSize={10} tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`} width={40} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v: number, n: string) => (n === 'Tasa' ? pct2(v) : moneyM(v))} />
              <Bar yAxisId="l" dataKey="annualInterest" name="Costo anual" fill={C.indigo} radius={[4, 4, 0, 0]} />
              <Line yAxisId="r" dataKey="waRate" name="Tasa" stroke={C.amber} strokeWidth={2} dot={{ r: 3 }} />
            </ComposedChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Saldo por rango de tasa" subtitle="Distribución del fondeo por costo" fileName={`Tasas_${clientName}`}>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={a.rateBuckets}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" fontSize={10} />
              <YAxis fontSize={10} tickFormatter={axisM} width={50} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => moneyM(v)} />
              <Legend />
              <Bar dataKey="currentBalance" name="Saldo" fill={C.cyan} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {a.dataGaps.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4">
          <p className="text-xs font-black text-amber-900 uppercase tracking-widest mb-2">Calidad de datos — {a.dataGaps.length} facilities con faltantes</p>
          <ul className="grid grid-cols-1 md:grid-cols-2 gap-1">
            {a.dataGaps.slice(0, 12).map((g, i) => <li key={i} className="text-xs text-amber-900"><span className="font-bold">{g.lender}:</span> {g.missing.join(', ')}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}
