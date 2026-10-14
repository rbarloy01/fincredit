import React, { useEffect, useMemo, useState } from 'react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import { CalendarClock, Plus, Download, Trash2, CheckCircle2, XCircle, MinusCircle, Lightbulb, Save, X } from 'lucide-react';
import { db, type FinancialStatement_DB, type InstitutionalLiability_DB } from '../../db/index';
import {
  type LiabilityHistoryStore, type LiabilityLine, type LiabilityTerm, analyzeLiabilityHistory, buildLiabilityHistorySheets,
  loadLiabilityHistory, saveLiabilityHistory, upsertSnapshot,
} from '../../lib/liabilityHistory';
import { loadExportModule } from '../../lib/exportLoader';
import FundingCostCard from './FundingCostCard';
import { reserveDownloadTarget } from '../../lib/browserDownload';

const PALETTE = ['#1430E6', '#16B7EA', '#1B5BF5', '#8FB4FF', '#0E1B3D', '#7A5CFF', '#00A3A3', '#5D6B8A'];
const money = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `$${Math.round(v).toLocaleString('es-MX')}`);
const moneyM = (v: number) => (Math.abs(v) >= 1e6 ? `$${(v / 1e6).toLocaleString('es-MX', { maximumFractionDigits: 1 })}M` : `$${Math.round(v / 1e3).toLocaleString('es-MX')}K`);
const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`);
const signed = (v: number | null, f: (n: number) => string) => (v === null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${f(Math.abs(v))}`);
const input = 'border border-slate-200 rounded-lg px-2 py-1.5 text-sm w-full focus:outline-none focus:ring-2 focus:ring-indigo-300';

interface Props {
  clientId: string;
  clientName: string;
  liabilities: InstitutionalLiability_DB[];
  onSyncBalances?: (lines: LiabilityLine[], cutoff: string) => Promise<void>;
  reloadKey?: number;
}

type DraftLine = { lender: string; term: LiabilityTerm; balance: string };

export default function LiabilityHistoryPanel({ clientId, clientName, liabilities, onSyncBalances, reloadKey = 0 }: Props) {
  const [store, setStore] = useState<LiabilityHistoryStore>({ snapshots: [] });
  const [statements, setStatements] = useState<FinancialStatement_DB[]>([]);
  const [editing, setEditing] = useState(false);
  const [cutoff, setCutoff] = useState('');
  const [source, setSource] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [sync, setSync] = useState(true);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    void loadLiabilityHistory(clientId).then(setStore);
    void db.getStatements(clientId).then(setStatements).catch(() => setStatements([]));
  }, [clientId, reloadKey]);

  const a = useMemo(() => analyzeLiabilityHistory(clientId, store, statements), [clientId, store, statements]);

  // El siguiente corte arranca con los acreedores del último (o los pasivos registrados): solo se capturan los saldos nuevos.
  const openNew = () => {
    const last = store.snapshots.at(-1);
    const base: DraftLine[] = last
      ? last.lines.map(l => ({ lender: l.lender, term: l.term, balance: '' }))
      : liabilities.map(l => ({ lender: l.lenderName, term: '' as LiabilityTerm, balance: l.currentBalance ? String(l.currentBalance) : '' }));
    setLines(base.length ? base : [{ lender: '', term: '', balance: '' }]);
    setCutoff(''); setSource(''); setMsg(''); setEditing(true);
  };

  const save = async () => {
    const clean = lines.map(l => ({ lender: l.lender.trim(), term: l.term, balance: Number(String(l.balance).replace(/[$,\s]/g, '')) }))
      .filter(l => l.lender && Number.isFinite(l.balance));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoff)) { setMsg('Captura la fecha de corte.'); return; }
    if (!clean.length) { setMsg('Captura al menos un acreedor con saldo.'); return; }
    const next = upsertSnapshot(store, { cutoff, source: source.trim() || undefined, lines: clean, createdAt: new Date().toISOString() });
    await saveLiabilityHistory(clientId, next);
    setStore(next);
    const isLatest = next.snapshots.at(-1)?.cutoff === cutoff;
    if (sync && isLatest && onSyncBalances) await onSyncBalances(clean, cutoff);
    setEditing(false);
    setMsg(`✓ Corte ${cutoff} guardado${sync && isLatest ? ' · saldos actuales de los pasivos actualizados' : ''}.`);
  };

  const remove = async (c: string) => {
    if (!confirm(`¿Eliminar el corte ${c} del historial?`)) return;
    const next = { snapshots: store.snapshots.filter(s => s.cutoff !== c) };
    await saveLiabilityHistory(clientId, next);
    setStore(next);
  };

  const exportExcel = async () => {
    const target = reserveDownloadTarget();
    const { exportToExcel } = await loadExportModule();
    await exportToExcel(buildLiabilityHistorySheets(clientName, a), `Historial_fondeo_${clientName}`, target);
  };

  const chartData = a.cutoffs.map((c, i) => {
    const row: Record<string, number | string> = { corte: c };
    a.lenders.forEach(l => { row[l.lender] = l.balances[i] ?? 0; });
    return row;
  });
  const lt = a.latest;

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h3 className="font-black text-slate-900 flex items-center gap-2"><CalendarClock className="w-4 h-4 text-indigo-600" />Historial mensual del fondeo</h3>
          <p className="text-xs text-slate-500 mt-0.5">Saldo por acreedor en cada corte (segregación del pasivo). Cada mes se agrega un corte; nunca se sobrescribe el anterior.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={openNew} className="flex items-center gap-1.5 text-xs font-black text-white bg-indigo-600 hover:bg-indigo-700 px-3 py-2 rounded-xl"><Plus className="w-3.5 h-3.5" />Agregar corte</button>
          <button onClick={exportExcel} disabled={!a.cutoffs.length} className="flex items-center gap-1.5 text-xs font-black text-slate-700 bg-white border border-slate-200 hover:border-indigo-300 disabled:opacity-40 px-3 py-2 rounded-xl"><Download className="w-3.5 h-3.5" />Excel</button>
        </div>
      </div>
      {msg && <p className={`text-xs font-semibold ${msg.startsWith('✓') ? 'text-emerald-700' : 'text-rose-600'}`}>{msg}</p>}

      {editing && (
        <div className="border border-indigo-200 bg-indigo-50/40 rounded-xl p-4 space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <label className="text-[10px] font-black text-slate-500 uppercase">Fecha de corte<input type="date" className={input} value={cutoff} onChange={e => setCutoff(e.target.value)} /></label>
            <label className="text-[10px] font-black text-slate-500 uppercase md:col-span-2">Fuente<input className={input} value={source} onChange={e => setSource(e.target.value)} placeholder="Segregación de pasivos sep-26" /></label>
          </div>
          <table className="w-full text-sm">
            <thead><tr className="text-left text-[10px] font-black text-slate-500 uppercase"><th className="py-1">Acreedor</th><th>Plazo</th><th className="text-right">Saldo (pesos)</th><th /></tr></thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i}>
                  <td className="py-1 pr-2"><input className={input} value={l.lender} onChange={e => setLines(ls => ls.map((x, j) => j === i ? { ...x, lender: e.target.value } : x))} /></td>
                  <td className="pr-2 w-36"><select className={input} value={l.term} onChange={e => setLines(ls => ls.map((x, j) => j === i ? { ...x, term: e.target.value as LiabilityTerm } : x))}><option value="">—</option><option value="corto">Corto plazo</option><option value="largo">Largo plazo</option></select></td>
                  <td className="pr-2 w-48"><input className={`${input} text-right font-mono`} inputMode="decimal" value={l.balance} onChange={e => setLines(ls => ls.map((x, j) => j === i ? { ...x, balance: e.target.value } : x))} placeholder="0" /></td>
                  <td className="w-8"><button onClick={() => setLines(ls => ls.filter((_, j) => j !== i))} className="text-slate-300 hover:text-rose-500"><X className="w-4 h-4" /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <button onClick={() => setLines(ls => [...ls, { lender: '', term: '', balance: '' }])} className="flex items-center gap-1 text-xs font-black text-indigo-600"><Plus className="w-3.5 h-3.5" />Otro acreedor</button>
            <label className="flex items-center gap-2 text-xs font-semibold text-slate-600"><input type="checkbox" checked={sync} onChange={e => setSync(e.target.checked)} />Si es el corte más reciente, actualizar el saldo actual de cada pasivo</label>
            <div className="flex gap-2">
              <button onClick={() => setEditing(false)} className="text-xs font-black text-slate-500 px-3 py-2">Cancelar</button>
              <button onClick={save} className="flex items-center gap-1.5 text-xs font-black text-white bg-slate-900 px-3 py-2 rounded-xl"><Save className="w-3.5 h-3.5" />Guardar corte</button>
            </div>
          </div>
        </div>
      )}

      <FundingCostCard statements={statements} snapshots={store.snapshots} liabilities={liabilities} />

      {!a.cutoffs.length ? (
        <p className="text-sm text-slate-400 py-6 text-center">Aún no hay cortes. Agrega la segregación del pasivo de cada mes para ver la evolución por acreedor.</p>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
            {[
              { k: 'Fondeo institucional', v: lt ? moneyM(lt.total) : '—', d: `Corte ${lt?.cutoff}` },
              { k: 'Vs corte anterior', v: signed(lt?.delta ?? null, moneyM), d: lt?.deltaPct !== null && lt?.deltaPct !== undefined ? signed(lt.deltaPct, n => `${(n * 100).toFixed(1)}%`) : 'Requiere 2 cortes', tone: lt?.delta ? (lt.delta < 0 ? 'text-emerald-700' : 'text-amber-700') : '' },
              { k: 'Fondeadores', v: String(lt?.lenders ?? '—'), d: `HHI ${lt ? lt.hhi.toFixed(2) : '—'}` },
              { k: 'Principal fondeador', v: pct(lt?.topShare), d: lt?.topLender || '—', tone: (lt?.topShare || 0) >= 0.6 ? 'text-rose-700' : '' },
              { k: 'Aforo vigente', v: a.portfolio.at(-1)?.ratio ? `${a.portfolio.at(-1)!.ratio!.toFixed(2)}x` : 'N/D', d: a.portfolio.at(-1)?.portfolio ? `Cartera vigente ${moneyM(a.portfolio.at(-1)!.portfolio!)} ÷ fondeo` : 'Sin loan tape del corte' },
            ].map(t => (
              <div key={t.k} className="border border-slate-200 rounded-xl p-3">
                <p className="text-[10px] font-black uppercase tracking-wider text-slate-500">{t.k}</p>
                <p className={`text-lg font-black mt-0.5 ${t.tone || 'text-slate-900'}`}>{t.v}</p>
                <p className="text-[11px] font-semibold text-slate-400 truncate">{t.d}</p>
              </div>
            ))}
          </div>

          <div className="bg-indigo-50/60 border border-indigo-100 rounded-xl p-4">
            <p className="text-xs font-black text-indigo-900 uppercase tracking-widest flex items-center gap-1.5 mb-2"><Lightbulb className="w-3.5 h-3.5" />Lectura</p>
            <ul className="space-y-1">{a.insights.map((t, i) => <li key={i} className="text-sm text-slate-700">• {t}</li>)}</ul>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <div>
              <p className="text-xs font-black text-slate-700 uppercase tracking-widest mb-2">Fondeo por acreedor y corte</p>
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="corte" fontSize={11} />
                  <YAxis fontSize={10} tickFormatter={(v: number) => moneyM(v)} width={56} />
                  <Tooltip formatter={(v: number) => money(v)} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  {a.lenders.map((l, i) => <Bar key={l.lender} dataKey={l.lender} stackId="f" fill={PALETTE[i % PALETTE.length]} />)}
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="overflow-x-auto">
              <p className="text-xs font-black text-slate-700 uppercase tracking-widest mb-2">Mes a mes</p>
              <table className="w-full text-xs">
                <thead><tr className="text-left text-slate-500"><th className="py-1">Acreedor</th>{a.cutoffs.map(c => <th key={c} className="text-right">{c}<button onClick={() => remove(c)} className="ml-1 text-slate-300 hover:text-rose-500 align-middle"><Trash2 className="w-3 h-3 inline" /></button></th>)}<th className="text-right">Δ</th><th className="text-right">%</th></tr></thead>
                <tbody>
                  {a.lenders.map(l => (
                    <tr key={l.lender} className="border-t border-slate-100">
                      <td className="py-1 font-semibold text-slate-700">{l.lender}{l.term ? <span className="text-[10px] text-slate-400 ml-1">{l.term === 'corto' ? 'CP' : 'LP'}</span> : null}</td>
                      {l.balances.map((b, i) => <td key={i} className="text-right font-mono">{b === null ? '—' : moneyM(b)}</td>)}
                      <td className={`text-right font-mono ${l.delta && l.delta < 0 ? 'text-emerald-700' : l.delta ? 'text-amber-700' : ''}`}>{signed(l.delta, moneyM)}</td>
                      <td className="text-right font-mono">{pct(l.share)}</td>
                    </tr>
                  ))}
                  <tr className="border-t-2 border-slate-300 font-black">
                    <td className="py-1">Total</td>
                    {a.totals.map((t, i) => <td key={i} className="text-right font-mono">{moneyM(t)}</td>)}
                    <td className="text-right font-mono">{signed(lt?.delta ?? null, moneyM)}</td>
                    <td className="text-right font-mono">100%</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div>
            <p className="text-xs font-black text-slate-700 uppercase tracking-widest mb-2">Cuadres</p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {a.checks.map((c, i) => (
                <div key={i} className="flex items-start gap-2 text-xs border border-slate-100 rounded-lg px-3 py-2">
                  {c.ok === true ? <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0" /> : c.ok === false ? <XCircle className="w-4 h-4 text-rose-600 flex-shrink-0" /> : <MinusCircle className="w-4 h-4 text-slate-300 flex-shrink-0" />}
                  <span><span className="font-black text-slate-700">{c.cutoff}</span> · {c.detail}</span>
                </div>
              ))}
              {a.impliedCost.map((c, i) => (
                <div key={`ic${i}`} className="flex items-start gap-2 text-xs border border-slate-100 rounded-lg px-3 py-2">
                  <Lightbulb className="w-4 h-4 text-indigo-500 flex-shrink-0" />
                  <span>Costo de fondeo implícito {c.from} → {c.to}: <span className="font-black">{pct(c.rate)}</span> anual (gasto por intereses del periodo ÷ saldo promedio)</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
