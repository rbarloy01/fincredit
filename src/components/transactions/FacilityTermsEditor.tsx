import React, { useEffect, useState } from 'react';
import { Plus, Save, Trash2, Percent, ShieldCheck } from 'lucide-react';
import { db } from '../../db/index';
import {
  type FacilityTerms, emptyFacilityTerms, effectiveRate, effectiveDefaultRate, RATE_REFERENCES,
} from '../../lib/facilityTerms';
import { KNOWN_INDICATORS, knownIndicatorFormula, knownIndicatorDirection, type LimitUnit } from '../../lib/covenantBuilder';
import type { Covenant_DB } from '../../db/index';

// Interpreta el límite como lo escriba el analista: "30%", "30", "0.30" (=30%), "1.25x", "1,25".
// Devuelve el valor a guardar (fracción si es %) y el texto de cómo quedó, o un error legible.
export function parseLimit(input: string, unit: LimitUnit): { store: string | null; display: string; error: string } {
  const raw = input.trim();
  if (!raw) return { store: null, display: '', error: '' };
  const cleaned = raw.replace(/\s/g, '').replace(/x$/i, '').replace(/,(?=\d{1,2}$)/, '.').replace(/,/g, '');
  const hasPct = cleaned.endsWith('%');
  const n = Number(cleaned.replace('%', ''));
  if (!Number.isFinite(n)) return { store: null, display: '', error: 'No entiendo ese límite: escribe un número, p. ej. 30% o 1.25' };
  if (unit === 'percent') {
    const fraction = hasPct ? n / 100 : n <= 1.5 ? n : n / 100;   // 0.30 → 30%; 30 → 30%
    return { store: String(Math.round(fraction * 1e8) / 1e8), display: `${(fraction * 100).toLocaleString('es-MX', { maximumFractionDigits: 2 })}%`, error: '' };
  }
  return { store: String(n), display: `${n.toLocaleString('es-MX', { maximumFractionDigits: 4 })}x`, error: '' };
}

const OP_TEXT: Record<string, string> = { gte: '≥', gt: '>', lte: '≤', lt: '<' };

const inputClass = 'bg-slate-50 border border-slate-200 text-slate-900 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 w-full';
const label = 'text-[10px] font-black text-slate-500 uppercase tracking-wider block mb-1';

interface Props {
  clientId: string;
  transactionId: string;
  terms: FacilityTerms | undefined;
  onSave: (terms: FacilityTerms) => Promise<void>;
  onCovenantCreated: () => void;
}

// Términos económicos de la facility + alta directa de covenants calculables (alimentan Indicadores Financieros).
export default function FacilityTermsEditor({ clientId, transactionId, terms, onSave, onCovenantCreated }: Props) {
  const [draft, setDraft] = useState<FacilityTerms>(terms || emptyFacilityTerms());
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  // Captura de varios covenants a la vez: un renglón por indicador del contrato.
  type CovRow = { id: string; key: string; operator: string; limit: string };
  const newRow = (key = KNOWN_INDICATORS[0].key): CovRow => {
    const ind = KNOWN_INDICATORS.find(i => i.key === key) || KNOWN_INDICATORS[0];
    return { id: `r${Date.now()}${Math.random().toString(36).slice(2, 6)}`, key: ind.key, operator: knownIndicatorDirection(ind), limit: '' };
  };
  const [rows, setRows] = useState<CovRow[]>([newRow()]);
  const [savingCovs, setSavingCovs] = useState(false);
  const [covMsg, setCovMsg] = useState('');
  const [facilityCovenants, setFacilityCovenants] = useState<Covenant_DB[]>([]);
  const loadFacilityCovenants = () => db.getCovenants(clientId).then(all => setFacilityCovenants(all.filter(c => c.type === 'financial' && c.transactionId === transactionId))).catch(() => undefined);
  useEffect(() => { void loadFacilityCovenants(); }, [clientId, transactionId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setDraft(terms || emptyFacilityTerms()); setDirty(false); }, [terms]);

  const set = (patch: Partial<FacilityTerms>) => { setDraft(d => ({ ...d, ...patch })); setDirty(true); };
  const rate = effectiveRate(draft);
  const moratoria = effectiveDefaultRate(draft);

  const save = async () => {
    setSaving(true);
    try { await onSave({ ...draft, updatedAt: new Date().toISOString() }); setDirty(false); }
    catch (e: any) { alert(`No se pudo guardar: ${e?.message || e}`); }
    finally { setSaving(false); }
  };

  const rowInfo = (r: CovRow) => {
    const ind = KNOWN_INDICATORS.find(i => i.key === r.key)!;
    const parsed = parseLimit(r.limit, ind.unit);
    const existing = facilityCovenants.find(c => c.formula === knownIndicatorFormula(ind));
    return { ind, parsed, existing };
  };

  // Guarda todos los renglones válidos. Si el indicador ya existe en la facility, actualiza su límite (sin duplicar).
  const saveCovenants = async () => {
    const ready = rows.map(r => ({ r, ...rowInfo(r) })).filter(x => x.parsed.store);
    const keys = ready.map(x => x.ind.key);
    if (!ready.length) { setCovMsg('Escribe el límite de al menos un covenant.'); return; }
    if (new Set(keys).size !== keys.length) { setCovMsg('Hay indicadores repetidos en la captura: deja uno por indicador.'); return; }
    setSavingCovs(true); setCovMsg('');
    try {
      let created = 0, updated = 0;
      for (const { r, ind, parsed, existing } of ready) {
        if (existing) {
          await db.updateCovenant(existing.id, { threshold: parsed.store as string, operator: r.operator as any });
          updated += 1;
        } else {
          await db.createCovenant({
            clientId, transactionId, name: ind.label, type: 'financial', formula: knownIndicatorFormula(ind),
            threshold: parsed.store as string, operator: r.operator as any, description: `${ind.hint} · límite del contrato`, isCustom: true,
          });
          created += 1;
        }
      }
      setRows([newRow()]);
      setCovMsg(`✓ ${created} agregado${created === 1 ? '' : 's'}${updated ? `, ${updated} actualizado${updated === 1 ? '' : 's'}` : ''}. Ya se calculan en Indicadores Financieros.`);
      await loadFacilityCovenants();
      onCovenantCreated();
    } catch (e: any) {
      setCovMsg(`No se pudo guardar: ${e?.message || e}`);
    } finally {
      setSavingCovs(false);
    }
  };

  const removeCovenant = async (c: Covenant_DB) => {
    if (!confirm(`¿Eliminar el covenant "${c.name}" de esta facility?`)) return;
    try { await db.deleteCovenant(c.id); await loadFacilityCovenants(); onCovenantCreated(); }
    catch (e: any) { setCovMsg(`No se pudo eliminar: ${e?.message || e}`); }
  };

  const limitLabel = (c: Covenant_DB) => {
    const ind = KNOWN_INDICATORS.find(i => knownIndicatorFormula(i) === c.formula);
    const n = Number(c.threshold);
    if (!c.threshold || !Number.isFinite(n)) return c.threshold || 'sin límite';
    const percent = ind ? ind.unit === 'percent' : Math.abs(n) <= 1.5;
    return `${OP_TEXT[c.operator] || ''} ${percent ? `${(n * 100).toLocaleString('es-MX', { maximumFractionDigits: 2 })}%` : `${n.toLocaleString('es-MX', { maximumFractionDigits: 4 })}x`}`;
  };
  const duplicates = new Set(facilityCovenants.map(c => c.formula).filter((f, i, arr) => f && arr.indexOf(f) !== i));


  return (
    <div className="space-y-4">
      <div className="bg-white border border-slate-200 rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <p className="text-xs font-black text-slate-700 uppercase tracking-widest flex items-center gap-1.5"><Percent className="w-3.5 h-3.5 text-indigo-600" />Términos de la facility</p>
            <p className="text-xs text-slate-400 mt-0.5">{draft.fuente === 'contrato' ? 'Tomados del contrato (revísalos y ajusta si hace falta).' : 'Captura manual o con "Extraer del contrato".'}</p>
          </div>
          <button onClick={save} disabled={!dirty || saving} className="flex items-center gap-1.5 text-xs bg-indigo-600 text-white px-3 py-1.5 rounded-lg hover:bg-indigo-500 disabled:opacity-40 font-bold">
            <Save className="w-3.5 h-3.5" />{saving ? 'Guardando…' : 'Guardar términos'}
          </button>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div><span className={label}>Plazo (meses)</span><input className={inputClass} inputMode="numeric" value={draft.plazoMeses} onChange={e => set({ plazoMeses: e.target.value })} /></div>
          <div><span className={label}>Disposición mínima</span><input className={inputClass} inputMode="decimal" value={draft.disposicionMinima} onChange={e => set({ disposicionMinima: e.target.value })} /></div>
          <div><span className={label}>Plazo de pago por disposición (meses)</span><input className={inputClass} inputMode="numeric" value={draft.plazoDisposicionMeses} onChange={e => set({ plazoDisposicionMeses: e.target.value })} /></div>
          <div><span className={label}>Periodicidad de pago</span><input className={inputClass} value={draft.periodicidadPago} onChange={e => set({ periodicidadPago: e.target.value })} placeholder="mensual, trimestral, al vencimiento" /></div>
        </div>

        <div className="mt-4 border-t border-slate-100 pt-3">
          <div className="flex items-center gap-2 mb-2">
            <span className={label + ' mb-0'}>Tasa ordinaria</span>
            {(['fija', 'variable'] as const).map(t => (
              <button key={t} onClick={() => set({ tasaTipo: t })} className={`text-[11px] font-black px-2 py-0.5 rounded-md border ${draft.tasaTipo === t ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-500 border-slate-200'}`}>{t === 'fija' ? 'Fija' : 'Variable (referencia + puntos)'}</button>
            ))}
          </div>
          {draft.tasaTipo === 'fija' ? (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div><span className={label}>Tasa anual (%)</span><input className={inputClass} inputMode="decimal" value={draft.tasaFija} onChange={e => set({ tasaFija: e.target.value })} /></div>
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <div><span className={label}>Referencia</span>
                <select className={inputClass} value={draft.referencia} onChange={e => set({ referencia: e.target.value })}>
                  {[...new Set([draft.referencia, ...RATE_REFERENCES].filter(Boolean))].map(r => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
              <div><span className={label}>Sobretasa (pp)</span><input className={inputClass} inputMode="decimal" value={draft.sobretasa} onChange={e => set({ sobretasa: e.target.value })} placeholder="ej. 4.5" /></div>
              <div><span className={label}>Piso (% anual)</span><input className={inputClass} inputMode="decimal" value={draft.piso} onChange={e => set({ piso: e.target.value })} /></div>
              <div><span className={label}>Techo (% anual)</span><input className={inputClass} inputMode="decimal" value={draft.techo} onChange={e => set({ techo: e.target.value })} /></div>
              <div><span className={label}>{draft.referencia || 'Referencia'} vigente (%)</span><input className={inputClass} inputMode="decimal" value={draft.referenciaValor} onChange={e => set({ referenciaValor: e.target.value })} placeholder="ej. 7.25" /></div>
            </div>
          )}
          <p className="text-xs mt-2 font-semibold text-slate-600">
            Tasa efectiva: <span className="font-black text-slate-900">{rate.rate === null ? '—' : `${rate.rate.toFixed(2)}%`}</span>
            <span className="text-slate-400"> · {rate.note}</span>
          </p>
        </div>

        <div className="mt-4 border-t border-slate-100 pt-3 grid grid-cols-1 md:grid-cols-4 gap-3">
          <div className="md:col-span-2"><span className={label}>Moratorios (como lo dice el contrato)</span><input className={inputClass} value={draft.moratorioTexto} onChange={e => set({ moratorioTexto: e.target.value })} placeholder="ej. 2 veces la tasa ordinaria" /></div>
          <div><span className={label}>Veces la ordinaria</span><input className={inputClass} inputMode="decimal" value={draft.moratorioFactor} onChange={e => set({ moratorioFactor: e.target.value })} /></div>
          <div><span className={label}>o tasa fija (% anual)</span><input className={inputClass} inputMode="decimal" value={draft.moratorioTasa} onChange={e => set({ moratorioTasa: e.target.value })} /></div>
          <p className="md:col-span-4 text-xs font-semibold text-slate-600">Moratoria efectiva: <span className="font-black text-slate-900">{moratoria === null ? '—' : `${moratoria.toFixed(2)}%`}</span></p>
        </div>

        <div className="mt-4 border-t border-slate-100 pt-3">
          <div className="flex items-center justify-between mb-2">
            <span className={label + ' mb-0'}>Comisiones</span>
            <button onClick={() => set({ comisiones: [...draft.comisiones, { id: `c${Date.now()}`, concepto: '', valor: '', base: '' }] })} className="flex items-center gap-1 text-[11px] font-black text-indigo-600"><Plus className="w-3 h-3" />Agregar comisión</button>
          </div>
          {draft.comisiones.length === 0 ? <p className="text-xs text-slate-400">Sin comisiones capturadas.</p> : (
            <div className="space-y-2">
              {draft.comisiones.map(c => (
                <div key={c.id} className="grid grid-cols-[1fr_120px_1fr_auto] gap-2 items-center">
                  <input className={inputClass} value={c.concepto} onChange={e => set({ comisiones: draft.comisiones.map(x => x.id === c.id ? { ...x, concepto: e.target.value } : x) })} placeholder="Concepto (apertura, disposición, prepago…)" />
                  <input className={inputClass} value={c.valor} onChange={e => set({ comisiones: draft.comisiones.map(x => x.id === c.id ? { ...x, valor: e.target.value } : x) })} placeholder="1% / $50,000" />
                  <input className={inputClass} value={c.base} onChange={e => set({ comisiones: draft.comisiones.map(x => x.id === c.id ? { ...x, base: e.target.value } : x) })} placeholder="Base (sobre el monto dispuesto, única vez…)" />
                  <button onClick={() => set({ comisiones: draft.comisiones.filter(x => x.id !== c.id) })} className="text-slate-300 hover:text-rose-500"><Trash2 className="w-4 h-4" /></button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="mt-4 border-t border-slate-100 pt-3">
          <span className={label}>Otras condiciones económicas</span>
          <textarea className={inputClass} rows={2} value={draft.notas} onChange={e => set({ notas: e.target.value })} />
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-black text-slate-700 uppercase tracking-widest flex items-center gap-1.5"><ShieldCheck className="w-3.5 h-3.5 text-indigo-600" />Covenants financieros de esta facility</p>
            <p className="text-xs text-slate-400 mt-0.5">Captura todos los del contrato y guárdalos juntos. Se calculan en Indicadores Financieros contra los EEFF cargados; si el indicador ya existe, se actualiza su límite.</p>
          </div>
          <button onClick={saveCovenants} disabled={savingCovs} className="flex-shrink-0 flex items-center gap-1.5 text-xs bg-slate-900 text-white px-3 py-2 rounded-lg hover:bg-slate-700 disabled:opacity-40 font-bold"><Save className="w-3.5 h-3.5" />{savingCovs ? 'Guardando…' : 'Guardar covenants'}</button>
        </div>
        <div className="mt-3 space-y-2">
          {rows.map(r => {
            const { ind, parsed, existing } = rowInfo(r);
            return (
              <div key={r.id}>
                <div className="grid grid-cols-1 md:grid-cols-[1fr_120px_150px_auto] gap-2 items-center">
                  <select className={inputClass} value={r.key} onChange={e => { const next = KNOWN_INDICATORS.find(i => i.key === e.target.value)!; setRows(rs => rs.map(x => x.id === r.id ? { ...x, key: next.key, operator: knownIndicatorDirection(next) } : x)); setCovMsg(''); }}>
                    {KNOWN_INDICATORS.map(i => <option key={i.key} value={i.key}>{i.label} — {i.hint}</option>)}
                  </select>
                  <select className={inputClass} value={r.operator} onChange={e => setRows(rs => rs.map(x => x.id === r.id ? { ...x, operator: e.target.value } : x))}>
                    <option value="gte">≥ mínimo</option><option value="gt">&gt; mínimo</option><option value="lte">≤ máximo</option><option value="lt">&lt; máximo</option>
                  </select>
                  <input className={`${inputClass} ${parsed.error ? 'border-rose-300' : ''}`} value={r.limit} onChange={e => { setRows(rs => rs.map(x => x.id === r.id ? { ...x, limit: e.target.value } : x)); setCovMsg(''); }} placeholder={ind.unit === 'percent' ? 'Límite: 30% o 0.30' : 'Límite: 1.25x'} />
                  <button onClick={() => setRows(rs => (rs.length > 1 ? rs.filter(x => x.id !== r.id) : [newRow()]))} className="text-slate-300 hover:text-rose-500 justify-self-end" title="Quitar renglón"><Trash2 className="w-4 h-4" /></button>
                </div>
                <p className={`text-[11px] mt-0.5 font-semibold ${parsed.error ? 'text-rose-600' : 'text-slate-500'}`}>
                  {parsed.error || (parsed.display ? `${ind.label} ${OP_TEXT[r.operator]} ${parsed.display}${existing ? ' · ya existe: se actualizará su límite' : ''}` : '')}
                </p>
              </div>
            );
          })}
        </div>
        <button onClick={() => { const used = new Set(rows.map(r => r.key)); const next = KNOWN_INDICATORS.find(i => !used.has(i.key)) || KNOWN_INDICATORS[0]; setRows(rs => [...rs, newRow(next.key)]); }} className="mt-2 flex items-center gap-1 text-[11px] font-black text-indigo-600"><Plus className="w-3 h-3" />Agregar otro covenant</button>
        {covMsg && <p className={`text-xs mt-2 font-semibold ${covMsg.startsWith('✓') ? 'text-emerald-700' : 'text-rose-600'}`}>{covMsg}</p>}
        {facilityCovenants.length > 0 && (
          <div className="mt-3 border-t border-slate-100 pt-2">
            <p className={label}>Ya guardados</p>
            <ul className="space-y-1">
              {facilityCovenants.map(c => (
                <li key={c.id} className="flex items-center justify-between gap-2 text-xs">
                  <span className="font-semibold text-slate-700">{c.name}{duplicates.has(c.formula) && <span className="ml-1.5 text-[10px] font-black text-amber-600">duplicado</span>}</span>
                  <span className="flex items-center gap-3">
                    <span className="font-mono font-black text-slate-900">{limitLabel(c)}</span>
                    <button onClick={() => removeCovenant(c)} className="text-slate-300 hover:text-rose-500" title="Eliminar covenant"><Trash2 className="w-3.5 h-3.5" /></button>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
