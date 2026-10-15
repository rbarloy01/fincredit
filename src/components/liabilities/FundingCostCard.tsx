import React, { useEffect, useMemo, useState } from 'react';
import { ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import { Percent, AlertTriangle } from 'lucide-react';
import type { FinancialStatement_DB, InstitutionalLiability_DB } from '../../db/index';
import type { LiabilitySnapshot } from '../../lib/liabilityHistory';
import { analyzeFundingCost, lenderRatesByCutoff, type ReferenceRates } from '../../lib/fundingCost';
import { parseRateFormula, type ReferenceSeries } from '../../lib/referenceRates';
import { fetchReferenceSeries } from '../../lib/referenceRatesClient';
import { tapePortfolioCached } from '../../lib/tapePortfolioCache';

const pct = (v: number | null | undefined) => (v === null || v === undefined ? 'N/D' : `${(v * 100).toFixed(1)}%`);
const moneyM = (v: number | null | undefined) => (v === null || v === undefined ? 'N/D' : Math.abs(v) >= 1e6 ? `$${(v / 1e6).toLocaleString('es-MX', { maximumFractionDigits: 2 })}M` : `$${Math.round(v / 1e3).toLocaleString('es-MX')}K`);

interface Props { clientId: string; statements: FinancialStatement_DB[]; snapshots: LiabilitySnapshot[]; liabilities: InstitutionalLiability_DB[] }

// Costo del fondeo aproximado con los estados financieros (reglas en lib/fundingCost.ts).
export default function FundingCostCard({ clientId, statements, snapshots, liabilities }: Props) {
  const tape = tapePortfolioCached(clientId) || {};
  const tapeCutoffs = Object.keys(tape).sort();
  const [refRates, setRefRates] = useState<ReferenceRates>({});
  const [refError, setRefError] = useState('');
  // TIIE de Banxico para los meses de los cortes (loan tape y estados): siempre TIIE 28 + las series que usen los contratos.
  useEffect(() => {
    const dates = [...tapeCutoffs, ...statements.map(s => s.periodDate)].filter(Boolean).sort();
    if (!dates.length) return;
    const from = `${dates[0].slice(0, 7)}-01`; const to = new Date().toISOString().slice(0, 10);
    const series = new Set<ReferenceSeries>(['tiie28']);
    liabilities.forEach(l => { const f = parseRateFormula(l.rateDescription); if (f) series.add(f.series); });
    let alive = true;
    Promise.all([...series].map(s => fetchReferenceSeries(s, from, to).then(v => [s, v] as const)))
      .then(pairs => { if (alive) setRefRates(Object.fromEntries(pairs)); })
      .catch(e => { if (alive) setRefError(e?.message || String(e)); });
    return () => { alive = false; };
  }, [clientId, statements.length, liabilities.length, tapeCutoffs.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  const a = useMemo(() => analyzeFundingCost(statements, snapshots, liabilities, refRates), [statements, snapshots, liabilities, refRates]);
  const byCutoff = useMemo(() => lenderRatesByCutoff(liabilities, tape, refRates).slice(-12), [liabilities, tape, refRates]);
  if (!a.periods.length) {
    return (
      <div className="border border-slate-200 rounded-xl p-4 text-sm text-slate-500">
        <p className="text-xs font-black text-slate-700 uppercase tracking-widest flex items-center gap-1.5 mb-1"><Percent className="w-3.5 h-3.5 text-indigo-600" />Costo del fondeo (estimado con EEFF)</p>
        {a.notes[0] || 'Sin estados financieros con gasto por intereses.'}
      </div>
    );
  }
  const l = a.latest!;
  const series = a.periods.slice(-12).map(p => ({ corte: p.cutoff.slice(0, 7), gasto: Math.round(p.periodExpense / p.months), costo: p.rate === null ? null : Math.round(p.rate * 1000) / 10 }));
  return (
    <div className="border border-slate-200 rounded-xl p-4 space-y-3">
      <div>
        <p className="text-xs font-black text-slate-700 uppercase tracking-widest flex items-center gap-1.5"><Percent className="w-3.5 h-3.5 text-indigo-600" />Costo del fondeo (estimado con EEFF)</p>
        <p className="text-[11px] text-slate-500 mt-0.5">Gasto por intereses del estado de resultados ÷ saldo promedio del fondeo (segregación del pasivo o deuda del balance), anualizado. Aproximación: el contrato de cada línea manda.</p>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { k: 'Costo implícito anual', v: pct(l.rate), d: `Periodo al ${l.cutoff}`, tone: l.flag ? 'text-amber-700' : 'text-slate-900' },
          { k: 'Gasto financiero anual', v: moneyM(a.annualExpense), d: a.annualBasis },
          { k: 'Gasto del último mes', v: moneyM(l.periodExpense / l.months), d: l.basis.startsWith('diferencia') ? 'acumulado − acumulado anterior' : l.basis },
          { k: 'Saldo promedio de fondeo', v: moneyM(l.avgDebt), d: `Fuente: ${l.debtSource}` },
        ].map(t => (
          <div key={t.k} className="bg-slate-50 rounded-lg p-3">
            <p className="text-[10px] font-black uppercase tracking-wider text-slate-500">{t.k}</p>
            <p className={`text-lg font-black ${t.tone || 'text-slate-900'}`}>{t.v}</p>
            <p className="text-[11px] text-slate-400 truncate">{t.d}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <ResponsiveContainer width="100%" height={220}>
          <ComposedChart data={series}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="corte" fontSize={10} />
            <YAxis yAxisId="g" fontSize={10} tickFormatter={(v: number) => moneyM(v)} width={52} />
            <YAxis yAxisId="c" orientation="right" fontSize={10} tickFormatter={(v: number) => `${v}%`} width={40} />
            <Tooltip formatter={(v: number, n: string) => (n === 'Costo anual' ? `${v}%` : moneyM(v))} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar yAxisId="g" dataKey="gasto" name="Gasto mensual" fill="#8FB4FF" />
            <Line yAxisId="c" dataKey="costo" name="Costo anual" stroke="#1430E6" strokeWidth={2} dot={{ r: 2 }} />
          </ComposedChart>
        </ResponsiveContainer>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead><tr className="text-left text-slate-500"><th className="py-1">Fondeador</th><th className="text-right">Saldo</th><th className="text-right">Tasa</th><th>Fuente</th><th className="text-right">Gasto anual aprox.</th></tr></thead>
            <tbody>
              {a.byLender.map(b => (
                <tr key={b.lender} className="border-t border-slate-100">
                  <td className="py-1 font-semibold text-slate-700">{b.lender}</td>
                  <td className="text-right font-mono">{moneyM(b.balance)}</td>
                  <td className="text-right font-mono">{pct(b.rate)}</td>
                  <td className={b.source === 'contrato' ? 'text-emerald-700 font-semibold' : 'text-amber-700'}>{b.source}</td>
                  <td className="text-right font-mono">{moneyM(b.annualCost)}</td>
                </tr>
              ))}
              {a.unexplained !== null && a.unexplained > 0 && (
                <tr className="border-t border-slate-100 text-amber-800"><td className="py-1 font-semibold" colSpan={4}>No explicado por tasas de contrato</td><td className="text-right font-mono">{moneyM(a.unexplained)}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      {byCutoff.length > 0 && (
        <div className="overflow-x-auto">
          <p className="text-xs font-black text-slate-700 uppercase tracking-widest mb-1">Tasa por fondeador en cada corte del loan tape</p>
          <p className="text-[11px] text-slate-500 mb-2">TIIE de Banxico al cierre de cada mes. Las líneas "TIIE + sobretasa" se recalculan cada mes; spread = tasa de la cartera vigente del loan tape − tasa del fondeador.{refError ? ` · Banxico: ${refError}` : ''}</p>
          <table className="w-full text-xs">
            <thead><tr className="text-left text-slate-500"><th className="py-1">Corte</th><th className="text-right">TIIE 28</th><th className="text-right">Tasa cartera</th>{byCutoff[0].lenders.map(l => <th key={l.lender} className="text-right">{l.lender}<span className="block text-[9px] font-semibold text-slate-400">{l.source}</span></th>)}</tr></thead>
            <tbody>
              {byCutoff.map(r => (
                <tr key={r.cutoff} className="border-t border-slate-100">
                  <td className="py-1 font-semibold">{r.cutoff}</td>
                  <td className="text-right font-mono">{r.tiie.tiie28 === null || r.tiie.tiie28 === undefined ? '…' : `${r.tiie.tiie28.toFixed(2)}%`}</td>
                  <td className="text-right font-mono">{pct(r.assetRate)}</td>
                  {r.lenders.map(l => (
                    <td key={l.lender} className="text-right font-mono">{pct(l.rate)}{l.spread !== null && <span className={`block text-[10px] ${l.spread < 0 ? 'text-rose-600' : 'text-emerald-700'}`}>spread {(l.spread * 100).toFixed(1)} pp</span>}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {a.notes.length > 0 && (
        <ul className="space-y-1">{a.notes.map((n, i) => <li key={i} className="text-xs text-slate-600 flex gap-1.5"><AlertTriangle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0 mt-0.5" />{n}</li>)}</ul>
      )}
    </div>
  );
}
