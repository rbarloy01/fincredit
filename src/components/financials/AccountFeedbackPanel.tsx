import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Plus, Save, Trash2, Wrench } from 'lucide-react';
import type { FinancialStatement_DB } from '../../db/index';
import { getMetric, metricLabels } from '../../lib/financialMetrics';
import { accountFeedbackFor, normalizeAccountName, saveAccountFeedback } from '../../lib/accountFeedback';

// Conceptos que alimentan indicadores y covenants: el analista indica qué cuenta del estado es cada uno.
const CONCEPTS = [
  'totalAssets', 'totalLiabilities', 'equity', 'cash', 'loanPortfolio', 'managedPortfolio', 'pastDuePortfolio', 'loanLossReserves',
  'totalDebt', 'banksFundsShortTerm', 'banksFundsLongTerm', 'currentAssets', 'currentLiabilities',
  'revenue', 'interestIncome', 'feeIncome', 'interestExpense', 'adminSellingOperatingExpenses', 'ebitda', 'netIncome',
] as const;

const money = (v: number | null) => (v === null ? '—' : v.toLocaleString('es-MX', { maximumFractionDigits: 0 }));

interface Props {
  clientId: string;
  statements: FinancialStatement_DB[];
  onChanged: () => void;   // recalcular indicadores con la corrección
}

export default function AccountFeedbackPanel({ clientId, statements, onChanged }: Props) {
  const ordered = useMemo(() => [...statements].sort((a, b) => b.periodDate.localeCompare(a.periodDate)), [statements]);
  const [open, setOpen] = useState(false);
  const [stmtId, setStmtId] = useState<string>('');
  const [draft, setDraft] = useState<Record<string, string[]>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const stmt = ordered.find(s => s.id === stmtId) || ordered[0];
  const feedback = accountFeedbackFor(clientId) || {};

  if (!ordered.length) return null;
  const lines = (stmt.rawLineItems || []).filter(i => typeof i.value === 'number');
  const lineOptions = lines.map(i => ({ key: normalizeAccountName(i.name), label: `${i.name} · ${money(i.value as number)}`, type: i.statementType }));
  const current = (concept: string) => draft[concept] ?? feedback[concept] ?? [];

  const save = async (concept: string) => {
    setSaving(concept); setMsg('');
    try {
      await saveAccountFeedback(clientId, concept, current(concept).filter(Boolean));
      setDraft(d => { const n = { ...d }; delete n[concept]; return n; });
      setMsg(`✓ ${metricLabels[concept] || concept}: corrección guardada para todos los periodos de este cliente.`);
      onChanged();
    } catch (e: any) {
      setMsg(`No se pudo guardar: ${e?.message || e}`);
    } finally {
      setSaving(null);
    }
  };

  const corrected = Object.keys(feedback).length;

  return (
    <div className="bg-white border border-slate-200 rounded-2xl">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between px-5 py-4 text-left">
        <span>
          <span className="text-xs font-black text-slate-700 uppercase tracking-widest flex items-center gap-1.5"><Wrench className="w-3.5 h-3.5 text-indigo-600" />Conceptos clave — corregir cuentas</span>
          <span className="block text-xs text-slate-400 mt-0.5">Qué cuenta usa la app para activo, capital, cartera, deuda, ingresos… Si no es la correcta, elige la cuenta y se aplica a todos los periodos del cliente.{corrected ? ` · ${corrected} concepto(s) corregido(s)` : ''}</span>
        </span>
        {open ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}
      </button>
      {open && (
        <div className="border-t border-slate-100 px-5 py-4 space-y-3">
          <label className="flex items-center gap-2 text-xs font-bold text-slate-600">
            Periodo para revisar:
            <select value={stmt.id} onChange={e => setStmtId(e.target.value)} className="border border-slate-200 rounded-lg px-2 py-1 text-xs">
              {ordered.map(s => <option key={s.id} value={s.id}>{s.period}</option>)}
            </select>
          </label>
          {msg && <p className={`text-xs font-semibold ${msg.startsWith('✓') ? 'text-emerald-700' : 'text-rose-600'}`}>{msg}</p>}
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-slate-500">
                  <th className="py-1.5 pr-2 font-black">Concepto</th>
                  <th className="py-1.5 pr-2 font-black text-right">Valor que usa la app</th>
                  <th className="py-1.5 pr-2 font-black">Cuenta(s) correcta(s) del estado</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {CONCEPTS.map(concept => {
                  const chosen = current(concept);
                  const dirty = draft[concept] !== undefined;
                  const isCorrected = (feedback[concept] || []).length > 0;
                  return (
                    <tr key={concept} className="border-t border-slate-100 align-top">
                      <td className="py-2 pr-2 font-bold text-slate-700">{metricLabels[concept] || concept}{isCorrected && <span className="ml-1 text-[9px] font-black text-indigo-600 uppercase">corregido</span>}</td>
                      <td className="py-2 pr-2 text-right font-mono font-black text-slate-900">{money(getMetric(stmt, concept))}</td>
                      <td className="py-2 pr-2 space-y-1 min-w-[320px]">
                        {(chosen.length ? chosen : ['']).map((key, idx) => (
                          <div key={idx} className="flex items-center gap-1">
                            <select
                              value={key}
                              onChange={e => setDraft(d => { const list = [...(d[concept] ?? feedback[concept] ?? [''])]; list[idx] = e.target.value; return { ...d, [concept]: list }; })}
                              className={`w-full border rounded-md px-1.5 py-1 ${dirty ? 'border-indigo-400 bg-indigo-50' : 'border-slate-200'}`}
                            >
                              <option value="">Automático (como lo detecta la app)</option>
                              {key && !lineOptions.some(o => o.key === key) && <option value={key}>{key} (no está en este periodo)</option>}
                              {lineOptions.map((o, i) => <option key={`${o.key}-${i}`} value={o.key}>{o.label}</option>)}
                            </select>
                            {idx > 0 && <button onClick={() => setDraft(d => ({ ...d, [concept]: (d[concept] ?? feedback[concept] ?? []).filter((_, j) => j !== idx) }))} className="text-slate-300 hover:text-rose-500"><Trash2 className="w-3.5 h-3.5" /></button>}
                          </div>
                        ))}
                        {chosen.some(Boolean) && (
                          <button onClick={() => setDraft(d => ({ ...d, [concept]: [...(d[concept] ?? feedback[concept] ?? []), ''] }))} className="flex items-center gap-1 text-[10px] font-black text-indigo-600"><Plus className="w-3 h-3" />Sumar otra cuenta</button>
                        )}
                      </td>
                      <td className="py-2">
                        <button onClick={() => save(concept)} disabled={!dirty || saving === concept} className="flex items-center gap-1 text-[11px] font-black text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-30 px-2 py-1 rounded-md"><Save className="w-3 h-3" />{saving === concept ? '…' : 'Guardar'}</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
