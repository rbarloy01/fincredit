import React, { useEffect, useMemo, useState } from 'react';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine } from 'recharts';
import { Scale, Upload, Save, Trash2, Download, AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { db, type Client, type LoanTape_DB, type Transaction } from '../../db/index';
import type { Session } from '../../services/auth';
import type { StandardLoan } from '../../lib/loanTapeAnalytics';
import { MAPPING_OVERRIDES_KEY, type MappingOverrides } from '../../lib/loanTapeAnalytics';
import { importLoanTapeSheets } from '../../lib/loanTapeImport';
import { sheetToRows } from '../../lib/sheetRows';
import {
  type AforoCut, type AforoStore, type AforoTerms, aforoHistoryEntry, buildAforoSheets, compactLoans, computeAforo,
  defaultAforoTerms, loadAforo, parseRequiredRatio, saveAforo,
} from '../../lib/aforo';
import { loadExportModule } from '../../lib/exportLoader';
import { reserveDownloadTarget } from '../../lib/browserDownload';

const money = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v.toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }));
const xS = (v: number | null) => (v === null ? 'N/D' : `${v.toFixed(2)}x`);
const inputClass = 'bg-slate-50 border border-slate-200 text-slate-900 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 w-full';
const label = 'text-[10px] font-black text-slate-500 uppercase tracking-wider block mb-1';

interface Props {
  client: Client;
  transactions: Transaction[];
  session: Session;
  onClientUpdate: (updates: Partial<Client>) => Promise<void>;
}

export default function AforoPanel({ client, transactions, session, onClientUpdate }: Props) {
  const [store, setStore] = useState<AforoStore>({ terms: {}, cuts: [] });
  const [tapes, setTapes] = useState<LoanTape_DB[]>([]);
  const [facility, setFacility] = useState<string>(transactions[0]?.id || '');
  const [termsDraft, setTermsDraft] = useState({ required: '', maxDpd: '90', excludeNotInTape: true });
  const [form, setForm] = useState({ cutoff: '', debt: '', notes: '' });
  const [ceded, setCeded] = useState<{ fileName: string; rows: StandardLoan[]; messages: string[] } | null>(null);
  const [selectedCut, setSelectedCut] = useState<string>('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');

  useEffect(() => {
    void loadAforo(client.id).then(setStore);
    void db.getLoanTapes(client.id).then(setTapes).catch(() => setTapes([]));
  }, [client.id]);

  const tapeRows: StandardLoan[] = useMemo(() => tapes.flatMap(t => (Array.isArray(t.extractedData?._standardized) ? t.extractedData._standardized : [])), [tapes]);
  const cutoffs = useMemo(() => Array.from(new Set(tapeRows.map(r => r.file_date).filter(Boolean) as string[])).sort().reverse(), [tapeRows]);
  const terms: AforoTerms = store.terms[facility] || { ...defaultAforoTerms(), requiredRatio: parseRequiredRatio(client.aforoRequerido || '') };
  useEffect(() => {
    setTermsDraft({ required: terms.requiredRatio === null ? '' : String(terms.requiredRatio), maxDpd: String(terms.maxDpdEligible), excludeNotInTape: terms.excludeNotInTape });
  }, [facility, store.terms[facility]]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!form.cutoff && cutoffs[0]) setForm(f => ({ ...f, cutoff: cutoffs[0] })); }, [cutoffs]); // eslint-disable-line react-hooks/exhaustive-deps

  const facilityCuts = store.cuts.filter(c => c.transactionId === facility).sort((a, b) => a.cutoff.localeCompare(b.cutoff));
  const history = facilityCuts.map(cut => ({ cut, result: computeAforo(cut, terms, tapeRows) }));
  const current = history.find(h => h.cut.id === selectedCut) || history.at(-1) || null;
  const facilityName = transactions.find(t => t.id === facility)?.name || 'General del cliente';

  const persist = async (next: AforoStore) => { await saveAforo(client.id, next); setStore(next); };

  const saveTerms = async () => {
    const required = parseRequiredRatio(termsDraft.required);
    const next = { ...store, terms: { ...store.terms, [facility]: { ...defaultAforoTerms(), ...terms, requiredRatio: required, maxDpdEligible: Number(termsDraft.maxDpd) || 0, excludeNotInTape: termsDraft.excludeNotInTape } } };
    await persist(next);
    setMsg(`✓ Términos guardados: aforo requerido ${required === null ? 'sin capturar' : xS(required)}, elegible hasta ${termsDraft.maxDpd} días de atraso.`);
  };

  const readCeded = async (file: File) => {
    setBusy('Leyendo cartera cedida…');
    try {
      const XLSX = await import('xlsx');
      const wb = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: 'array' });
      const sheets = wb.SheetNames.map(name => ({ name, rows: sheetToRows<any[]>(XLSX, wb.Sheets[name], { header: 1, blankrows: false, defval: null }) }));
      const overrides = await db.getClientSetting<MappingOverrides>(client.id, MAPPING_OVERRIDES_KEY, {}).catch(() => ({} as MappingOverrides));
      const res = importLoanTapeSheets(sheets, file.name, { mappingOverrides: overrides });
      setCeded({ fileName: file.name, rows: res.standardized, messages: res.reconciliation.messages });
      const cut = [...new Set(res.standardized.map(r => r.file_date).filter(Boolean))].sort().at(-1);
      if (cut && cutoffs.includes(cut)) setForm(f => ({ ...f, cutoff: cut }));
    } catch (e: any) {
      setMsg(`No se pudo leer el archivo: ${e?.message || e}`);
    } finally { setBusy(''); }
  };

  const addCut = async () => {
    const debt = Number(String(form.debt).replace(/[$,\s]/g, ''));
    if (!form.cutoff) { setMsg('Elige la fecha de corte.'); return; }
    if (!Number.isFinite(debt) || debt <= 0) { setMsg('Captura el saldo de la deuda de la facility a esa fecha.'); return; }
    const cut: AforoCut = {
      id: `a${Date.now()}`, transactionId: facility, cutoff: form.cutoff, debtBalance: debt, notes: form.notes.trim() || undefined,
      ceded: ceded ? { fileName: ceded.fileName, rows: compactLoans(ceded.rows) } : undefined,
      createdAt: new Date().toISOString(), createdBy: session.userName,
    };
    const result = computeAforo(cut, terms, tapeRows);
    cut.snapshot = { ratio: result.ratio, eligible: result.totals.eligible, required: result.required, status: result.status };
    setBusy('Guardando corte…');
    try {
      await persist({ ...store, cuts: [...store.cuts.filter(c => !(c.transactionId === facility && c.cutoff === cut.cutoff)), cut] });
      // El reporte de monitoreo toma el aforo de aquí.
      const entry = aforoHistoryEntry(cut, result);
      const hist = (client.aforoHistory || []).filter(h => !(h.month === entry.month && (h.transactionId || '') === (entry.transactionId || '')));
      await onClientUpdate({ aforoHistory: [...hist, entry] });
      setSelectedCut(cut.id); setCeded(null); setForm(f => ({ ...f, debt: '', notes: '' }));
      setMsg(`✓ Corte ${cut.cutoff} calculado: aforo ${xS(result.ratio)}${result.required !== null ? ` vs. ${xS(result.required)} requerido` : ''}.`);
    } catch (e: any) {
      setMsg(`No se pudo guardar: ${e?.message || e}`);
    } finally { setBusy(''); }
  };

  const deleteCut = async (id: string) => {
    if (!confirm('¿Eliminar este corte de aforo?')) return;
    await persist({ ...store, cuts: store.cuts.filter(c => c.id !== id) });
  };

  const exportExcel = async () => {
    if (!current) return;
    const target = reserveDownloadTarget();
    const { exportToExcel } = await loadExportModule();
    await exportToExcel(buildAforoSheets(client.name, facilityName, current.cut, terms, current.result, history), `Aforo_${client.name}_${current.cut.cutoff}`, target);
  };

  const r = current?.result;
  const statusTone = r?.status === 'cumple' ? 'text-emerald-700 bg-emerald-50 border-emerald-200' : r?.status === 'incumple' ? 'text-rose-700 bg-rose-50 border-rose-200' : 'text-amber-700 bg-amber-50 border-amber-200';

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-black text-slate-900 flex items-center gap-2"><Scale className="w-5 h-5 text-indigo-600" />Aforo</h2>
          <p className="text-sm text-slate-500 mt-0.5">Colateral elegible ÷ deuda. Si hay reporte de cartera cedida se cruza crédito por crédito contra el loan tape del mismo corte; si no, el colateral es el loan tape.</p>
        </div>
        <label className="text-xs font-bold text-slate-600 flex items-center gap-2">Facility
          <select value={facility} onChange={e => { setFacility(e.target.value); setSelectedCut(''); }} className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
            {transactions.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            <option value="">General del cliente</option>
          </select>
        </label>
      </div>
      {msg && <p className={`text-xs font-semibold ${msg.startsWith('✓') ? 'text-emerald-700' : 'text-rose-600'}`}>{msg}</p>}
      {busy && <p className="text-xs font-semibold text-indigo-600">{busy}</p>}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div className="bg-white border border-slate-200 rounded-2xl p-4 space-y-3">
          <p className="text-xs font-black text-slate-700 uppercase tracking-widest">Términos del aforo — {facilityName}</p>
          <div className="grid grid-cols-3 gap-3">
            <div><span className={label}>Aforo requerido</span><input className={inputClass} value={termsDraft.required} onChange={e => setTermsDraft({ ...termsDraft, required: e.target.value })} placeholder="1.3x o 130%" /></div>
            <div><span className={label}>Elegible hasta (días atraso)</span><input className={inputClass} inputMode="numeric" value={termsDraft.maxDpd} onChange={e => setTermsDraft({ ...termsDraft, maxDpd: e.target.value })} /></div>
            <label className="flex items-end gap-2 text-xs font-semibold text-slate-600 pb-1.5"><input type="checkbox" checked={termsDraft.excludeNotInTape} onChange={e => setTermsDraft({ ...termsDraft, excludeNotInTape: e.target.checked })} />Excluir créditos que no están en el loan tape</label>
          </div>
          <button onClick={saveTerms} className="flex items-center gap-1.5 text-xs bg-indigo-600 text-white px-3 py-1.5 rounded-lg font-bold"><Save className="w-3.5 h-3.5" />Guardar términos</button>
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl p-4 space-y-3">
          <p className="text-xs font-black text-slate-700 uppercase tracking-widest">Nuevo corte</p>
          <div className="grid grid-cols-2 gap-3">
            <div><span className={label}>Fecha de corte (loan tape)</span>
              {cutoffs.length ? (
                <select className={inputClass} value={form.cutoff} onChange={e => setForm({ ...form, cutoff: e.target.value })}>{cutoffs.map(c => <option key={c} value={c}>{c}</option>)}</select>
              ) : <input type="date" className={inputClass} value={form.cutoff} onChange={e => setForm({ ...form, cutoff: e.target.value })} />}
            </div>
            <div><span className={label}>Saldo de la deuda a esa fecha</span><input className={inputClass} inputMode="decimal" value={form.debt} onChange={e => setForm({ ...form, debt: e.target.value })} placeholder="$" /></div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <label className="flex items-center gap-1.5 text-xs font-bold text-slate-700 bg-white border border-slate-200 hover:border-indigo-300 px-3 py-1.5 rounded-lg cursor-pointer">
              <Upload className="w-3.5 h-3.5" />{ceded ? 'Cambiar cartera cedida' : 'Subir cartera cedida (opcional)'}
              <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) void readCeded(f); e.target.value = ''; }} />
            </label>
            {ceded && <span className="text-xs text-slate-600">{ceded.fileName}: {ceded.rows.length} créditos <button onClick={() => setCeded(null)} className="text-rose-500 ml-1">quitar</button></span>}
          </div>
          {!cutoffs.length && <p className="text-[11px] text-amber-700 font-semibold">Este cliente no tiene loan tapes cargados: el aforo se calculará solo con la cartera cedida, sin validar contra el loan tape.</p>}
          <input className={inputClass} value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} placeholder="Notas del corte (opcional)" />
          <button onClick={addCut} disabled={!!busy} className="flex items-center gap-1.5 text-xs bg-slate-900 text-white px-3 py-2 rounded-lg font-bold disabled:opacity-40"><Scale className="w-3.5 h-3.5" />Calcular y guardar corte</button>
        </div>
      </div>

      {r && current && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
            {[
              { k: 'Aforo', v: xS(r.ratio), d: r.required !== null ? `Requerido ${xS(r.required)}` : 'Sin requerido' },
              { k: 'Colateral elegible', v: money(r.totals.eligible), d: `${r.rows.filter(x => x.status === 'elegible').length} créditos` },
              { k: 'Deuda', v: money(current.cut.debtBalance), d: `Corte ${current.cut.cutoff}` },
              { k: r.excess !== null && r.excess < 0 ? 'Faltante' : 'Exceso', v: money(r.excess === null ? null : Math.abs(r.excess)), d: 'vs. colateral requerido' },
              { k: 'No elegible por mora', v: money(r.totals.ineligibleDpd), d: `> ${terms.maxDpdEligible} días` },
              { k: 'No están en loan tape', v: money(r.totals.notInTape), d: r.mode === 'cedida' ? `${r.matched}/${r.totals.loans} cruzados` : 'Sin cartera cedida' },
            ].map(t => (
              <div key={t.k} className="bg-white border border-slate-200 rounded-xl p-3">
                <p className="text-[10px] font-black uppercase tracking-wider text-slate-500">{t.k}</p>
                <p className="text-lg font-black text-slate-900 mt-0.5">{t.v}</p>
                <p className="text-[11px] font-semibold text-slate-400 mt-0.5">{t.d}</p>
              </div>
            ))}
          </div>
          <div className={`flex items-center justify-between gap-3 border rounded-xl px-4 py-3 text-sm font-bold ${statusTone}`}>
            <span className="flex items-center gap-2">
              {r.status === 'cumple' ? <CheckCircle2 className="w-4 h-4" /> : r.status === 'incumple' ? <XCircle className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
              {r.status === 'cumple' ? 'Cumple el aforo requerido' : r.status === 'incumple' ? `Incumple: faltan ${money(Math.abs(r.excess || 0))} de colateral elegible` : 'Captura el aforo requerido en los términos para evaluar cumplimiento'}
              {r.mode === 'cedida' && !r.tapeAvailable && ' · sin loan tape de ese corte para validar la cartera cedida'}
            </span>
            <button onClick={exportExcel} className="flex items-center gap-1.5 text-xs bg-white border border-slate-200 text-slate-700 px-3 py-1.5 rounded-lg font-bold"><Download className="w-3.5 h-3.5" />Excel</button>
          </div>

          {(() => {
            const issues = r.rows.filter(x => x.status !== 'elegible' || x.flagBalance).slice(0, 100);
            return issues.length > 0 && (
              <div className="bg-white border border-slate-200 rounded-2xl p-4">
                <p className="text-xs font-black text-slate-700 uppercase tracking-widest mb-2">Créditos a revisar ({r.rows.filter(x => x.status !== 'elegible' || x.flagBalance).length})</p>
                <div className="max-h-80 overflow-auto">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-white"><tr className="text-left text-slate-500"><th className="py-1">Crédito</th><th>Cliente</th><th className="text-right">Saldo cedido</th><th className="text-right">Saldo loan tape</th><th className="text-right">Días atraso</th><th>Motivo</th></tr></thead>
                    <tbody>{issues.map((x, i) => (
                      <tr key={i} className="border-t border-slate-100">
                        <td className="py-1 font-mono">{x.loanId}</td><td>{x.client}</td>
                        <td className="text-right font-mono">{money(x.cededBalance)}</td><td className="text-right font-mono">{money(x.tapeBalance)}</td>
                        <td className="text-right font-mono">{x.dpd ?? '—'}</td>
                        <td className="font-semibold text-rose-700">{x.status === 'no_elegible_mora' ? 'No elegible por mora' : x.status === 'no_en_loan_tape' ? 'No está en el loan tape' : x.status === 'sin_saldo' ? 'Sin saldo' : 'Saldo cedido ≠ loan tape'}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {history.length > 0 && (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <div className="bg-white border border-slate-200 rounded-2xl p-4">
            <p className="text-xs font-black text-slate-700 uppercase tracking-widest mb-2">Histórico de aforo</p>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={history.map(h => ({ corte: h.cut.cutoff, aforo: h.result.ratio }))}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="corte" fontSize={10} />
                <YAxis fontSize={10} tickFormatter={(v: number) => `${v.toFixed(2)}x`} width={40} />
                <Tooltip formatter={(v: number) => xS(v)} />
                {terms.requiredRatio !== null && <ReferenceLine y={terms.requiredRatio} stroke="#ef4444" strokeDasharray="4 4" />}
                <Line dataKey="aforo" stroke="#4f46e5" strokeWidth={2} dot={{ r: 3 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="bg-white border border-slate-200 rounded-2xl p-4">
            <p className="text-xs font-black text-slate-700 uppercase tracking-widest mb-2">Cortes</p>
            <table className="w-full text-xs">
              <thead><tr className="text-left text-slate-500"><th className="py-1">Corte</th><th>Colateral</th><th className="text-right">Deuda</th><th className="text-right">Aforo</th><th>Estatus</th><th /></tr></thead>
              <tbody>{[...history].reverse().map(h => (
                <tr key={h.cut.id} onClick={() => setSelectedCut(h.cut.id)} className={`border-t border-slate-100 cursor-pointer ${current?.cut.id === h.cut.id ? 'bg-indigo-50' : 'hover:bg-slate-50'}`}>
                  <td className="py-1.5 font-bold">{h.cut.cutoff}</td>
                  <td>{h.result.mode === 'cedida' ? 'Cartera cedida' : 'Loan tape'}</td>
                  <td className="text-right font-mono">{money(h.cut.debtBalance)}</td>
                  <td className="text-right font-mono font-black">{xS(h.result.ratio)}</td>
                  <td className={h.result.status === 'cumple' ? 'text-emerald-700 font-bold' : h.result.status === 'incumple' ? 'text-rose-700 font-bold' : 'text-amber-700'}>{h.result.status === 'cumple' ? 'Cumple' : h.result.status === 'incumple' ? 'Incumple' : 'Sin requerido'}</td>
                  <td className="text-right"><button onClick={e => { e.stopPropagation(); void deleteCut(h.cut.id); }} className="text-slate-300 hover:text-rose-500"><Trash2 className="w-3.5 h-3.5" /></button></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
