import React, { useState, useEffect, useRef } from 'react';
import { db, Covenant_DB, CovenantAnnotation } from '../../db/index';
import { Session } from '../../services/auth';
import { Plus, ChevronDown, ChevronRight, MessageCircle, Send, CheckCircle, XCircle, Clock, X, Trash2, ListChecks, Download, FileText } from 'lucide-react';

const nanoid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

interface Props {
  clientId: string;
  clientName?: string;
  session: Session;
  onCovenantsChange: (covenants: Covenant_DB[]) => void;
}

type ComplianceStatus = 'cumple' | 'incumple' | 'pendiente';

function getStatus(cov: Covenant_DB): ComplianceStatus {
  return ((cov as any).complianceStatus as ComplianceStatus) || 'pendiente';
}

const StatusBadge: React.FC<{ status: ComplianceStatus }> = ({ status }) => {
  const map: Record<ComplianceStatus, string> = {
    cumple: 'bg-emerald-100 text-emerald-800 border-emerald-200',
    incumple: 'bg-rose-100 text-rose-800 border-rose-200',
    pendiente: 'bg-slate-100 text-slate-600 border-slate-200',
  };
  const icons: Record<ComplianceStatus, React.ReactNode> = {
    cumple: <CheckCircle className="w-3 h-3" />,
    incumple: <XCircle className="w-3 h-3" />,
    pendiente: <Clock className="w-3 h-3" />,
  };
  return (
    <span className={`flex items-center gap-1 text-xs font-black px-2.5 py-1 rounded-full border ${map[status]}`}>
      {icons[status]}{status.toUpperCase()}
    </span>
  );
};

const StatusToggle: React.FC<{ status: ComplianceStatus; onChange: (s: ComplianceStatus) => void }> = ({ status, onChange }) => {
  const options: ComplianceStatus[] = ['cumple', 'incumple', 'pendiente'];
  return (
    <div className="flex gap-1">
      {options.map(opt => {
        const active = status === opt;
        const colors: Record<ComplianceStatus, string> = {
          cumple: active ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-slate-500 border-slate-200 hover:border-emerald-300',
          incumple: active ? 'bg-rose-600 text-white border-rose-600' : 'bg-white text-slate-500 border-slate-200 hover:border-rose-300',
          pendiente: active ? 'bg-slate-600 text-white border-slate-600' : 'bg-white text-slate-500 border-slate-200 hover:border-slate-400',
        };
        return (
          <button key={opt} onClick={() => onChange(opt)} className={`px-3 py-1 rounded-lg text-xs font-bold border transition-all ${colors[opt]}`}>
            {opt.charAt(0).toUpperCase() + opt.slice(1)}
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
}

const EMPTY: FormData = { name: '', type: 'hacer', description: '' };

const inputClass = 'bg-slate-50 border border-slate-200 text-slate-900 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 transition-all w-full';

const HacerNoHacerPanel: React.FC<Props> = ({ clientId, clientName = '', session, onCovenantsChange }) => {
  const [covenants, setCovenants] = useState<Covenant_DB[]>([]);
  const [annotations, setAnnotations] = useState<Record<string, CovenantAnnotation[]>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormData>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [noteText, setNoteText] = useState<Record<string, string>>({});
  const [sendingNote, setSendingNote] = useState<string | null>(null);
  const [exporting, setExporting] = useState<'excel' | 'pdf' | null>(null);
  const notesEndRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const handleExport = async (format: 'excel' | 'pdf') => {
    setExporting(format);
    try {
      const { exportHacerNoHacer } = await import('../../lib/export');
      await exportHacerNoHacer(covenants, clientName, format, format === 'pdf' ? panelRef.current ?? undefined : undefined);
    } finally {
      setExporting(null);
    }
  };

  const loadData = async () => {
    const all = await db.getCovenants(clientId);
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
      await db.createCovenant({ clientId, name: form.name.trim(), type: form.type, formula: '', threshold: '', operator: 'none', description: form.description.trim(), isCustom: true });
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

  const handleStatusChange = async (cov: Covenant_DB, status: ComplianceStatus) => {
    await db.updateCovenant(cov.id, { ...(cov as any), complianceStatus: status });
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

  const hacer = covenants.filter(c => c.type === 'hacer');
  const noHacer = covenants.filter(c => c.type === 'noHacer');

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
            const status = getStatus(cov);
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
                    </div>
                    {cov.description && <p className="text-xs text-slate-500 mt-1 line-clamp-1">{cov.description}</p>}
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
                      <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">Estado de Cumplimiento</p>
                      <StatusToggle status={status} onChange={s => handleStatusChange(cov, s)} />
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
          <p className="text-slate-500 text-sm mt-0.5">Obligaciones cualitativas del contrato — seguimiento manual</p>
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
