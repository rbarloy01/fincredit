import React, { useEffect, useMemo, useState } from 'react';
import { ResponsiveContainer, ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import type { LoanTape_DB } from '../../db/index';
import { tapePortfolioPoints } from '../../lib/tapePortfolio';
import { effectiveWaRate } from '../../lib/loanTapeRates';
import { fetchReferenceSeries } from '../../lib/referenceRatesClient';
import type { MonthlySeries } from '../../lib/referenceRates';
import ChartCard from './ChartCard';

const pct = (v: number | null | undefined) => (v === null || v === undefined ? 'N/D' : `${(v * 100).toFixed(2)}%`);

// Tasa de la cartera vs TIIE por corte (reglas en lib/loanTapeRates.ts; TIIE de Banxico vía /api/banxico).
export default function LoanTapeTiieCard({ tapes, clientName }: { tapes: LoanTape_DB[]; clientName?: string }) {
  const points = useMemo(() => {
    const out = new Map<string, ReturnType<typeof tapePortfolioPoints>[number]>();
    tapes.forEach(t => {
      const rows = t.extractedData?._standardized;
      if (Array.isArray(rows) && rows.length) tapePortfolioPoints(rows, t.fileName || '', t.extractedData?._mappingReport || []).forEach(p => out.set(p.cutoff, p));
    });
    return [...out.values()].filter(p => p.waRate !== null && p.waRate !== undefined).sort((a, b) => a.cutoff.localeCompare(b.cutoff));
  }, [tapes]);
  const [tiie, setTiie] = useState<MonthlySeries>({});
  const [error, setError] = useState('');
  useEffect(() => {
    if (!points.length) return;
    let alive = true;
    fetchReferenceSeries('tiie28', `${points[0].cutoff.slice(0, 7)}-01`, new Date().toISOString().slice(0, 10))
      .then(v => { if (alive) setTiie(v); }).catch(e => { if (alive) setError(e?.message || String(e)); });
    return () => { alive = false; };
  }, [points.map(p => p.cutoff).join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!points.length) return null;
  const rows = points.map(p => {
    const t = tiie[p.cutoff.slice(0, 7)] ?? null;
    const eff = effectiveWaRate({ waReported: p.waRate as number, variableShare: p.variableShare || 0 }, t);
    return { p, tiie: t, eff, spread: eff !== null && t !== null ? eff - t / 100 : null };
  });
  const anyVariable = rows.some(r => (r.p.variableShare || 0) > 0);
  const anyAssumed = rows.some(r => (r.p.assumedVariable || 0) > 0);
  const chart = rows.map(r => ({ corte: r.p.cutoff.slice(0, 7), tiie: r.tiie, cartera: r.eff === null ? null : Math.round(r.eff * 10000) / 100, sobre: r.spread === null ? null : Math.round(r.spread * 10000) / 100 }));
  return (
    <ChartCard title="Tasa de la cartera vs TIIE" subtitle={`TIIE 28 de Banxico al cierre de cada corte · tasa ponderada de la cartera vigente${anyVariable ? ' (créditos a TIIE: TIIE del mes + sobretasa)' : ''}${error ? ` · Banxico: ${error}` : ''}`} fileName={`Tasa_vs_TIIE_${clientName || 'cliente'}`}>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <ResponsiveContainer width="100%" height={240}>
          <ComposedChart data={chart}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="corte" fontSize={10} />
            <YAxis fontSize={10} tickFormatter={(v: number) => `${v}%`} width={40} />
            <Tooltip formatter={(v: number) => `${v?.toFixed?.(2)}%`} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Line dataKey="cartera" name="Tasa cartera" stroke="#1430E6" strokeWidth={2} dot={{ r: 2 }} connectNulls />
            <Line dataKey="tiie" name="TIIE 28" stroke="#E8A317" strokeWidth={2} dot={{ r: 2 }} connectNulls />
            <Line dataKey="sobre" name="Sobretasa sobre TIIE" stroke="#128A48" strokeDasharray="4 3" dot={false} connectNulls />
          </ComposedChart>
        </ResponsiveContainer>
        <div className="overflow-x-auto max-h-[260px]">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-white"><tr className="text-left text-slate-500"><th className="py-1">Corte</th><th className="text-right">TIIE 28</th><th className="text-right">Tasa reportada</th><th className="text-right">% a TIIE</th><th className="text-right">Tasa efectiva</th><th className="text-right">Sobre TIIE</th></tr></thead>
            <tbody>
              {[...rows].reverse().map(r => (
                <tr key={r.p.cutoff} className="border-t border-slate-100">
                  <td className="py-1 font-semibold">{r.p.cutoff}</td>
                  <td className="text-right font-mono">{r.tiie === null ? '…' : `${r.tiie.toFixed(2)}%`}</td>
                  <td className="text-right font-mono">{pct(r.p.waRate)}</td>
                  <td className="text-right font-mono">{`${Math.round((r.p.variableShare || 0) * 100)}%`}{(r.p.assumedVariable || 0) > 0 && <span className="text-amber-600" title="Supuesto: la columna se llama sobretasa y el archivo no trae base de tasa">*</span>}</td>
                  <td className="text-right font-mono font-bold">{pct(r.eff)}</td>
                  <td className="text-right font-mono">{r.spread === null ? 'N/D' : `${(r.spread * 100).toFixed(2)} pp`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {anyAssumed && <p className="text-[11px] text-amber-700 mt-2">* Supuesto: la columna de tasa del archivo se llama "sobretasa" y no trae base de tasa; se toma como sobretasa sobre TIIE 28. Si en realidad es la tasa total, corrígelo en el mapeo de columnas.</p>}
    </ChartCard>
  );
}
