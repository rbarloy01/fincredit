import React, { useEffect, useState } from 'react';
import { Plus, Save, Trash2, Percent, ShieldCheck } from 'lucide-react';
import { db } from '../../db/index';
import {
  type FacilityTerms, emptyFacilityTerms, effectiveRate, effectiveDefaultRate, RATE_REFERENCES,
} from '../../lib/facilityTerms';
import { KNOWN_INDICATORS, knownIndicatorFormula, knownIndicatorDirection, thresholdToStore } from '../../lib/covenantBuilder';

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
  const [cov, setCov] = useState({ key: KNOWN_INDICATORS[0].key, operator: knownIndicatorDirection(KNOWN_INDICATORS[0]) as string, limit: '' });
  const [addingCov, setAddingCov] = useState(false);

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

  const addCovenant = async () => {
    const ind = KNOWN_INDICATORS.find(i => i.key === cov.key);
    if (!ind) return;
    const threshold = thresholdToStore(cov.limit, ind.unit);
    if (!threshold) { alert('Captura el límite del covenant.'); return; }
    setAddingCov(true);
    try {
      await db.createCovenant({
        clientId, transactionId, name: ind.label, type: 'financial', formula: knownIndicatorFormula(ind),
        threshold, operator: cov.operator as any, description: `${ind.hint} · límite del contrato`, isCustom: true,
      });
      setCov(c => ({ ...c, limit: '' }));
      onCovenantCreated();
      alert(`Covenant "${ind.label}" agregado. Ya se calcula en Indicadores Financieros.`);
    } catch (e: any) {
      alert(`No se pudo agregar: ${e?.message || e}`);
    } finally {
      setAddingCov(false);
    }
  };

  const selectedInd = KNOWN_INDICATORS.find(i => i.key === cov.key);

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
        <p className="text-xs font-black text-slate-700 uppercase tracking-widest flex items-center gap-1.5"><ShieldCheck className="w-3.5 h-3.5 text-indigo-600" />Agregar covenant financiero de esta facility</p>
        <p className="text-xs text-slate-400 mt-0.5 mb-3">Se guarda con su fórmula estándar: se empieza a calcular en Indicadores Financieros contra los EEFF cargados.</p>
        <div className="grid grid-cols-1 md:grid-cols-[1fr_120px_140px_auto] gap-2 items-end">
          <div><span className={label}>Indicador</span>
            <select className={inputClass} value={cov.key} onChange={e => { const ind = KNOWN_INDICATORS.find(i => i.key === e.target.value)!; setCov({ key: ind.key, operator: knownIndicatorDirection(ind), limit: cov.limit }); }}>
              {KNOWN_INDICATORS.map(i => <option key={i.key} value={i.key}>{i.label} — {i.hint}</option>)}
            </select>
          </div>
          <div><span className={label}>Condición</span>
            <select className={inputClass} value={cov.operator} onChange={e => setCov({ ...cov, operator: e.target.value })}>
              <option value="gte">≥ mínimo</option><option value="gt">&gt; mínimo</option><option value="lte">≤ máximo</option><option value="lt">&lt; máximo</option>
            </select>
          </div>
          <div><span className={label}>Límite {selectedInd?.unit === 'percent' ? '(%)' : '(veces)'}</span><input className={inputClass} inputMode="decimal" value={cov.limit} onChange={e => setCov({ ...cov, limit: e.target.value })} placeholder={selectedInd?.unit === 'percent' ? 'ej. 15' : 'ej. 1.25'} /></div>
          <button onClick={addCovenant} disabled={addingCov} className="flex items-center gap-1.5 text-xs bg-slate-900 text-white px-3 py-2 rounded-lg hover:bg-slate-700 disabled:opacity-40 font-bold"><Plus className="w-3.5 h-3.5" />{addingCov ? 'Agregando…' : 'Agregar'}</button>
        </div>
      </div>
    </div>
  );
}
