import React, { useMemo, useState } from 'react';
import type { StandardLoan } from '../../lib/loanTapeAnalytics';
import { MEXICO_STATES, MEXICO_VIEWBOX } from '../../lib/mexicoStatesGeo';
import { aggregateByState, type StateAggregate } from '../../lib/mexicoStates';

type Metric = 'saldo' | 'creditos' | 'vencida';
const METRICS: Array<{ id: Metric; label: string }> = [
  { id: 'saldo', label: 'Saldo' },
  { id: 'creditos', label: 'Créditos' },
  { id: 'vencida', label: '% Vencida' },
];
// Escalas: azul Axcess para concentración, rojo para morosidad. Sin cartera = gris.
const RAMP: Record<Metric, [string, string]> = { saldo: ['#DCE6FF', '#1430E6'], creditos: ['#DCF5FC', '#0E7FA6'], vencida: ['#FDE2DF', '#7F1D1D'] };
const EMPTY = '#EEF1F6';

const hex = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const mix = (a: string, b: string, t: number) => {
  const [x, y] = [hex(a), hex(b)];
  return `rgb(${x.map((v, i) => Math.round(v + (y[i] - v) * t)).join(',')})`;
};
const money = (v: number) => (Math.abs(v) >= 1e6 ? `$${(v / 1e6).toLocaleString('es-MX', { maximumFractionDigits: 2 })}M` : `$${Math.round(v).toLocaleString('es-MX')}`);
const pct = (v: number) => `${(v * 100).toFixed(2)}%`;

export default function MexicoStateMap({ rows }: { rows: StandardLoan[] }) {
  const [metric, setMetric] = useState<Metric>('saldo');
  const [hover, setHover] = useState<string | null>(null);
  const agg = useMemo(() => aggregateByState(rows), [rows]);

  const value = (a: StateAggregate | undefined) => (!a ? null : metric === 'saldo' ? a.balance : metric === 'creditos' ? a.count : a.venPct);
  const values = [...agg.states.values()].map(a => value(a) as number);
  const max = Math.max(0, ...values);
  // Raíz cuadrada: con concentraciones fuertes (un estado con 60%) los demás no quedan todos blancos.
  const fill = (a: StateAggregate | undefined) => {
    const v = value(a);
    if (v === null || !a) return EMPTY;
    if (metric === 'vencida' && v === 0) return RAMP.vencida[0];
    return mix(RAMP[metric][0], RAMP[metric][1], max > 0 ? Math.sqrt(v / max) : 0);
  };
  const fmt = (v: number) => (metric === 'saldo' ? money(v) : metric === 'creditos' ? v.toLocaleString('es-MX') : pct(v));

  const ranking = [...agg.states.values()].sort((x, y) => (value(y) as number) - (value(x) as number));
  const nameOf = (id: string) => MEXICO_STATES.find(s => s.id === id)?.name || id;
  const h = hover ? agg.states.get(hover) : undefined;
  const present = agg.states.size;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex gap-1">
          {METRICS.map(m => (
            <button key={m.id} onClick={() => setMetric(m.id)} className={`text-[11px] font-black px-2.5 py-1 rounded-md border ${metric === m.id ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400'}`}>{m.label}</button>
          ))}
        </div>
        <p className="text-[11px] text-slate-500 font-semibold">
          Cartera en {present} de 32 estados · {pct(agg.coverage)} del saldo trae estado reconocido
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_220px] gap-3">
        <div className="relative">
          <svg viewBox={`0 0 ${MEXICO_VIEWBOX.width} ${MEXICO_VIEWBOX.height}`} className="w-full h-auto" role="img" aria-label="Mapa de calor de la cartera por estado">
            {MEXICO_STATES.map(s => {
              const a = agg.states.get(s.id);
              return (
                <path key={s.id} d={s.d} fill={fill(a)} stroke={hover === s.id ? '#0E1B3D' : '#FFFFFF'} strokeWidth={hover === s.id ? 2 : 0.8}
                  onMouseEnter={() => setHover(s.id)} onMouseLeave={() => setHover(null)} style={{ cursor: 'pointer', transition: 'fill .2s' }}>
                  <title>{`${s.name}: ${a ? `${money(a.balance)} · ${pct(a.pct)} del saldo · ${a.count} créditos · vencida ${pct(a.venPct)}` : 'sin cartera'}`}</title>
                </path>
              );
            })}
          </svg>
          {hover && (
            <div className="absolute top-2 left-2 bg-white/95 border border-slate-200 rounded-xl shadow-lg px-3 py-2 text-xs pointer-events-none">
              <p className="font-black text-slate-900">{nameOf(hover)}</p>
              {h ? (
                <>
                  <p className="text-slate-600">Saldo <span className="font-bold text-slate-900">{money(h.balance)}</span> · {pct(h.pct)} del total</p>
                  <p className="text-slate-600">{h.count.toLocaleString('es-MX')} créditos · vencida <span className={`font-bold ${h.venPct > 0.05 ? 'text-rose-700' : 'text-slate-900'}`}>{pct(h.venPct)}</span></p>
                </>
              ) : <p className="text-slate-500">Sin cartera</p>}
            </div>
          )}
          <div className="flex items-center gap-2 mt-1 text-[10px] font-semibold text-slate-500">
            <span className="inline-block w-3 h-3 rounded-sm border border-slate-200" style={{ background: EMPTY }} /> Sin cartera
            <span className="ml-3">{metric === 'vencida' ? '0%' : 'Menor'}</span>
            <span className="inline-block w-28 h-2.5 rounded-full" style={{ background: `linear-gradient(90deg, ${RAMP[metric][0]}, ${RAMP[metric][1]})` }} />
            <span>{max > 0 ? fmt(max) : '—'}</span>
          </div>
        </div>

        <div className="text-xs max-h-[340px] overflow-auto">
          <table className="w-full">
            <thead className="sticky top-0 bg-white"><tr className="text-left text-slate-500"><th className="py-1 font-black">Estado</th><th className="text-right font-black">{METRICS.find(m => m.id === metric)?.label}</th></tr></thead>
            <tbody>
              {ranking.map(a => (
                <tr key={a.id} onMouseEnter={() => setHover(a.id)} onMouseLeave={() => setHover(null)} className={`border-t border-slate-100 ${hover === a.id ? 'bg-slate-50' : ''}`}>
                  <td className="py-1 flex items-center gap-1.5"><span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: fill(a) }} />{nameOf(a.id)}</td>
                  <td className="text-right font-mono">{fmt(value(a) as number)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {agg.unmatched.length > 0 && (
            <p className="mt-2 text-[10px] text-amber-700 font-semibold">
              Sin estado reconocido: {agg.unmatched.slice(0, 4).map(u => `${u.name} (${money(u.balance)})`).join(', ')}{agg.unmatched.length > 4 ? '…' : ''}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
