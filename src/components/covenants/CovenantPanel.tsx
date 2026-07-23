import React, { useState, useEffect, useRef } from 'react';
import { db, Covenant_DB, CovenantAnnotation, FinancialStatement_DB, Transaction } from '../../db/index';
import { Session } from '../../services/auth';
import {
  Plus, ChevronDown, ChevronRight, MessageCircle, Send,
  TrendingUp, CheckCircle, AlertTriangle, XCircle, X, Trash2
} from 'lucide-react';
import { parseNullableFinancialNumber } from '../../lib/numberParsing';
import { getMetric } from '../../lib/financialMetrics';

const nanoid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

interface Props {
  clientId: string;
  session: Session;
  statements: FinancialStatement_DB[];
  onCovenantsChange: (covenants: Covenant_DB[]) => void;
}

type CovenantType = 'financial' | 'hacer' | 'noHacer';

const TYPE_LABELS: Record<CovenantType, string> = {
  financial: 'Financiero',
  hacer: 'Hacer',
  noHacer: 'No Hacer',
};

const TYPE_COLORS: Record<CovenantType, string> = {
  financial: 'bg-blue-100 text-blue-800 border-blue-200',
  hacer: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  noHacer: 'bg-rose-100 text-rose-800 border-rose-200',
};

function evaluateCovenant(cov: Covenant_DB, statements: FinancialStatement_DB[]): { value: number | null; status: 'cumple' | 'alerta' | 'incumple' } {
  if (cov.type !== 'financial' || statements.length === 0) {
    return { value: null, status: 'cumple' };
  }

  const latest = statements[statements.length - 1];
  const m = latest.mappedData;
  let value: number | null = null;

  // Simple formula evaluation
  const formula = cov.formula.toLowerCase();
  if (formula.includes('deuda') && formula.includes('ebitda')) {
    // Route EBITDA through getMetric so it falls back to the raw "utilidad de
    // operación" when mapped_data.ebitda is 0 — otherwise Deuda/EBITDA reads as
    // null for every IFNB whose EBITDA never got computed at ingestion.
    const ebitda = getMetric(latest, 'ebitda');
    const totalDebt = getMetric(latest, 'totalDebt');
    value = ebitda && totalDebt !== null ? totalDebt / ebitda : null;
  } else if (formula.includes('dscr') || (formula.includes('ebitda') && formula.includes('interes'))) {
    const ebitda = getMetric(latest, 'ebitda');
    const interestExpense = getMetric(latest, 'interestExpense');
    value = interestExpense && ebitda !== null ? ebitda / interestExpense : null;
  } else if (formula.includes('corriente') || formula.includes('liquidez')) {
    value = m.currentLiabilities !== 0 ? m.currentAssets / m.currentLiabilities : null;
  } else if (formula.includes('capital') || formula.includes('equity')) {
    value = m.totalAssets !== 0 ? (m.equity / m.totalAssets) * 100 : null;
  }

  if (value === null) return { value: null, status: 'cumple' };

  const threshold = parseNullableFinancialNumber(cov.threshold);
  if (threshold === null) return { value, status: 'cumple' };

  let meets = true;
  switch (cov.operator) {
    case 'gt': meets = value > threshold; break;
    case 'gte': meets = value >= threshold; break;
    case 'lt': meets = value < threshold; break;
    case 'lte': meets = value <= threshold; break;
  }

  const diff = Math.abs((value - threshold) / threshold);
  if (!meets) return { value, status: 'incumple' };
  if (diff < 0.15) return { value, status: 'alerta' }; // within 15% of threshold
  return { value, status: 'cumple' };
}

const StatusBadge: React.FC<{ status: 'cumple' | 'alerta' | 'incumple' }> = ({ status }) => {
  const map = {
    cumple: 'bg-emerald-100 text-emerald-800 border-emerald-200',
    alerta: 'bg-amber-100 text-amber-800 border-amber-200',
    incumple: 'bg-rose-100 text-rose-800 border-rose-200',
  };
  const icons = {
    cumple: <CheckCircle className="w-3 h-3" />,
    alerta: <AlertTriangle className="w-3 h-3" />,
    incumple: <XCircle className="w-3 h-3" />,
  };
  return (
    <span className={`flex items-center gap-1 text-xs font-black px-2.5 py-1 rounded-full border ${map[status]}`}>
      {icons[status]}
      {status.toUpperCase()}
    </span>
  );
};

interface CovenantFormData {
  name: string;
  type: CovenantType;
  formula: string;
  threshold: string;
  operator: 'gt' | 'lt' | 'gte' | 'lte' | 'none';
  description: string;
  transactionId: string;
}

const EMPTY_FORM: CovenantFormData = {
  name: '', type: 'financial', formula: '', threshold: '', operator: 'lte', description: '', transactionId: ''
};

const CovenantPanel: React.FC<Props> = ({ clientId, session, statements, onCovenantsChange }) => {
  const [covenants, setCovenants] = useState<Covenant_DB[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [annotations, setAnnotations] = useState<Record<string, CovenantAnnotation[]>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<CovenantFormData>(EMPTY_FORM);
  const [formSaving, setFormSaving] = useState(false);
  const [noteText, setNoteText] = useState<Record<string, string>>({});
  const [sendingNote, setSendingNote] = useState<string | null>(null);
  const [filter, setFilter] = useState<CovenantType | 'all'>('all');
  const notesEndRef = useRef<HTMLDivElement>(null);

  const loadData = async () => {
    const [covs, txs] = await Promise.all([db.getCovenants(clientId), db.getTransactions(clientId)]);
    setTransactions(txs);
    setCovenants(covs);
    onCovenantsChange(covs);
    // Load annotations for expanded covenant
    const annMap: Record<string, CovenantAnnotation[]> = {};
    for (const cov of covs) {
      annMap[cov.id] = await db.getAnnotations(cov.id);
    }
    setAnnotations(annMap);
  };

  useEffect(() => { loadData(); }, [clientId]);

  useEffect(() => {
    if (expanded && notesEndRef.current) {
      notesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [expanded, annotations]);

  const handleSaveCovenant = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) return;
    setFormSaving(true);
    try {
      await db.createCovenant({
        clientId,
        transactionId: form.transactionId || undefined,
        name: form.name.trim(),
        type: form.type,
        formula: form.formula.trim(),
        threshold: form.threshold.trim(),
        operator: form.operator,
        description: form.description.trim(),
        isCustom: true,
      });
      setForm(EMPTY_FORM);
      setShowForm(false);
      await loadData();
    } catch (err: any) {
      alert(`Error: ${err.message}`);
    } finally {
      setFormSaving(false);
    }
  };

  const handleDeleteCovenant = async (id: string) => {
    if (!confirm('¿Eliminar este covenant?')) return;
    await db.deleteCovenant(id);
    await loadData();
  };

  const saveTransactionLink = async (cov: Covenant_DB, transactionId: string) => {
    await db.updateCovenant(cov.id, { transactionId: transactionId || null } as Partial<Covenant_DB>);
    await loadData();
  };

  const handleSendNote = async (covenantId: string) => {
    const text = noteText[covenantId]?.trim();
    if (!text) return;
    setSendingNote(covenantId);
    try {
      await db.addAnnotation({
        covenantId,
        userId: session.userId,
        userName: session.userName,
        text,
      });
      setNoteText(prev => ({ ...prev, [covenantId]: '' }));
      const anns = await db.getAnnotations(covenantId);
      setAnnotations(prev => ({ ...prev, [covenantId]: anns }));
    } catch (err: any) {
      alert(`Error: ${err.message}`);
    } finally {
      setSendingNote(null);
    }
  };

  const filtered = covenants.filter(c => filter === 'all' || c.type === filter);
  const transactionName = (transactionId?: string) => transactions.find(tx => tx.id === transactionId)?.name || '';
  const grouped: Record<string, Covenant_DB[]> = {};
  for (const cov of filtered) {
    if (!grouped[cov.type]) grouped[cov.type] = [];
    grouped[cov.type].push(cov);
  }

  const inputClass = 'bg-slate-50 border border-slate-200 text-slate-900 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 transition-all w-full';

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-black text-slate-900">Covenants</h2>
          <p className="text-slate-500 text-sm mt-0.5">{covenants.length} covenant{covenants.length !== 1 ? 's' : ''} registrado{covenants.length !== 1 ? 's' : ''}</p>
        </div>
        <button
          onClick={() => setShowForm(true)}
          className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white font-bold px-4 py-2.5 rounded-xl text-sm transition-all"
        >
          <Plus className="w-4 h-4" />
          Nuevo Covenant
        </button>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-2">
        {(['all', 'financial', 'hacer', 'noHacer'] as const).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
              filter === f ? 'bg-slate-900 text-white' : 'bg-white border border-slate-200 text-slate-600 hover:border-slate-300'
            }`}
          >
            {f === 'all' ? 'Todos' : TYPE_LABELS[f]}
            {f !== 'all' && (
              <span className="ml-1 opacity-60">({covenants.filter(c => c.type === f).length})</span>
            )}
          </button>
        ))}
      </div>

      {/* New covenant modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg">
            <div className="flex items-center justify-between p-6 border-b border-slate-100">
              <h3 className="font-black text-slate-900">Nuevo Covenant</h3>
              <button onClick={() => setShowForm(false)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleSaveCovenant} className="p-6 space-y-4">
              <div>
                <label className="text-xs font-bold text-slate-600 uppercase tracking-wider block mb-1.5">Nombre *</label>
                <input className={inputClass} value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} placeholder="Nombre del covenant" required />
              </div>
              {transactions.length > 0 && (
                <div>
                  <label className="text-xs font-bold text-slate-600 uppercase tracking-wider block mb-1.5">Facility / Transacción</label>
                  <select className={inputClass} value={form.transactionId} onChange={e => setForm(p => ({ ...p, transactionId: e.target.value }))}>
                    <option value="">General del cliente</option>
                    {transactions.map(tx => <option key={tx.id} value={tx.id}>{tx.name}</option>)}
                  </select>
                </div>
              )}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-bold text-slate-600 uppercase tracking-wider block mb-1.5">Tipo</label>
                  <select className={inputClass} value={form.type} onChange={e => setForm(p => ({ ...p, type: e.target.value as CovenantType }))}>
                    <option value="financial">Financiero</option>
                    <option value="hacer">Hacer</option>
                    <option value="noHacer">No Hacer</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs font-bold text-slate-600 uppercase tracking-wider block mb-1.5">Operador</label>
                  <select className={inputClass} value={form.operator} onChange={e => setForm(p => ({ ...p, operator: e.target.value as any }))}>
                    <option value="lte">≤ (menor o igual)</option>
                    <option value="gte">≥ (mayor o igual)</option>
                    <option value="lt">&lt; (menor que)</option>
                    <option value="gt">&gt; (mayor que)</option>
                    <option value="none">N/A</option>
                  </select>
                </div>
              </div>
              {form.type === 'financial' && (
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs font-bold text-slate-600 uppercase tracking-wider block mb-1.5">Fórmula</label>
                    <input className={inputClass} value={form.formula} onChange={e => setForm(p => ({ ...p, formula: e.target.value }))} placeholder="ej: Deuda/EBITDA" />
                  </div>
                  <div>
                    <label className="text-xs font-bold text-slate-600 uppercase tracking-wider block mb-1.5">Umbral</label>
                    <input className={inputClass} value={form.threshold} onChange={e => setForm(p => ({ ...p, threshold: e.target.value }))} placeholder="ej: 4.0" />
                  </div>
                </div>
              )}
              <div>
                <label className="text-xs font-bold text-slate-600 uppercase tracking-wider block mb-1.5">Descripción</label>
                <textarea className={inputClass} value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))} placeholder="Descripción detallada del covenant" rows={3} />
              </div>
              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => setShowForm(false)} className="flex-1 py-2.5 rounded-xl border border-slate-200 text-slate-700 text-sm font-bold hover:bg-slate-50">Cancelar</button>
                <button type="submit" disabled={formSaving} className="flex-1 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-black disabled:opacity-60">
                  {formSaving ? 'Guardando...' : 'Guardar'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Empty state */}
      {covenants.length === 0 && (
        <div className="bg-white border border-slate-200 rounded-2xl p-12 text-center">
          <TrendingUp className="w-10 h-10 text-slate-300 mx-auto mb-3" />
          <p className="text-slate-500 font-semibold">Sin covenants registrados</p>
          <p className="text-slate-400 text-sm mt-1">Crea covenants manualmente o impórtalos desde un contrato analizado</p>
        </div>
      )}

      {/* Grouped covenants */}
      {(['financial', 'hacer', 'noHacer'] as CovenantType[]).map(type => {
        const group = grouped[type] || [];
        if (group.length === 0) return null;
        return (
          <div key={type}>
            <h3 className="text-xs font-black text-slate-500 uppercase tracking-widest mb-3">
              {TYPE_LABELS[type]} ({group.length})
            </h3>
            <div className="space-y-3">
              {group.map(cov => {
                const { value, status } = evaluateCovenant(cov, statements);
                const isExpanded = expanded === cov.id;
                const covAnnotations = annotations[cov.id] || [];

                return (
                  <div key={cov.id} className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
                    {/* Covenant header */}
                    <div className="flex items-start gap-4 px-6 py-4">
                      <button
                        onClick={() => setExpanded(isExpanded ? null : cov.id)}
                        className="text-slate-400 hover:text-slate-700 transition-colors mt-0.5"
                      >
                        {isExpanded ? <ChevronDown className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
                      </button>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-3 flex-wrap">
                          <h4 className="font-black text-slate-900 text-sm">{cov.name}</h4>
                          <span className={`text-xs font-black px-2 py-0.5 rounded-full border ${TYPE_COLORS[cov.type]}`}>
                            {TYPE_LABELS[cov.type]}
                          </span>
                          <StatusBadge status={status} />
                          {transactionName(cov.transactionId) && <span className="text-[10px] font-black bg-slate-100 text-slate-700 border border-slate-200 rounded-full px-2 py-0.5">{transactionName(cov.transactionId)}</span>}
                        </div>
                        {cov.type === 'financial' && (
                          <div className="flex items-center gap-3 mt-1 text-xs text-slate-500">
                            {cov.formula && <span className="font-mono bg-slate-100 px-2 py-0.5 rounded">{cov.formula}</span>}
                            {cov.threshold && <span>{cov.operator !== 'none' ? cov.operator : ''} {cov.threshold}</span>}
                            {value !== null && (
                              <span className="font-bold text-slate-800">Valor actual: {value.toFixed(2)}</span>
                            )}
                          </div>
                        )}
                        {cov.description && (
                          <p className="text-xs text-slate-500 mt-1 line-clamp-1">{cov.description}</p>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        {covAnnotations.length > 0 && (
                          <span className="flex items-center gap-1 text-xs text-slate-500">
                            <MessageCircle className="w-3.5 h-3.5" />
                            {covAnnotations.length}
                          </span>
                        )}
                        <button
                          onClick={() => handleDeleteCovenant(cov.id)}
                          className="text-slate-300 hover:text-rose-500 transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>

                    {/* Expanded detail + annotations */}
                    {isExpanded && (
                      <div className="border-t border-slate-100 bg-slate-50">
                        {transactions.length > 0 && (
                          <div className="px-6 py-4 border-b border-slate-100">
                            <label className="text-xs font-bold text-slate-500 uppercase tracking-wider block mb-2">Facility / Transacción</label>
                            <select value={cov.transactionId || ''} onChange={e => saveTransactionLink(cov, e.target.value)} className={inputClass}>
                              <option value="">General del cliente</option>
                              {transactions.map(tx => <option key={tx.id} value={tx.id}>{tx.name}</option>)}
                            </select>
                          </div>
                        )}
                        {/* Description */}
                        {cov.description && (
                          <div className="px-6 py-4 border-b border-slate-100">
                            <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Descripción</p>
                            <p className="text-sm text-slate-700 leading-relaxed">{cov.description}</p>
                          </div>
                        )}

                        {/* Annotations thread */}
                        <div className="px-6 py-4">
                          <p className="text-xs font-black text-slate-500 uppercase tracking-widest mb-4 flex items-center gap-2">
                            <MessageCircle className="w-3.5 h-3.5" />
                            Notas y Seguimiento
                          </p>

                          {covAnnotations.length === 0 ? (
                            <p className="text-xs text-slate-400 text-center py-4">Sin notas aún. Agrega la primera nota abajo.</p>
                          ) : (
                            <div className="space-y-3 mb-4 max-h-64 overflow-y-auto">
                              {covAnnotations.map(ann => {
                                const isMe = ann.userId === session.userId;
                                return (
                                  <div key={ann.id} className={`flex gap-3 ${isMe ? 'flex-row-reverse' : ''}`}>
                                    <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 text-xs font-black ${isMe ? 'bg-indigo-600 text-white' : 'bg-slate-200 text-slate-700'}`}>
                                      {ann.userName.charAt(0).toUpperCase()}
                                    </div>
                                    <div className={`max-w-[80%] ${isMe ? 'items-end' : 'items-start'} flex flex-col`}>
                                      <div className={`px-4 py-2.5 rounded-2xl text-sm ${isMe ? 'bg-indigo-600 text-white rounded-tr-sm' : 'bg-white border border-slate-200 text-slate-800 rounded-tl-sm'}`}>
                                        {ann.text}
                                      </div>
                                      <p className="text-[10px] text-slate-400 mt-1 px-1">
                                        {ann.userName} · {new Date(ann.createdAt).toLocaleDateString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                                      </p>
                                    </div>
                                  </div>
                                );
                              })}
                              <div ref={notesEndRef} />
                            </div>
                          )}

                          {/* Note input */}
                          <div className="flex gap-3">
                            <input
                              type="text"
                              value={noteText[cov.id] || ''}
                              onChange={e => setNoteText(prev => ({ ...prev, [cov.id]: e.target.value }))}
                              onKeyDown={e => e.key === 'Enter' && handleSendNote(cov.id)}
                              placeholder="Agregar nota..."
                              className="flex-1 bg-white border border-slate-200 text-slate-900 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 transition-all"
                            />
                            <button
                              onClick={() => handleSendNote(cov.id)}
                              disabled={!noteText[cov.id]?.trim() || sendingNote === cov.id}
                              className="bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-300 text-white p-2.5 rounded-xl transition-all"
                            >
                              <Send className="w-4 h-4" />
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default CovenantPanel;
