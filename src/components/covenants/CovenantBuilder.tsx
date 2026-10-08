import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronLeft, ChevronRight, Search, X } from 'lucide-react';
import type { FinancialStatement_DB, Transaction } from '../../db/index';
import {
  KNOWN_INDICATORS, draftErrors, knownIndicatorDirection, knownIndicatorFormula, knownIndicatorValues, limitSentence, previewDraft, formatUnit,
  type BuilderDraft, type KnownIndicator, type LimitKind, type LimitUnit, type PreviewRow,
} from '../../lib/covenantBuilder';
import { parseFormulaText } from '../../lib/formulaText';
import { parseNullableFinancialNumber } from '../../lib/numberParsing';

// Guided covenant builder: 1) what to measure  2) what is the limit  3) review and save — with a live per-period preview
// so the analyst sees real numbers BEFORE saving, instead of assembling a formula blind.

export interface CovenantBuilderSave extends BuilderDraft { transactionId: string; description: string; isContract: boolean }

interface Props {
  statements: FinancialStatement_DB[];
  accountOpts: Array<{ key: string; label: string }>;
  mappedOpts: Array<{ key: string; label: string }>;
  transactions: Transaction[];
  monitored: boolean;
  initialTransactionId?: string;
  saving: boolean;
  onSave: (payload: CovenantBuilderSave) => void | Promise<void>;
  onClose: () => void;
}

interface RefOption { ref: string; label: string; group: string }
type Mode = 'known' | 'ratio' | 'free' | 'text';

const MODES: Array<{ id: Mode; title: string; hint: string }> = [
  { id: 'known', title: 'Indicador conocido', hint: 'ICAP, DSCR, apalancamiento… listos para usar' },
  { id: 'ratio', title: 'Una cuenta entre otra', hint: 'A ÷ B, la forma más común' },
  { id: 'text', title: 'Escribirlo con palabras', hint: '«deuda total entre ebitda»' },
  { id: 'free', title: 'Fórmula libre', hint: 'Suma, resta y paréntesis' },
];
const OPS: Array<[string, string]> = [['+', '+'], ['-', '−'], ['*', '×'], ['/', '÷'], ['^', '^'], ['(', '('], [')', ')']];
const norm = (v: string) => v.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

const STATUS_STYLE: Record<PreviewRow['status'], { label: string; cls: string }> = {
  cumple: { label: 'Cumple', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  alerta: { label: 'Alerta', cls: 'bg-amber-50 text-amber-800 border-amber-200' },
  incumple: { label: 'Incumple', cls: 'bg-rose-50 text-rose-700 border-rose-200' },
  sin_limite: { label: 'Seguimiento', cls: 'bg-slate-50 text-slate-500 border-slate-200' },
  sin_dato: { label: 'Sin dato', cls: 'bg-slate-100 text-slate-500 border-slate-200' },
};

const inputCls = 'w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-400';

const RefPicker: React.FC<{ value: string; onChange: (ref: string) => void; options: RefOption[]; placeholder: string }> = ({ value, onChange, options, placeholder }) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const q = norm(query);
  const shown = options.filter(o => !q || q.split(' ').every(w => norm(o.label).includes(w))).slice(0, 60);
  const groups = [...new Set(shown.map(o => o.group))];
  const selected = options.find(o => o.ref === value);
  return (
    <div ref={box} className="relative">
      <button type="button" onClick={() => setOpen(v => !v)} className={`${inputCls} flex items-center justify-between text-left ${selected ? '' : 'text-slate-400'}`}>
        <span className="truncate">{selected ? selected.label : placeholder}</span><ChevronDown className="h-4 w-4 flex-shrink-0 text-slate-400" />
      </button>
      {open && (
        <div className="absolute z-20 mt-1 w-full rounded-xl border border-slate-200 bg-white p-2 shadow-xl">
          <div className="flex items-center gap-2 rounded-lg border border-slate-200 px-2 py-1.5"><Search className="h-3.5 w-3.5 text-slate-400" /><input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder="Buscar cuenta o métrica…" className="w-full bg-transparent text-sm outline-none" /></div>
          <div className="mt-1 max-h-64 overflow-y-auto">
            {shown.length === 0 && <p className="px-2 py-3 text-xs font-semibold text-slate-400">Sin coincidencias.</p>}
            {groups.map(g => (
              <div key={g}>
                <p className="px-2 pb-1 pt-2 text-[10px] font-black uppercase tracking-widest text-slate-400">{g}</p>
                {shown.filter(o => o.group === g).map(o => (
                  <button key={o.ref} type="button" onClick={() => { onChange(o.ref); setOpen(false); setQuery(''); }} className={`block w-full rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-indigo-50 ${o.ref === value ? 'bg-indigo-50 font-black text-indigo-700' : 'text-slate-700'}`}>{o.label}</button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

const CovenantBuilder: React.FC<Props> = ({ statements, accountOpts, mappedOpts, transactions, monitored, initialTransactionId = '', saving, onSave, onClose }) => {
  const [step, setStep] = useState(0);
  const [mode, setMode] = useState<Mode>('known');
  const [known, setKnown] = useState<KnownIndicator | null>(null);
  const [numer, setNumer] = useState('');
  const [denom, setDenom] = useState('');
  const [tokens, setTokens] = useState<string[]>([]);
  const [text, setText] = useState('');
  const [numberInput, setNumberInput] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<LimitKind | null>(null);
  const [limit, setLimit] = useState('');
  const [unit, setUnit] = useState<LimitUnit>('number');
  const [more, setMore] = useState(false);
  const [description, setDescription] = useState('');
  const [transactionId, setTransactionId] = useState(initialTransactionId);
  const [isContract, setIsContract] = useState(true);

  const options = useMemo<RefOption[]>(() => [
    ...mappedOpts.map(o => ({ ref: o.key, label: o.label.replace(/^Mapped:\s*/, '').replace(/^Concepto:\s*/, ''), group: o.key.startsWith('concept:') ? 'Conceptos definidos' : 'Métricas clave' })),
    ...accountOpts.map(o => ({ ref: `account:${o.key}`, label: o.label, group: 'Cuentas del estado financiero' })),
  ], [mappedOpts, accountOpts]);
  const labelOf = (ref: string) => options.find(o => o.ref === ref)?.label || ref;
  const aliases = useMemo(() => options.map(o => ({ key: o.ref, label: o.label })), [options]);
  const values = useMemo(() => knownIndicatorValues(statements), [statements]);

  const formula = mode === 'known'
    ? (known ? knownIndicatorFormula(known) : '')
    : mode === 'ratio'
      ? (numer && denom ? `expr:${JSON.stringify([`ref:${numer}`, '/', `ref:${denom}`])}` : '')
      : (tokens.length ? `expr:${JSON.stringify(tokens)}` : '');
  const suggestedName = mode === 'known' ? known?.label || '' : mode === 'ratio' && numer && denom ? `${labelOf(numer)} / ${labelOf(denom)}` : '';
  const draft: BuilderDraft = { name, formula, kind: kind ?? 'none', limit, unit, description };
  const preview = useMemo(() => previewDraft(draft, statements, monitored), [name, formula, kind, limit, unit, statements, monitored]); // eslint-disable-line react-hooks/exhaustive-deps
  const textParse = useMemo(() => (text.trim() ? parseFormulaText(text, aliases, s => parseNullableFinancialNumber(s)) : null), [text, aliases]);
  const latest = preview.rows.at(-1);

  const pickKnown = (ind: KnownIndicator) => {
    setKnown(ind); setUnit(ind.unit); setKind(prev => prev ?? knownIndicatorDirection(ind));
    if (!name || name === known?.label) setName(ind.label);
  };
  const addToken = (t: string) => setTokens(prev => [...prev, t]);
  const tokenLabel = (t: string) => (t.startsWith('ref:') ? labelOf(t.slice(4)) : t.startsWith('num:') ? t.slice(4) : OPS.find(([k]) => k === t)?.[1] || t);

  const canNext = step === 0 ? !!formula && preview.computable : step === 1 ? kind !== null && (kind === 'none' || !!limit.trim()) : true;
  const errors = draftErrors({ ...draft, kind: kind ?? 'none' });
  const goNext = () => {
    if (step === 0 && !name.trim() && suggestedName) setName(suggestedName);
    if (step === 1 && kind === 'none') setIsContract(false);
    setStep(s => Math.min(2, s + 1));
  };
  const unitWarning = unit === 'number' && kind && kind !== 'none' && Number(limit) > 3 && /%|capital|roa|roe|margen|margin|rentabilidad|eficiencia/i.test(`${name} ${formula}`)
    ? 'Por su nombre o cuentas, el sistema podría leer límites mayores a 3 como porcentaje. Si es un porcentaje, cambia la unidad a %.' : '';

  const KIND_CARDS: Array<{ id: LimitKind; title: string; sub: string }> = [
    { id: 'gte', title: 'Debe ser al menos', sub: 'p. ej. ICAP ≥ 15%' },
    { id: 'lte', title: 'Debe ser como máximo', sub: 'p. ej. Apalancamiento ≤ 4x' },
    { id: 'none', title: 'Solo seguimiento', sub: 'sin límite: no se marca incumplimiento' },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label="Nuevo covenant financiero">
      <div className="flex max-h-[94vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <header className="flex items-center justify-between border-b border-slate-100 px-6 py-4">
          <div>
            <h3 className="font-black text-slate-900">Nuevo covenant financiero</h3>
            <div className="mt-2 flex items-center gap-2 text-[11px] font-black uppercase tracking-widest">
              {['Qué medir', 'Cuál es el límite', 'Revisar y guardar'].map((t, i) => (
                <React.Fragment key={t}>
                  {i > 0 && <span className="text-slate-300">›</span>}
                  <button type="button" disabled={i > step} onClick={() => setStep(i)} className={i === step ? 'text-indigo-600' : i < step ? 'text-emerald-600' : 'text-slate-300'}>{i < step ? '✓ ' : `${i + 1}. `}{t}</button>
                </React.Fragment>
              ))}
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700" aria-label="Cerrar"><X className="h-5 w-5" /></button>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-[1fr_340px]">
          <div className="space-y-5 p-6">
            {step === 0 && (
              <>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {MODES.map(m => (
                    <button key={m.id} type="button" onClick={() => setMode(m.id)} className={`rounded-xl border p-3 text-left transition-colors ${mode === m.id ? 'border-indigo-400 bg-indigo-50' : 'border-slate-200 hover:bg-slate-50'}`}>
                      <p className={`text-[13px] font-black ${mode === m.id ? 'text-indigo-700' : 'text-slate-800'}`}>{m.title}</p>
                      <p className="mt-0.5 text-[11px] font-semibold leading-snug text-slate-500">{m.hint}</p>
                    </button>
                  ))}
                </div>

                {mode === 'known' && (
                  <div className="space-y-4">
                    {[...new Set(KNOWN_INDICATORS.map(i => i.group))].map(group => (
                      <div key={group}>
                        <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">{group}</p>
                        <div className="mt-1.5 grid grid-cols-1 gap-2 sm:grid-cols-2">
                          {KNOWN_INDICATORS.filter(i => i.group === group).map(ind => (
                            <button key={ind.key} type="button" onClick={() => pickKnown(ind)} className={`flex items-center justify-between gap-3 rounded-xl border px-3 py-2.5 text-left ${known?.key === ind.key ? 'border-indigo-400 bg-indigo-50' : 'border-slate-200 hover:bg-slate-50'}`}>
                              <span className="min-w-0"><span className="block truncate text-[13px] font-black text-slate-900">{ind.label}</span><span className="block truncate text-[11px] font-semibold text-slate-500">{ind.hint}</span></span>
                              <span className="flex-shrink-0 font-mono text-xs font-black text-slate-700">{formatUnit(values[ind.key] ?? null, ind.unit)}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                    {latest && <p className="text-[11px] font-semibold text-slate-400">El número de cada tarjeta es el valor actual ({latest.period.length ? statements.at(-1)?.period : ''}) con las cuentas de este cliente.</p>}
                  </div>
                )}

                {mode === 'ratio' && (
                  <div className="space-y-3">
                    <div><label className="mb-1.5 block text-xs font-black uppercase tracking-wider text-slate-500">Arriba (numerador)</label><RefPicker value={numer} onChange={setNumer} options={options} placeholder="Elige una cuenta o métrica, p. ej. Deuda total" /></div>
                    <p className="text-center text-lg font-black text-slate-300">÷</p>
                    <div><label className="mb-1.5 block text-xs font-black uppercase tracking-wider text-slate-500">Abajo (denominador)</label><RefPicker value={denom} onChange={setDenom} options={options} placeholder="Elige una cuenta o métrica, p. ej. EBITDA" /></div>
                  </div>
                )}

                {mode === 'text' && (
                  <div className="space-y-3">
                    <textarea value={text} onChange={e => setText(e.target.value)} rows={3} placeholder="Ej: deuda total entre ebitda · (activo corriente menos inventarios) entre pasivo corriente" className={inputCls} />
                    {textParse && (
                      <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                        <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Así lo entendí</p>
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {textParse.tokens.map((t, i) => <span key={i} className={`rounded-md px-2 py-1 text-xs font-black ${t.startsWith('ref:') ? 'bg-indigo-100 text-indigo-800' : t.startsWith('num:') ? 'bg-amber-100 text-amber-800' : 'bg-slate-200 text-slate-700'}`}>{tokenLabel(t)}</span>)}
                          {textParse.missing.map(w => <span key={w} className="rounded-md bg-rose-100 px-2 py-1 text-xs font-black text-rose-700">«{w}» no existe</span>)}
                        </div>
                        <button type="button" disabled={!!textParse.missing.length || !textParse.tokens.length} onClick={() => { setTokens(textParse.tokens); setMode('free'); }} className="mt-3 rounded-lg bg-slate-900 px-3 py-2 text-xs font-black text-white disabled:opacity-40">Usar esta fórmula y ajustarla</button>
                        {textParse.missing.length > 0 && <p className="mt-2 text-[11px] font-semibold text-rose-600">Escribe el nombre como aparece en el estado, o búscalo en «Fórmula libre».</p>}
                      </div>
                    )}
                  </div>
                )}

                {mode === 'free' && (
                  <div className="space-y-3">
                    <div className="min-h-[52px] rounded-xl border border-slate-300 bg-white p-2">
                      {tokens.length === 0 ? <p className="px-1 py-2 text-sm font-semibold text-slate-400">Agrega cuentas, números y operadores. Toca una pieza para quitarla.</p> : (
                        <div className="flex flex-wrap items-center gap-1.5">{tokens.map((t, i) => (
                          <button key={i} type="button" onClick={() => setTokens(prev => prev.filter((_, j) => j !== i))} title="Quitar" className={`rounded-md px-2 py-1 text-xs font-black hover:line-through ${t.startsWith('ref:') ? 'bg-indigo-100 text-indigo-800' : t.startsWith('num:') ? 'bg-amber-100 text-amber-800' : 'bg-slate-200 text-slate-700'}`}>{tokenLabel(t)}</button>
                        ))}</div>
                      )}
                    </div>
                    <RefPicker value="" onChange={ref => addToken(`ref:${ref}`)} options={options} placeholder="+ Agregar una cuenta o métrica" />
                    <div className="flex flex-wrap items-center gap-2">
                      {OPS.map(([op, label]) => <button key={op} type="button" onClick={() => addToken(op)} className="h-9 min-w-9 rounded-lg border border-slate-300 bg-white px-3 text-sm font-black text-slate-700 hover:bg-slate-50">{label}</button>)}
                      <input value={numberInput} onChange={e => setNumberInput(e.target.value)} placeholder="número" className="h-9 w-24 rounded-lg border border-slate-200 bg-white px-2 text-sm font-mono" />
                      <button type="button" onClick={() => { const n = parseNullableFinancialNumber(numberInput); if (n !== null) { addToken(`num:${n}`); setNumberInput(''); } }} className="h-9 rounded-lg border border-slate-300 bg-white px-3 text-xs font-black text-slate-700 hover:bg-slate-50">Agregar número</button>
                      <span className="flex-1" />
                      <button type="button" onClick={() => setTokens(prev => prev.slice(0, -1))} className="h-9 rounded-lg border border-slate-200 px-3 text-xs font-black text-slate-500 hover:bg-slate-50">Deshacer</button>
                      <button type="button" onClick={() => setTokens([])} className="h-9 rounded-lg border border-rose-200 px-3 text-xs font-black text-rose-600 hover:bg-rose-50">Limpiar</button>
                    </div>
                  </div>
                )}
              </>
            )}

            {step === 1 && (
              <div className="space-y-5">
                <div>
                  <p className="mb-2 text-xs font-black uppercase tracking-wider text-slate-500">¿Qué exige el contrato?</p>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                    {KIND_CARDS.map(c => (
                      <button key={c.id} type="button" onClick={() => setKind(c.id)} className={`rounded-xl border p-3 text-left ${kind === c.id ? 'border-indigo-400 bg-indigo-50' : 'border-slate-200 hover:bg-slate-50'}`}>
                        <p className={`text-[13px] font-black ${kind === c.id ? 'text-indigo-700' : 'text-slate-800'}`}>{c.title}</p><p className="mt-0.5 text-[11px] font-semibold text-slate-500">{c.sub}</p>
                      </button>
                    ))}
                  </div>
                  <button type="button" onClick={() => setMore(v => !v)} className="mt-2 text-[11px] font-bold text-slate-400 hover:text-slate-600">{more ? 'Ocultar' : 'Más opciones (estrictamente mayor o menor)'}</button>
                  {more && <div className="mt-2 flex gap-2">{(['gt', 'lt'] as const).map(k => <button key={k} type="button" onClick={() => setKind(k)} className={`rounded-lg border px-3 py-1.5 text-xs font-black ${kind === k ? 'border-indigo-400 bg-indigo-50 text-indigo-700' : 'border-slate-200 text-slate-600'}`}>{k === 'gt' ? 'Mayor que (>)' : 'Menor que (<)'}</button>)}</div>}
                </div>
                {kind && kind !== 'none' && (
                  <div>
                    <p className="mb-2 text-xs font-black uppercase tracking-wider text-slate-500">Valor del límite</p>
                    <div className="flex items-center gap-2">
                      <input value={limit} onChange={e => setLimit(e.target.value)} placeholder={unit === 'percent' ? '15' : '4.0'} inputMode="decimal" className={`${inputCls} max-w-[160px] font-mono text-base`} />
                      <div className="flex overflow-hidden rounded-xl border border-slate-200">
                        {(['percent', 'number'] as const).map(u => <button key={u} type="button" onClick={() => setUnit(u)} className={`px-4 py-2.5 text-sm font-black ${unit === u ? 'bg-indigo-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>{u === 'percent' ? '%' : 'veces (x)'}</button>)}
                      </div>
                      {latest && latest.value !== null && <span className="text-xs font-semibold text-slate-400">Hoy: <span className="font-mono font-black text-slate-600">{formatUnit(latest.value, unit)}</span></span>}
                    </div>
                    {unitWarning && <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-800">{unitWarning}</p>}
                  </div>
                )}
                {kind && <p className="rounded-xl bg-indigo-50 px-4 py-3 text-sm font-bold text-indigo-900">{limitSentence(name || suggestedName, kind, limit, unit)}</p>}
              </div>
            )}

            {step === 2 && (
              <div className="space-y-4">
                <div><label className="mb-1.5 block text-xs font-black uppercase tracking-wider text-slate-500">Nombre *</label><input className={inputCls} value={name} onChange={e => setName(e.target.value)} placeholder="ej: Razón de Apalancamiento" /></div>
                {transactions.length > 0 && (
                  <div><label className="mb-1.5 block text-xs font-black uppercase tracking-wider text-slate-500">Facility / transacción</label>
                    <select className={inputCls} value={transactionId} onChange={e => setTransactionId(e.target.value)}><option value="">General del cliente</option>{transactions.map(tx => <option key={tx.id} value={tx.id}>{tx.name}</option>)}</select></div>
                )}
                <div><label className="mb-1.5 block text-xs font-black uppercase tracking-wider text-slate-500">Descripción (opcional)</label><textarea className={inputCls} rows={2} value={description} onChange={e => setDescription(e.target.value)} placeholder="Cláusula o descripción del covenant según contrato" /></div>
                {kind !== 'none' && <label className="flex items-center gap-2 text-sm font-bold text-slate-700"><input type="checkbox" checked={isContract} onChange={e => setIsContract(e.target.checked)} />Es un covenant del contrato (aparece primero en el análisis)</label>}
                <p className="rounded-xl bg-indigo-50 px-4 py-3 text-sm font-bold text-indigo-900">{limitSentence(name, kind ?? 'none', limit, unit)}</p>
                {errors.length > 0 && <ul className="space-y-1">{errors.map(e => <li key={e} className="text-xs font-bold text-rose-600">• {e}</li>)}</ul>}
              </div>
            )}
          </div>

          <aside className="border-t border-slate-100 bg-slate-50 p-5 lg:border-l lg:border-t-0">
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Vista previa con tus estados</p>
            {!formula ? <p className="mt-3 text-xs font-semibold text-slate-400">Elige qué medir y aquí verás el valor en cada periodo antes de guardar.</p> : (
              <>
                <p className="mt-2 truncate text-sm font-black text-slate-900">{name || suggestedName || 'Indicador'}</p>
                <div className="mt-2 overflow-hidden rounded-xl border border-slate-200 bg-white">
                  {preview.rows.length === 0 && <p className="px-3 py-3 text-xs font-semibold text-slate-400">Sin estados financieros.</p>}
                  {preview.rows.map(r => (
                    <div key={r.period} className="flex items-center justify-between gap-2 border-b border-slate-100 px-3 py-2 last:border-0">
                      <span className="truncate text-xs font-bold text-slate-600">{r.period}</span>
                      <span className="font-mono text-xs font-black text-slate-900">{r.display}</span>
                      <span className={`rounded-full border px-2 py-0.5 text-[9px] font-black uppercase tracking-wider ${STATUS_STYLE[r.status].cls}`}>{STATUS_STYLE[r.status].label}</span>
                    </div>
                  ))}
                </div>
                {preview.warnings.map(w => <p key={w} className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] font-bold leading-snug text-amber-800">{w}</p>)}
                {!monitored && <p className="mt-2 text-[11px] font-semibold text-slate-400">Cliente sin monitoreo: no se marcan alertas ni incumplimientos.</p>}
              </>
            )}
          </aside>
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-slate-100 px-6 py-4">
          <button type="button" onClick={step === 0 ? onClose : () => setStep(s => s - 1)} className="flex items-center gap-1 rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-bold text-slate-700 hover:bg-slate-50">{step === 0 ? 'Cancelar' : <><ChevronLeft className="h-4 w-4" />Atrás</>}</button>
          {step < 2
            ? <button type="button" disabled={!canNext} onClick={goNext} title={!canNext && step === 0 && formula ? 'La fórmula no da resultado con los estados de este cliente' : undefined} className="flex items-center gap-1 rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-black text-white hover:bg-indigo-500 disabled:opacity-40">Siguiente<ChevronRight className="h-4 w-4" /></button>
            : <button type="button" disabled={saving || errors.length > 0} onClick={() => void onSave({ ...draft, kind: kind ?? 'none', transactionId, description, isContract: kind !== 'none' && isContract })} className="flex items-center gap-1.5 rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-black text-white hover:bg-indigo-500 disabled:opacity-40"><Check className="h-4 w-4" />{saving ? 'Guardando…' : 'Guardar covenant'}</button>}
        </footer>
      </div>
    </div>
  );
};

export default CovenantBuilder;
