import React from 'react';
import {
  ResponsiveContainer, ComposedChart, BarChart, PieChart, Pie, Bar, Line, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import type { PortfolioAnalysis, Bucket } from '../../lib/loanTapeReport';
import { QUALITY_DEFINITION_LINES, reconcileQuality } from '../../lib/portfolioRules';
import ChartCard from './ChartCard';

// Axcess palette (same as the Excel report): brand blues + semantic quality colours.
const AX = { deep: '#1430E6', blue: '#1B5BF5', cyan: '#16B7EA', sky: '#8FB4FF', ink: '#0E1B3D', muted: '#5D6B8A', green: '#128A48', amber: '#E8A317', orange: '#EA6A1F', red: '#C2271C', darkRed: '#7F1D1D', grey: '#9AA5BD' };
const DPD_COLORS = [AX.green, '#7BC043', AX.amber, AX.orange, AX.red, AX.darkRed];
const QUALITY_COLORS = [AX.green, AX.amber, AX.red, AX.grey];
const tooltipStyle = { borderRadius: 12, borderColor: '#e2e8f0', boxShadow: '0 12px 30px rgba(15, 23, 42, 0.10)' };

const moneyCompact = (v: number) => `$${(Math.abs(v) / 1e6).toLocaleString('es-MX', { maximumFractionDigits: v >= 1e7 ? 0 : 1 })}M`;
const money = (v: number) => `$${Math.round(v || 0).toLocaleString('es-MX')}`;
const pct1 = (v: number) => `${((v || 0) * 100).toFixed(1)}%`;
const pct0 = (v: number) => `${Math.round((v || 0) * 100)}%`;
const compactMoney = (v: number) => (Math.abs(v) >= 1e6 ? `${(v / 1e6).toLocaleString('es-MX', { maximumFractionDigits: 1 })}M` : `${Math.round(v / 1e3).toLocaleString('es-MX')}K`);
const moneyRange = (lo: number, hi: number) => `$${compactMoney(lo)}–${compactMoney(hi)}`;
const pctRange = (lo: number, hi: number) => `${(lo * 100).toFixed(1)}–${(hi * 100).toFixed(1)}%`;
const termRange = (lo: number, hi: number) => `${Math.round(lo)}–${Math.round(hi)} m`;
// X axis that never overprints: thin out and tilt the labels when there are many categories.
const xAxisProps = (count: number) => ({ interval: (count > 8 ? 'preserveStartEnd' : 0) as 'preserveStartEnd' | 0, angle: count > 5 ? -30 : 0, textAnchor: (count > 5 ? 'end' : 'middle') as 'end' | 'middle', height: count > 5 ? 54 : 30, minTickGap: 12 });
const shorten = (s: string, n = 22) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

interface Props { portfolio: PortfolioAnalysis; clientName: string; onSeparateMember?: (memberName: string) => void }

export default function LoanTapePortfolioCharts({ portfolio: a, clientName, onSeparateMember }: Props) {
  const name = clientName || 'Cliente';
  const axis = { fontSize: 11, fill: AX.muted } as const;

  const qualityData = a.quality.filter(q => q.balance > 0).map(q => ({ name: q.label, value: q.balance, pct: q.pct }));
  const qualityColors = a.quality.filter(q => q.balance > 0).map(q => QUALITY_COLORS[a.quality.findIndex(x => x.key === q.key)]);
  const dpdData = a.dpd.map(d => ({ bucket: d.bucket, saldo: d.balance, pct: d.pct, creditos: d.count }));
  const clientData = a.clients.slice(0, 10).map(c => ({ name: shorten(c.name, 30), saldo: c.balance, pct: c.pct }));
  const topData = a.topN.map(t => ({ label: t.label, pct: t.pct }));

  const hbar = (data: Array<{ name: string; saldo: number; pct: number }>, color: string) => (
    <div style={{ height: Math.max(200, data.length * 26 + 40) }}>
      <ResponsiveContainer>
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 40, left: 8, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" horizontal={false} />
          <XAxis type="number" tick={axis} tickFormatter={moneyCompact} />
          <YAxis type="category" dataKey="name" width={170} tick={{ ...axis, fontSize: 10 }} interval={0} />
          <Tooltip formatter={(v: any, _n: any, item: any) => [`${money(Number(v))} · ${pct1(item.payload.pct)}`, 'Saldo']} contentStyle={tooltipStyle} />
          <Bar dataKey="saldo" fill={color} radius={[0, 6, 6, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );

  const bucketCombo = (data: Array<{ label: string; saldo: number; pct: number; count: number }>, color = AX.deep) => (
    <div style={{ height: 250 }}>
      <ResponsiveContainer>
        <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
          <XAxis dataKey="label" tick={{ ...axis, fontSize: 10 }} {...xAxisProps(data.length)} />
          <YAxis yAxisId="l" tick={axis} tickFormatter={moneyCompact} />
          <YAxis yAxisId="r" orientation="right" tick={axis} tickFormatter={pct0} />
          <Tooltip formatter={(v: any, n: any) => (n === '% saldo' ? pct1(Number(v)) : money(Number(v)))} contentStyle={tooltipStyle} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Bar yAxisId="l" dataKey="saldo" name="Saldo" fill={color} radius={[6, 6, 0, 0]} />
          <Line yAxisId="r" dataKey="pct" name="% saldo" stroke={AX.cyan} strokeWidth={2.5} dot={{ r: 3 }} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );

  const bucketRows = (list: Bucket[], fmt: (lo: number, hi: number) => string = moneyRange) => list.map(b => ({ label: fmt(b.lo, b.hi), saldo: b.balance, pct: b.pct, count: b.count }));
  const origCombo = (list: PortfolioAnalysis['originationMonthly']) => (
    <div style={{ height: 250 }}>
      <ResponsiveContainer>
        <ComposedChart data={list.map(p => ({ period: p.period, monto: p.amount, crec: p.growth }))} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
          <XAxis dataKey="period" tick={{ ...axis, fontSize: 10 }} {...xAxisProps(list.length)} />
          <YAxis yAxisId="l" tick={axis} tickFormatter={moneyCompact} />
          <YAxis yAxisId="r" orientation="right" tick={axis} tickFormatter={pct0} />
          <Tooltip formatter={(v: any, n: any) => (n === 'Crecimiento' ? pct1(Number(v)) : money(Number(v)))} contentStyle={tooltipStyle} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Bar yAxisId="l" dataKey="monto" name="Monto originado" fill={AX.deep} radius={[6, 6, 0, 0]} />
          <Line yAxisId="r" dataKey="crec" name="Crecimiento" stroke={AX.cyan} strokeWidth={2.5} dot={{ r: 3 }} connectNulls />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );

  const stacked = (rows: PortfolioAnalysis['products']) => (
    <div style={{ height: Math.max(180, rows.length * 34 + 60) }}>
      <ResponsiveContainer>
        <BarChart data={rows.map(r => ({ name: shorten(r.name, 24), Vigente: r.vigPct, Atrasada: r.atrPct, Vencida: r.venPct }))} layout="vertical" stackOffset="expand" margin={{ top: 4, right: 16, left: 8, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" horizontal={false} />
          <XAxis type="number" tick={axis} tickFormatter={pct0} />
          <YAxis type="category" dataKey="name" width={170} tick={{ ...axis, fontSize: 10 }} interval={0} />
          <Tooltip formatter={(v: any) => pct1(Number(v))} contentStyle={tooltipStyle} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Bar dataKey="Vigente" stackId="q" fill={AX.green} />
          <Bar dataKey="Atrasada" stackId="q" fill={AX.amber} />
          <Bar dataKey="Vencida" stackId="q" fill={AX.red} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );

  const rateProduct = a.products.filter(p => p.waRate !== null).map(p => ({ name: shorten(p.name, 22), tasa: p.waRate as number }));
  const rateQuality = a.rateByDpd.filter(r => r.waRate !== null && r.count > 0).map((r, i) => ({ name: r.label.split(' (')[0], tasa: r.waRate as number, color: [AX.green, AX.amber, AX.red][i] }));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 2xl:grid-cols-2 gap-4">
        <ChartCard title="Calidad de cartera" subtitle="% del saldo · vigente 0-30 · atrasada 31-89 · vencida 90+ DPD" fileName={`Calidad_${name}`}>
          <div style={{ height: 260 }}>
            <ResponsiveContainer>
              <PieChart>
                <Pie data={qualityData} dataKey="value" nameKey="name" innerRadius={62} outerRadius={96} paddingAngle={2} label={(e: any) => pct1(e.pct)}>
                  {qualityData.map((_, i) => <Cell key={i} fill={qualityColors[i]} />)}
                </Pie>
                <Tooltip formatter={(v: any, n: any, item: any) => [`${money(Number(v))} · ${pct1(item.payload.pct)}`, n]} contentStyle={tooltipStyle} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </ChartCard>

        <ChartCard title="Saldo por bucket DPD" subtitle="0 / 1-30 / 31-60 / 61-89 / 90-180 / >180 días" fileName={`DPD_buckets_${name}`}>
          <div style={{ height: 260 }}>
            <ResponsiveContainer>
              <BarChart data={dpdData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
                <XAxis dataKey="bucket" tick={axis} />
                <YAxis tick={axis} tickFormatter={moneyCompact} />
                <Tooltip formatter={(v: any, _n: any, item: any) => [`${money(Number(v))} · ${pct1(item.payload.pct)} · ${item.payload.creditos} créditos`, 'Saldo']} contentStyle={tooltipStyle} />
                <Bar dataKey="saldo" radius={[6, 6, 0, 0]}>{dpdData.map((_, i) => <Cell key={i} fill={DPD_COLORS[i]} />)}</Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </ChartCard>
      </div>

      <div className="bg-white border border-slate-200 rounded-2xl p-5">
        <p className="text-xs font-black text-slate-700 uppercase tracking-widest">Cómo se clasifica la cartera</p>
        <p className="text-xs text-slate-500 mt-0.5">La misma regla se usa en todo el sistema: dashboard, insights, score de riesgo y Excel.</p>
        <div className="mt-3 grid grid-cols-1 lg:grid-cols-2 gap-x-8 gap-y-3">
          <ul className="space-y-1.5">
            {QUALITY_DEFINITION_LINES.map((line, i) => <li key={i} className="text-[13px] text-slate-700 leading-snug flex gap-2"><span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-indigo-300 shrink-0" />{line}</li>)}
          </ul>
          <table className="w-full text-[12px] self-start">
            <thead><tr className="text-left text-slate-500"><th className="py-1 font-black uppercase text-[10px]">Puente</th><th className="py-1 font-black uppercase text-[10px] text-right">Saldo</th><th className="py-1 font-black uppercase text-[10px] text-right">%</th></tr></thead>
            <tbody>
              {reconcileQuality(a.rows).bridge.map(b => (
                <tr key={b.label} className="border-t border-slate-100"><td className="py-1 text-slate-700">{b.label}</td><td className="py-1 text-right font-mono text-slate-700">{moneyCompact(b.balance)}</td><td className="py-1 text-right font-mono font-bold text-slate-900">{pct1(b.pct)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid grid-cols-1 2xl:grid-cols-2 gap-4">
        {clientData.length > 0 && <ChartCard title="Concentración por cliente (Top 10)" subtitle="Saldo por acreditado" fileName={`Clientes_top10_${name}`}>{hbar(clientData, AX.deep)}</ChartCard>}
        {topData.length > 0 && (
          <ChartCard title="Concentración acumulada Top-N" subtitle="% del saldo en los N clientes más grandes" fileName={`TopN_${name}`}>
            <div style={{ height: 260 }}>
              <ResponsiveContainer>
                <BarChart data={topData} margin={{ top: 16, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
                  <XAxis dataKey="label" tick={axis} />
                  <YAxis tick={axis} tickFormatter={pct0} domain={[0, 1]} />
                  <Tooltip formatter={(v: any) => [pct1(Number(v)), '% del saldo']} contentStyle={tooltipStyle} />
                  <Bar dataKey="pct" fill={AX.blue} radius={[6, 6, 0, 0]} label={{ position: 'top', fontSize: 10, fill: AX.ink, formatter: (v: any) => pct0(Number(v)) }} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </ChartCard>
        )}
      </div>


      {a.groups.length > 1 && (
        <div className="grid grid-cols-1 2xl:grid-cols-2 gap-4">
          <ChartCard title="Concentración por grupo económico (Top 10)" subtitle="Acreditados que parecen del mismo grupo se suman (se infiere por nombre)" fileName={`Grupos_${name}`}>
            {hbar(a.groups.slice(0, 10).map(g => ({ name: shorten(g.inferred ? `${g.name} (+${g.members.length - 1})` : g.name, 30), saldo: g.balance, pct: g.pct })), AX.deep)}
          </ChartCard>
          <div className="bg-white border border-slate-200 rounded-2xl p-5">
            <p className="text-xs font-black text-slate-700 uppercase tracking-widest">Grupos detectados</p>
            <p className="text-xs text-slate-500 mt-0.5">Sin RFC ni columna de grupo en el tape, la agrupación es por nombre. Si un acreditado no pertenece al grupo, sepáralo.</p>
            <div className="mt-3 space-y-3 max-h-72 overflow-y-auto pr-1">
              {a.groups.filter(g => g.inferred).length === 0 && <p className="text-xs font-semibold text-slate-400">No se detectaron acreditados relacionados.</p>}
              {a.groups.filter(g => g.inferred).map(g => (
                <div key={g.name} className="rounded-lg border border-slate-200 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-black text-slate-900">{g.name}</p>
                    <span className="text-[11px] font-black text-indigo-700">{pct1(g.pct)} · {g.members.length} acreditados</span>
                  </div>
                  <p className="text-[11px] font-semibold text-slate-400 mb-1">{g.reason} · confianza {g.confidence}</p>
                  <ul className="space-y-0.5">
                    {g.members.map(m => (
                      <li key={m.name} className="flex items-center justify-between gap-2 text-[12px] text-slate-700">
                        <span className="truncate">{m.name}</span>
                        <span className="flex items-center gap-2 shrink-0"><span className="font-mono">{moneyCompact(m.balance)}</span>{onSeparateMember && <button onClick={() => onSeparateMember(m.name)} className="text-[10px] font-black text-slate-400 hover:text-rose-600">separar</button>}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {a.migration && (
        <div className="bg-white border border-slate-200 rounded-2xl p-5">
          <p className="text-xs font-black text-slate-700 uppercase tracking-widest">Matriz de migración de mora — {a.migration.fromLabel} → {a.migration.toLabel}</p>
          <p className="text-xs text-slate-500 mt-0.5">% del saldo previo de cada bucket (renglón) que terminó en cada bucket (columna). «Salió» = pagado, vendido, castigado o con otro ID.</p>
          {a.migration.idBasis !== 'reported' && a.migration.idBasis !== 'none' && (
            <p className={`mt-2 text-[11px] font-bold rounded-lg px-3 py-2 ${a.migration.matchedBalancePct >= 0.5 ? 'bg-amber-50 text-amber-800' : 'bg-red-50 text-red-700'}`}>
              {a.migration.idBasis === 'inferred' ? 'Los créditos se cruzaron por huella (cliente, monto, fechas, renta), no por un ID del archivo.' : 'Parte de los créditos se cruzó por huella y parte por ID del archivo.'}
              {' '}Se reencontró {pct1(a.migration.matchedBalancePct)} del saldo previo
              {a.migration.matchedBalancePct < 0.5 ? ': es poco, lo normal es que los cortes compartan casi toda la cartera; trata «Salió» y «Nuevo» con cautela.' : '.'}
            </p>
          )}
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-slate-500"><th className="px-2 py-1 text-left font-black uppercase">Antes \ Ahora</th>{a.migration.columns.map(c => <th key={c} className="px-2 py-1 text-center font-black uppercase">{c}</th>)}<th className="px-2 py-1 text-right font-black uppercase">Saldo previo</th></tr>
              </thead>
              <tbody>
                {a.migration.rows.map((row, i) => (
                  <tr key={row} className="border-t border-slate-100">
                    <td className="px-2 py-1 font-black text-slate-700">{row}</td>
                    {a.migration!.columns.map((c, j) => {
                      const cell = a.migration!.cells[i][j];
                      const p = a.migration!.rollPct[i][j];
                      const worse = j > i && j < a.migration!.columns.length - 1 && i < a.migration!.rows.length - 1;
                      const base = j === i ? '20,48,230' : worse ? '194,39,28' : '22,183,234';
                      return <td key={c} className="px-2 py-1 text-center font-mono" style={{ background: p > 0 ? `rgba(${base},${Math.min(0.85, 0.12 + p * 0.8)})` : undefined, color: p > 0.45 ? '#fff' : '#0E1B3D' }} title={`${cell.count} créditos · ${money(cell.balance)}`}>{cell.count ? `${(p * 100).toFixed(p < 0.1 ? 1 : 0)}%` : ''}</td>;
                    })}
                    <td className="px-2 py-1 text-right font-mono text-slate-600">{moneyCompact(a.migration!.rowTotals[i].balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-2 text-[11px]">
            {[
              ['Igual de bucket', pct1(a.migration.summary.stablePct)],
              ['Empeoró', pct1(a.migration.summary.worsePct)],
              ['Mejoró', pct1(a.migration.summary.betterPct)],
              ['Roll-in (0 días → atraso)', a.migration.summary.performingToDelinquentPct === null ? 'N/D' : pct1(a.migration.summary.performingToDelinquentPct)],
            ].map(([k, v]) => <div key={k} className="rounded-lg border border-slate-200 px-3 py-2"><p className="text-[10px] font-black uppercase text-slate-400">{k}</p><p className="text-sm font-black text-slate-900">{v}</p></div>)}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 2xl:grid-cols-2 gap-4">
        {a.products.length > 0 && <ChartCard title="Saldo por producto" fileName={`Producto_${name}`}>{hbar(a.products.map(p => ({ name: shorten(p.name, 26), saldo: p.balance, pct: p.pct })), AX.deep)}</ChartCard>}
        {a.products.length > 0 && <ChartCard title="Morosidad por producto" subtitle="% del saldo de cada producto por calidad" fileName={`Morosidad_producto_${name}`}>{stacked(a.products)}</ChartCard>}
        {a.purposes.length > 0 && <ChartCard title="Saldo por destino del crédito" subtitle={`Texto del acreditado agrupado por palabras clave · "Sin dato" = ${(a.purposes.find(p => p.name === 'Sin dato')?.pct ?? 0) > 0 ? `${((a.purposes.find(p => p.name === 'Sin dato')?.pct ?? 0) * 100).toFixed(0)}% del saldo no trae destino` : 'todos traen destino'}`} fileName={`Destino_${name}`}>{hbar(a.purposes.map(p => ({ name: shorten(p.name, 30), saldo: p.balance, pct: p.pct })), AX.cyan)}</ChartCard>}
        {a.purposes.length > 0 && <ChartCard title="Morosidad por destino del crédito" subtitle="% del saldo de cada destino por calidad" fileName={`Morosidad_destino_${name}`}>{stacked(a.purposes)}</ChartCard>}
        {a.industries.length > 0 && <ChartCard title="Saldo por giro (Top 10)" fileName={`Giro_${name}`}>{hbar(a.industries.map(p => ({ name: shorten(p.name, 26), saldo: p.balance, pct: p.pct })), AX.cyan)}</ChartCard>}
        {a.industries.length > 0 && <ChartCard title="Morosidad por giro" fileName={`Morosidad_giro_${name}`}>{stacked(a.industries)}</ChartCard>}
        {a.states.length > 0 && <ChartCard title="Saldo por estado (Top 10)" fileName={`Estado_${name}`}>{hbar(a.states.map(p => ({ name: shorten(p.name, 26), saldo: p.balance, pct: p.pct })), AX.blue)}</ChartCard>}
      </div>

      <div className="grid grid-cols-1 2xl:grid-cols-2 gap-4">
        {a.sizeOutstanding.length > 0 && <ChartCard title="Buckets de tamaño — saldo" subtitle="5 rangos iguales · barras = saldo, línea = % del saldo" fileName={`Buckets_saldo_${name}`}>{bucketCombo(bucketRows(a.sizeOutstanding))}</ChartCard>}
        {a.sizeAmount.length > 0 && <ChartCard title="Buckets de tamaño — monto original" subtitle="5 rangos iguales" fileName={`Buckets_monto_${name}`}>{bucketCombo(bucketRows(a.sizeAmount), AX.blue)}</ChartCard>}
        {a.sizeCount.length > 0 && <ChartCard title="Buckets por # de créditos" subtitle="Mismo número de créditos por bucket" fileName={`Buckets_conteo_${name}`}>{bucketCombo(bucketRows(a.sizeCount), AX.cyan)}</ChartCard>}
      </div>

      {(a.rateBuckets.length > 0 || rateProduct.length > 0 || rateQuality.length > 0) && (
        <div className="grid grid-cols-1 2xl:grid-cols-2 gap-4">
          {a.rateBuckets.length > 0 && <ChartCard title="Distribución por rango de tasa" subtitle="Saldo y % del saldo por rango de tasa de interés" fileName={`Tasas_rango_${name}`}>{bucketCombo(bucketRows(a.rateBuckets, pctRange))}</ChartCard>}
          {rateProduct.length > 0 && (
            <ChartCard title="Tasa ponderada por producto" fileName={`Tasa_producto_${name}`}>
              <div style={{ height: 250 }}>
                <ResponsiveContainer>
                  <BarChart data={rateProduct} margin={{ top: 16, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
                    <XAxis dataKey="name" tick={{ ...axis, fontSize: 10 }} interval={0} />
                    <YAxis tick={axis} tickFormatter={pct0} />
                    <Tooltip formatter={(v: any) => [pct1(Number(v)), 'Tasa ponderada']} contentStyle={tooltipStyle} />
                    <Bar dataKey="tasa" fill={AX.deep} radius={[6, 6, 0, 0]} label={{ position: 'top', fontSize: 10, fill: AX.ink, formatter: (v: any) => pct1(Number(v)) }} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </ChartCard>
          )}
          {rateQuality.length > 0 && (
            <ChartCard title="Tasa: vigente vs. atrasada vs. vencida" subtitle="Tasa ponderada por saldo según calidad" fileName={`Tasa_calidad_${name}`}>
              <div style={{ height: 250 }}>
                <ResponsiveContainer>
                  <BarChart data={rateQuality} margin={{ top: 16, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
                    <XAxis dataKey="name" tick={axis} />
                    <YAxis tick={axis} tickFormatter={pct0} />
                    <Tooltip formatter={(v: any) => [pct1(Number(v)), 'Tasa ponderada']} contentStyle={tooltipStyle} />
                    <Bar dataKey="tasa" radius={[6, 6, 0, 0]} label={{ position: 'top', fontSize: 10, fill: AX.ink, formatter: (v: any) => pct1(Number(v)) }}>
                      {rateQuality.map((r, i) => <Cell key={i} fill={r.color} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </ChartCard>
          )}
        </div>
      )}

      {(a.termBuckets.length > 0 || a.maturity.length > 0) && (
        <div className="grid grid-cols-1 2xl:grid-cols-2 gap-4">
          {a.termBuckets.length > 0 && <ChartCard title="Distribución por plazo original" subtitle="Saldo por rango de plazo (meses)" fileName={`Plazos_${name}`}>{bucketCombo(bucketRows(a.termBuckets, termRange))}</ChartCard>}
          {a.maturity.length > 0 && <ChartCard title="Perfil de vencimientos por trimestre" subtitle="Saldo que vence en cada trimestre" fileName={`Vencimientos_${name}`}>{bucketCombo(a.maturity.map(m => ({ label: m.quarter, saldo: m.balance, pct: m.pct, count: m.count })))}</ChartCard>}
        </div>
      )}

      {(a.originationYearly.length > 0 || a.originationQuarterly.length > 0 || a.originationMonthly.length > 0) && (
        <div className="grid grid-cols-1 2xl:grid-cols-2 gap-4">
          {a.originationYearly.length > 0 && <ChartCard title="Originación anual" subtitle="Monto colocado y crecimiento" fileName={`Originacion_anual_${name}`}>{origCombo(a.originationYearly)}</ChartCard>}
          {a.originationQuarterly.length > 0 && <ChartCard title="Originación trimestral" subtitle="Monto colocado y crecimiento" fileName={`Originacion_trimestral_${name}`}>{origCombo(a.originationQuarterly)}</ChartCard>}
          {a.originationMonthly.length > 0 && <ChartCard title="Originación mensual" subtitle="Monto colocado y crecimiento" fileName={`Originacion_mensual_${name}`}>{origCombo(a.originationMonthly)}</ChartCard>}
        </div>
      )}
    </div>
  );
}
