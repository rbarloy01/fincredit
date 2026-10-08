import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useClientMonitored } from '../clients/MonitoringContext';
import { db, Covenant_DB, CovenantAnnotation, Transaction } from '../../db/index';
import { Session } from '../../services/auth';
import { Plus, ChevronDown, ChevronRight, MessageCircle, Send, CheckCircle, XCircle, Clock, X, Trash2, ListChecks, Download, FileText, FileCheck2, MinusCircle, Pencil } from 'lucide-react';
import { loadExportModule } from '../../lib/exportLoader';
import {
  type ComplianceLog, type MonthlyEntry, type MonthlyStatus,
  loadComplianceLog, saveComplianceEntries, latestStatus, summarizeMonth, breachStreak,
  defaultMonth, monthsEndingAt, monthLabel,
} from '../../lib/covenantCompliance';

const nanoid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

interface Props {
  clientId: string;
  clientName?: string;
  transactions?: Transaction[];
  session: Session;
  onCovenantsChange: (covenants: Covenant_DB[]) => void;
}

type CellStatus = MonthlyStatus | 'pendiente';

const STATUS_STYLE: Record<CellStatus, { badge: string; dot: string; label: string; icon: React.ReactNode }> = {
  cumple: { badge: 'bg-emerald-100 text-emerald-800 border-emerald-200', dot: 'bg-emerald-500', label: 'CUMPLE', icon: <CheckCircle className="w-3 h-3" /> },
  incumple: { badge: 'bg-rose-100 text-rose-800 border-rose-200', dot: 'bg-rose-500', label: 'INCUMPLE', icon: <XCircle className="w-3 h-3" /> },
  na: { badge: 'bg-slate-100 text-slate-500 border-slate-200', dot: 'bg-slate-300', label: 'N.A.', icon: <MinusCircle className="w-3 h-3" /> },
  pendiente: { badge: 'bg-amber-50 text-amber-700 border-amber-200', dot: 'bg-white border border-slate-300', label: 'PENDIENTE', icon: <Clock className="w-3 h-3" /> },
};

const StatusBadge: React.FC<{ status: CellStatus }> = ({ status }) => {
  const monitored = useClientMonitored();
  if (!monitored && status === 'incumple') {
    return <span className="flex items-center gap-1 text-xs font-black px-2.5 py-1 rounded-full border bg-slate-100 text-slate-500 border-slate-200">SIN MONITOREO</span>;
  }
  const st = STATUS_STYLE[status];
  return <span className={`flex items-center gap-1 text-xs font-black px-2.5 py-1 rounded-full border ${st.badge}`}>{st.icon}{st.label}</span>;
};

// Cumple / Incumple / N.A. del mes seleccionado. Volver a dar clic al activo lo regresa a pendiente.
const MonthToggle: React.FC<{ status: CellStatus; onChange: (s: MonthlyStatus | null) => void }> = ({ status, onChange }) => {
  const monitored = useClientMonitored();
  // Dormant / cerrado: no se puede marcar incumplimiento.
  const options: MonthlyStatus[] = monitored ? ['cumple', 'incumple', 'na'] : ['cumple', 'na'];
  const colors: Record<MonthlyStatus, [string, string]> = {
    cumple: ['bg-emerald-600 text-white border-emerald-600', 'hover:border-emerald-300'],
    incumple: ['bg-rose-600 text-white border-rose-600', 'hover:border-rose-300'],
    na: ['bg-slate-600 text-white border-slate-600', 'hover:border-slate-400'],
  };
  return (
    <div className="flex gap-1">
      {options.map(opt => {
        const active = status === opt;
        return (
          <button key={opt} onClick={() => onChange(active ? null : opt)} title={active ? 'Quitar (regresa a pendiente)' : undefined}
            className={`px-2.5 py-1 rounded-lg text-[11px] font-bold border transition-all ${active ? colors[opt][0] : `bg-white text-slate-500 border-slate-200 ${colors[opt][1]}`}`}>
            {opt === 'cumple' ? '✓ Cumple' : opt === 'incumple' ? '✗ Incumple' : 'N.A.'}
          </button>
        );
      })}
    </div>
  );
};

interface FormData {
  name: string;
  type: 'hacer' | 'noHacer';
  description: string;
  transactionId: string;
}

const EMPTY: FormData = { name: '', type: 'hacer', description: '', transactionId: '' };

const inputClass = 'bg-slate-50 border border-slate-200 text-slate-900 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 transition-all w-full';

const HacerNoHacerPanel: React.FC<Props> = ({ clientId, clientName = '', transactions = [], session, onCovenantsChange }) => {
  const [covenants, setCovenants] = useState<Covenant_DB[]>([]);
  const [annotations, setAnnotations] = useState<Record<string, CovenantAnnotation[]>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormData>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [noteText, setNoteText] = useState<Record<string, string>>({});
  const [sendingNote, setSendingNote] = useState<string | null>(null);
  const [exporting, setExporting] = useState<'excel' | 'pdf' | null>(null);
  const [log, setLog] = useState<ComplianceLog>({});
  const [month, setMonth] = useState<string>(defaultMonth());
  const [contractFilter, setContractFilter] = useState<string>('all');
  const [cert, setCert] = useState<{ scope: string; reference: string; breached: Record<string, string> } | null>(null);
  const [savingCompliance, setSavingCompliance] = useState(false);
  const monitored = useClientMonitored();
  const notesEndRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const handleExport = async (format: 'excel' | 'pdf') => {
    setExporting(format);
    try {
      const { exportHacerNoHacer } = await loadExportModule();
      await exportHacerNoHacer(covenants, clientName, format, format === 'pdf' ? panelRef.current ?? undefined : undefined, { log, month, transactionNames: Object.fromEntries(transactions.map(tx => [tx.id, tx.name])) });
    } finally {
      setExporting(null);
    }
  };

  const loadData = async () => {
    const [all, savedLog] = await Promise.all([db.getCovenants(clientId), loadComplianceLog(clientId)]);
    setLog(savedLog);
    const filtered = all.filter(c => c.type === 'hacer' || c.type === 'noHacer');
    setCovenants(filtered);
    onCovenantsChange(all);
    const annMap: Record<string, CovenantAnnotation[]> = {};
    for (const cov of filtered) annMap[cov.id] = await db.getAnnotations(cov.id);
    setAnnotations(annMap);
  };

  useEffect(() => { loadData(); }, [clientId]);

  useEffect(() => {
    if (expanded && notesEndRef.current) notesEndRef.current.scrollIntoView({ behavior: 'smooth' });
  }, [expanded, annotations]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      await db.createCovenant({ clientId, transactionId: form.transactionId || undefined, name: form.name.trim(), type: form.type, formula: '', threshold: '', operator: 'none', description: form.description.trim(), isCustom: true });
      setForm(EMPTY);
      setShowForm(false);
      await loadData();
    } catch (err: any) { alert(err.message); }
    finally { setSaving(false); }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('¿Eliminar este covenant?')) return;
    await db.deleteCovenant(id);
    await loadData();
  };

  // Guarda celdas de la bitácora mensual y sincroniza complianceStatus (lo que leen
  // reporte y dashboard) con el mes más reciente registrado de cada obligación.
  const applyEntries = async (updates: Array<{ covenantId: string; month: string; entry: MonthlyEntry | null }>) => {
    setSavingCompliance(true);
    try {
      const next = await saveComplianceEntries(clientId, updates);
      setLog(next);
      const touched = new Set(updates.map(u => u.covenantId));
      const changed = covenants.filter(c => touched.has(c.id) && (latestStatus(next, c.id) || 'pendiente') !== ((c as any).complianceStatus || 'pendiente'));
      await Promise.all(changed.map(c => db.updateCovenant(c.id, { complianceStatus: latestStatus(next, c.id) || 'pendiente' } as Partial<Covenant_DB>)));
      if (changed.length) {
        const all = await db.getCovenants(clientId);
        setCovenants(all.filter(c => c.type === 'hacer' || c.type === 'noHacer'));
        onCovenantsChange(all);
      }
    } catch (err: any) {
      alert(`No se pudo guardar el cumplimiento: ${err?.message || err}`);
    } finally {
      setSavingCompliance(false);
    }
  };

  const entryFor = (covId: string, m = month): MonthlyEntry | undefined => log[covId]?.[m];
  const cellStatus = (covId: string, m = month): CellStatus => entryFor(covId, m)?.status || 'pendiente';

  const handleMonthStatus = async (cov: Covenant_DB, status: MonthlyStatus | null) => {
    if (!status) return applyEntries([{ covenantId: cov.id, month, entry: null }]);
    let reason: string | undefined;
    if (status === 'incumple') {
      const answer = window.prompt(`Motivo del incumplimiento — ${cov.name} (${monthLabel(month)})`, entryFor(cov.id)?.reason || '');
      if (answer === null) return;
      reason = answer.trim();
      if (!reason) { alert('El motivo del incumplimiento es obligatorio.'); return; }
    }
    await applyEntries([{ covenantId: cov.id, month, entry: { status, reason, source: 'manual', userName: session.userName, updatedAt: new Date().toISOString() } }]);
  };

  const editReason = async (cov: Covenant_DB) => {
    const e = entryFor(cov.id);
    if (!e) return;
    const answer = window.prompt(`Motivo del incumplimiento — ${cov.name} (${monthLabel(month)})`, e.reason || '');
    if (answer === null || !answer.trim()) return;
    await applyEntries([{ covenantId: cov.id, month, entry: { ...e, reason: answer.trim(), userName: session.userName, updatedAt: new Date().toISOString() } }]);
  };

  const inScope = (cov: Covenant_DB, scope: string) => scope === 'all' || (scope === '' ? !cov.transactionId : cov.transactionId === scope);

  // Carga masiva desde el certificado de cumplimiento: todo lo del alcance queda CUMPLE
  // salvo lo que el certificado reporta como incumplido (con su motivo).
  const applyCertificate = async () => {
    if (!cert) return;
    if (!cert.reference.trim()) { alert('Captura la referencia del certificado (folio, fecha o nombre del archivo).'); return; }
    const missing = Object.keys(cert.breached).filter(k => !cert.breached[k].trim());
    if (missing.length) { alert('Cada incumplimiento necesita su motivo.'); return; }
    const scoped = covenants.filter(c => inScope(c, cert.scope));
    const now = new Date().toISOString();
    await applyEntries(scoped.map(c => {
      const breachReason = cert.breached[c.id];
      return {
        covenantId: c.id, month,
        entry: { status: breachReason !== undefined ? 'incumple' : 'cumple', reason: breachReason?.trim() || undefined, source: 'certificado', certificate: cert.reference.trim(), userName: session.userName, updatedAt: now },
      };
    }));
    setCert(null);
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
      await db.addAnnotation({ covenantId, userId: session.userId, userName: session.userName, text });
      setNoteText(prev => ({ ...prev, [covenantId]: '' }));
      const anns = await db.getAnnotations(covenantId);
      setAnnotations(prev => ({ ...prev, [covenantId]: anns }));
    } catch (err: any) { alert(err.message); }
    finally { setSendingNote(null); }
  };

  const visible = covenants.filter(c => inScope(c, contractFilter));
  const hacer = visible.filter(c => c.type === 'hacer');
  const noHacer = visible.filter(c => c.type === 'noHacer');
  const summary = useMemo(() => summarizeMonth(log, visible, month), [log, visible, month]);
  const historyMonths = useMemo(() => monthsEndingAt(month, 12), [month]);
  const transactionName = (transactionId?: string) => transactions.find(tx => tx.id === transactionId)?.name || '';

  const renderGroup = (items: Covenant_DB[], label: string, accentColor: string) => (
    <div>
      <div className={`flex items-center gap-2 mb-3`}>
        <span className={`text-xs font-black uppercase tracking-widest text-slate-500`}>{label}</span>
        <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${accentColor}`}>{items.length}</span>
      </div>
      {items.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-6 text-center text-slate-400 text-sm">
          Sin obligaciones registradas
        </div>
      ) : (
        <div className="space-y-3">
          {items.map(cov => {
            const status = cellStatus(cov.id);
            const entry = entryFor(cov.id);
            const streak = status === 'incumple' ? breachStreak(log, cov.id, month) : 0;
            const isExpanded = expanded === cov.id;
            const covAnnotations = annotations[cov.id] || [];
            return (
              <div key={cov.id} className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
                <div className="flex items-start gap-4 px-6 py-4">
                  <button onClick={() => setExpanded(isExpanded ? null : cov.id)} className="text-slate-400 hover:text-slate-700 transition-colors mt-0.5">
                    {isExpanded ? <ChevronDown className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
                  </button>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3 flex-wrap">
                      <h4 className="font-black text-slate-900 text-sm">{cov.name}</h4>
                      <StatusBadge status={status} />
                      {transactionName(cov.transactionId) && <span className="text-[10px] font-black bg-slate-100 text-slate-700 border border-slate-200 rounded-full px-2 py-0.5">{transactionName(cov.transactionId)}</span>}
                    </div>
                    {cov.description && <p className="text-xs text-slate-500 mt-1 line-clamp-1">{cov.description}</p>}
                    {entry?.status === 'incumple' && (
                      <p className="text-xs text-rose-700 mt-1.5 flex items-start gap-1.5">
                        <span className="font-black">Motivo:</span>
                        <span className="flex-1">{entry.reason || 'Sin motivo capturado'}{streak > 1 ? ` · ${streak} meses consecutivos` : ''}</span>
                        <button onClick={() => editReason(cov)} title="Editar motivo" className="text-rose-400 hover:text-rose-700"><Pencil className="w-3 h-3" /></button>
                      </p>
                    )}
                    {entry && (
                      <p className="text-[10px] text-slate-400 mt-1">
                        {entry.source === 'certificado' ? `Certificado: ${entry.certificate || 's/ref'}` : 'Revisión manual'} · {entry.userName} · {new Date(entry.updatedAt).toLocaleDateString('es-MX', { day: '2-digit', month: 'short' })}
                      </p>
                    )}
                    <div className="flex items-center gap-1 mt-2" aria-label="Historial 12 meses">
                      {historyMonths.map(m => {
                        const st = cellStatus(cov.id, m);
                        const e = entryFor(cov.id, m);
                        return (
                          <button key={m} onClick={() => setMonth(m)} title={`${monthLabel(m)}: ${STATUS_STYLE[st].label}${e?.reason ? ` — ${e.reason}` : ''}`}
                            className={`h-3 w-3 rounded-sm ${STATUS_STYLE[st].dot} ${m === month ? 'ring-2 ring-indigo-400 ring-offset-1' : ''}`} />
                        );
                      })}
                    </div>
                  </div>
                  <div className="flex-shrink-0">
                    <MonthToggle status={status} onChange={s => handleMonthStatus(cov, s)} />
                  </div>
                  <div className="flex items-center gap-2">
                    {covAnnotations.length > 0 && (
                      <span className="flex items-center gap-1 text-xs text-slate-500">
                        <MessageCircle className="w-3.5 h-3.5" />{covAnnotations.length}
                      </span>
                    )}
                    <button onClick={() => handleDelete(cov.id)} className="text-slate-300 hover:text-rose-500 transition-colors">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {isExpanded && (
                  <div className="border-t border-slate-100 bg-slate-50">
                    <div className="px-6 py-4 border-b border-slate-100">
                      {transactions.length > 0 && (
                        <div>
                          <label className="text-xs font-bold text-slate-500 uppercase tracking-wider block mb-2">Facility / Transacción</label>
                          <select value={cov.transactionId || ''} onChange={e => saveTransactionLink(cov, e.target.value)} className={inputClass}>
                            <option value="">General del cliente</option>
                            {transactions.map(tx => <option key={tx.id} value={tx.id}>{tx.name}</option>)}
                          </select>
                        </div>
                      )}
                      {cov.description && (
                        <div className="mt-4">
                          <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Descripción</p>
                          <p className="text-sm text-slate-700 leading-relaxed">{cov.description}</p>
                        </div>
                      )}
                    </div>
                    <div className="px-6 py-4">
                      <p className="text-xs font-black text-slate-500 uppercase tracking-widest mb-4 flex items-center gap-2">
                        <MessageCircle className="w-3.5 h-3.5" />Notas y Seguimiento
                      </p>
                      {covAnnotations.length === 0 ? (
                        <p className="text-xs text-slate-400 text-center py-4">Sin notas. Agrega la primera nota abajo.</p>
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
                      <div className="flex gap-3">
                        <input
                          type="text"
                          value={noteText[cov.id] || ''}
                          onChange={e => setNoteText(prev => ({ ...prev, [cov.id]: e.target.value }))}
                          onKeyDown={e => e.key === 'Enter' && handleSendNote(cov.id)}
                          placeholder="Agregar nota..."
                          className="flex-1 bg-white border border-slate-200 text-slate-900 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 transition-all"
                        />
                        <button onClick={() => handleSendNote(cov.id)} disabled={!noteText[cov.id]?.trim() || sendingNote === cov.id} className="bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-300 text-white p-2.5 rounded-xl transition-all">
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
      )}
    </div>
  );

  return (
    <div ref={panelRef} className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-black text-slate-900">Hacer / No Hacer</h2>
          <p className="text-slate-500 text-sm mt-0.5">Obligaciones del contrato — seguimiento mes a mes (revisión manual o certificado de cumplimiento)</p>
        </div>
        <div className="flex items-center gap-2">
          {covenants.length > 0 && (
            <>
              <button onClick={() => handleExport('excel')} disabled={!!exporting} className="flex items-center gap-1.5 bg-white border border-slate-200 text-slate-600 font-bold px-3 py-2 rounded-xl text-xs hover:bg-slate-50 disabled:opacity-50 transition-all">
                {exporting === 'excel' ? <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/></svg> : <Download className="w-3.5 h-3.5" />}
                Excel
              </button>
              <button onClick={() => handleExport('pdf')} disabled={!!exporting} className="flex items-center gap-1.5 bg-white border border-slate-200 text-slate-600 font-bold px-3 py-2 rounded-xl text-xs hover:bg-slate-50 disabled:opacity-50 transition-all">
                {exporting === 'pdf' ? <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/></svg> : <FileText className="w-3.5 h-3.5" />}
                PDF
              </button>
            </>
          )}
          <button onClick={() => setShowForm(true)} className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white font-bold px-4 py-2.5 rounded-xl text-sm transition-all">
            <Plus className="w-4 h-4" />Nueva Obligación
          </button>
        </div>
      </div>

      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg">
            <div className="flex items-center justify-between p-6 border-b border-slate-100">
              <h3 className="font-black text-slate-900">Nueva Obligación</h3>
              <button onClick={() => setShowForm(false)} className="text-slate-400 hover:text-slate-700"><X className="w-5 h-5" /></button>
            </div>
            <form onSubmit={handleSave} className="p-6 space-y-4">
              <div>
                <label className="text-xs font-bold text-slate-600 uppercase tracking-wider block mb-1.5">Tipo</label>
                <div className="flex gap-2">
                  {(['hacer', 'noHacer'] as const).map(t => (
                    <button key={t} type="button" onClick={() => setForm(p => ({ ...p, type: t }))}
                      className={`flex-1 py-2.5 rounded-xl border text-sm font-bold transition-all ${form.type === t ? (t === 'hacer' ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-rose-600 text-white border-rose-600') : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'}`}>
                      {t === 'hacer' ? 'Hacer' : 'No Hacer'}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-xs font-bold text-slate-600 uppercase tracking-wider block mb-1.5">Nombre *</label>
                <input className={inputClass} value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} placeholder="ej: Mantener razón de liquidez mínima" required />
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
              <div>
                <label className="text-xs font-bold text-slate-600 uppercase tracking-wider block mb-1.5">Descripción</label>
                <textarea className={inputClass} value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))} rows={3} placeholder="Detalle de la obligación según contrato" />
              </div>
              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => setShowForm(false)} className="flex-1 py-2.5 rounded-xl border border-slate-200 text-slate-700 text-sm font-bold hover:bg-slate-50">Cancelar</button>
                <button type="submit" disabled={saving} className="flex-1 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-black disabled:opacity-60">{saving ? 'Guardando...' : 'Guardar'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {covenants.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-2xl p-4 flex flex-wrap items-end gap-4">
          <div>
            <label className="text-[11px] font-black text-slate-500 uppercase tracking-wider block mb-1">Mes de revisión</label>
            <input type="month" value={month} onChange={e => e.target.value && setMonth(e.target.value)} className="bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-sm font-bold" />
          </div>
          {transactions.length > 0 && (
            <div>
              <label className="text-[11px] font-black text-slate-500 uppercase tracking-wider block mb-1">Contrato</label>
              <select value={contractFilter} onChange={e => setContractFilter(e.target.value)} className="bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-sm font-bold">
                <option value="all">Todos</option>
                <option value="">General del cliente</option>
                {transactions.map(tx => <option key={tx.id} value={tx.id}>{tx.name}</option>)}
              </select>
            </div>
          )}
          <div className="flex items-center gap-2 text-xs font-black">
            <span className="px-2.5 py-1 rounded-full bg-emerald-100 text-emerald-800">{summary.cumple} cumple</span>
            <span className="px-2.5 py-1 rounded-full bg-rose-100 text-rose-800">{summary.incumple} incumple</span>
            <span className="px-2.5 py-1 rounded-full bg-slate-100 text-slate-600">{summary.na} N.A.</span>
            <span className={`px-2.5 py-1 rounded-full ${summary.pendiente ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-500'}`}>{summary.pendiente} pendientes</span>
          </div>
          <button onClick={() => setCert({ scope: contractFilter, reference: '', breached: {} })} disabled={savingCompliance}
            className="ml-auto flex items-center gap-2 bg-slate-900 hover:bg-slate-800 text-white font-bold px-4 py-2.5 rounded-xl text-sm disabled:opacity-50">
            <FileCheck2 className="w-4 h-4" /> Certificado de cumplimiento
          </button>
        </div>
      )}

      {cert && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between p-6 border-b border-slate-100">
              <div>
                <h3 className="font-black text-slate-900">Certificado de cumplimiento — {monthLabel(month)}</h3>
                <p className="text-xs text-slate-500 mt-0.5">Todo queda como CUMPLE; desmarca lo que el certificado reporta incumplido y escribe el motivo.</p>
              </div>
              <button onClick={() => setCert(null)} className="text-slate-400 hover:text-slate-700"><X className="w-5 h-5" /></button>
            </div>
            <div className="p-6 space-y-4 overflow-y-auto">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-bold text-slate-600 uppercase tracking-wider block mb-1.5">Contrato</label>
                  <select className={inputClass} value={cert.scope} onChange={e => setCert({ ...cert, scope: e.target.value, breached: {} })}>
                    <option value="all">Todos los contratos</option>
                    <option value="">General del cliente</option>
                    {transactions.map(tx => <option key={tx.id} value={tx.id}>{tx.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-bold text-slate-600 uppercase tracking-wider block mb-1.5">Referencia del certificado *</label>
                  <input className={inputClass} value={cert.reference} onChange={e => setCert({ ...cert, reference: e.target.value })} placeholder="ej: Certificado sep-26, folio 123" />
                </div>
              </div>
              {(() => {
                const scoped = covenants.filter(c => inScope(c, cert.scope));
                const overwritten = scoped.filter(c => entryFor(c.id)).length;
                return (
                  <>
                    {overwritten > 0 && <p className="text-xs font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">{overwritten} obligación(es) ya tienen estatus en {monthLabel(month)}; el certificado los reemplaza.</p>}
                    <div className="divide-y divide-slate-100 border border-slate-200 rounded-xl">
                      {scoped.map(c => {
                        const breached = cert.breached[c.id] !== undefined;
                        return (
                          <div key={c.id} className="px-4 py-3">
                            <label className="flex items-start gap-3 cursor-pointer">
                              <input type="checkbox" className="mt-1" checked={!breached} disabled={!monitored && !breached}
                                onChange={e => {
                                  const next = { ...cert.breached };
                                  if (e.target.checked) delete next[c.id]; else next[c.id] = '';
                                  setCert({ ...cert, breached: next });
                                }} />
                              <span className="flex-1">
                                <span className="text-sm font-bold text-slate-800">{c.name}</span>
                                <span className={`ml-2 text-[10px] font-black uppercase ${c.type === 'hacer' ? 'text-emerald-600' : 'text-rose-600'}`}>{c.type === 'hacer' ? 'Hacer' : 'No hacer'}</span>
                                {transactionName(c.transactionId) && <span className="ml-2 text-[10px] font-bold text-slate-400">{transactionName(c.transactionId)}</span>}
                              </span>
                              <span className={`text-[11px] font-black ${breached ? 'text-rose-600' : 'text-emerald-600'}`}>{breached ? 'INCUMPLE' : 'CUMPLE'}</span>
                            </label>
                            {breached && (
                              <input className={`${inputClass} mt-2`} autoFocus value={cert.breached[c.id]} onChange={e => setCert({ ...cert, breached: { ...cert.breached, [c.id]: e.target.value } })} placeholder="Motivo del incumplimiento (obligatorio)" />
                            )}
                          </div>
                        );
                      })}
                      {scoped.length === 0 && <p className="px-4 py-6 text-center text-sm text-slate-400">Sin obligaciones en este contrato.</p>}
                    </div>
                  </>
                );
              })()}
            </div>
            <div className="flex gap-3 p-6 border-t border-slate-100">
              <button onClick={() => setCert(null)} className="flex-1 py-2.5 rounded-xl border border-slate-200 text-slate-700 text-sm font-bold hover:bg-slate-50">Cancelar</button>
              <button onClick={applyCertificate} disabled={savingCompliance} className="flex-1 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-black disabled:opacity-60">{savingCompliance ? 'Guardando...' : 'Aplicar certificado'}</button>
            </div>
          </div>
        </div>
      )}

      {covenants.length === 0 && !showForm && (
        <div className="bg-white border border-slate-200 rounded-2xl p-12 text-center">
          <ListChecks className="w-10 h-10 text-slate-300 mx-auto mb-3" />
          <p className="text-slate-500 font-semibold">Sin obligaciones registradas</p>
          <p className="text-slate-400 text-sm mt-1">Agrega las obligaciones de hacer y no hacer definidas en el contrato</p>
        </div>
      )}

      {covenants.length > 0 && (
        <div className="space-y-8">
          {renderGroup(hacer, 'Hacer', 'bg-emerald-100 text-emerald-800')}
          {renderGroup(noHacer, 'No Hacer', 'bg-rose-100 text-rose-800')}
        </div>
      )}
    </div>
  );
};

export default HacerNoHacerPanel;
