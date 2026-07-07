import React, { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Clock, Mail, Phone, Plus, Star, Trash2, UserRound, UsersRound } from 'lucide-react';
import { CrmActivity, CrmActivityType, CrmContact, CrmInfluence, CrmPriority, CrmRelationship, CrmTimelineItem, db } from '../../db/index';
import { Session } from '../../services/auth';

interface Props {
  clientId: string;
  session: Session;
}

const todayDateTime = () => `${new Date().toISOString().slice(0, 10)}T09:00`;

const emptyContact = (): Omit<CrmContact, 'id' | 'createdAt' | 'updatedAt'> => ({
  clientId: '',
  name: '',
  title: '',
  department: '',
  email: '',
  phone: '',
  influence: 'medium',
  relationship: 'neutral',
  isPrimary: false,
  notes: '',
  createdBy: '',
});

const emptyActivity = (): Omit<CrmActivity, 'id' | 'createdAt' | 'updatedAt'> => ({
  clientId: '',
  contactId: '',
  type: 'task',
  phase: 'Underwriting',
  recordType: 'Comunicación',
  nextStage: '',
  contactName: '',
  analystName: '',
  subject: '',
  quickNote: '',
  nextStep: '',
  detail: '',
  status: 'planned',
  priority: 'normal',
  dueAt: todayDateTime(),
  completedAt: '',
  ownerId: '',
  createdBy: '',
});

function fmtDate(value?: string) {
  if (!value) return 'Sin fecha';
  return new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function relationshipClass(value: CrmRelationship) {
  if (value === 'champion') return 'bg-emerald-100 text-emerald-800 border-emerald-200';
  if (value === 'risk') return 'bg-rose-100 text-rose-800 border-rose-200';
  return 'bg-slate-100 text-slate-700 border-slate-200';
}

function priorityClass(value: CrmPriority) {
  if (value === 'high') return 'bg-rose-100 text-rose-800';
  if (value === 'low') return 'bg-slate-100 text-slate-600';
  return 'bg-indigo-100 text-indigo-700';
}

function typeLabel(value: CrmActivityType) {
  return {
    call: 'Llamada',
    meeting: 'Reunión',
    email: 'Correo',
    task: 'Tarea',
    note: 'Nota',
    review: 'Revisión',
  }[value];
}

const PHASES = ['Underwriting', 'Monitoring', 'Renovación', 'Apoyo'];
const RECORD_TYPES = ['Comunicación', 'Reunión', 'Doc. Recibido', 'Avance', 'Avance de etapa', 'Disposición', 'Nota'];
const STAGES = ['1. Contacto', '2. Term Sheet', '3. Checklist', '4. Análisis', '5. Due Diligence', '6. Contrato', '7. Disposición', 'Monitoring'];

const CrmPanel: React.FC<Props> = ({ clientId, session }) => {
  const [contacts, setContacts] = useState<CrmContact[]>([]);
  const [activities, setActivities] = useState<CrmActivity[]>([]);
  const [timeline, setTimeline] = useState<CrmTimelineItem[]>([]);
  const [contactDraft, setContactDraft] = useState(emptyContact);
  const [activityDraft, setActivityDraft] = useState(emptyActivity);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const loadCrm = async () => {
    setLoading(true);
    setError('');
    try {
      const [nextContacts, nextActivities, nextTimeline] = await Promise.all([
        db.getCrmContacts(clientId),
        db.getCrmActivities(clientId),
        db.getCrmTimeline(clientId),
      ]);
      setContacts(nextContacts);
      setActivities(nextActivities);
      setTimeline(nextTimeline);
    } catch (err: any) {
      setError(err.message || 'No se pudo cargar CRM.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setContactDraft({ ...emptyContact(), clientId, createdBy: session.userId });
    setActivityDraft({ ...emptyActivity(), clientId, createdBy: session.userId, ownerId: session.userId });
    void loadCrm();
  }, [clientId]);

  const openActivities = useMemo(() => activities.filter(item => item.status === 'planned'), [activities]);
  const doneActivities = useMemo(() => activities.filter(item => item.status === 'done'), [activities]);
  const primaryContact = contacts.find(contact => contact.isPrimary);

  const saveContact = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!contactDraft.name.trim()) return;
    setSaving(true);
    try {
      await db.createCrmContact({
        ...contactDraft,
        clientId,
        createdBy: session.userId,
        name: contactDraft.name.trim(),
        email: contactDraft.email.trim(),
        phone: contactDraft.phone.trim(),
      });
      setContactDraft({ ...emptyContact(), clientId, createdBy: session.userId });
      await loadCrm();
    } catch (err: any) {
      setError(err.message || 'No se pudo guardar el contacto.');
    } finally {
      setSaving(false);
    }
  };

  const saveActivity = async (event: React.FormEvent) => {
    event.preventDefault();
    const subject = activityDraft.subject.trim() || activityDraft.quickNote.trim() || activityDraft.nextStep.trim();
    if (!subject) return;
    setSaving(true);
    try {
      await db.createCrmActivity({
        ...activityDraft,
        clientId,
        createdBy: session.userId,
        ownerId: session.userId,
        contactId: activityDraft.contactId || undefined,
        contactName: activityDraft.contactName || contacts.find(contact => contact.id === activityDraft.contactId)?.name || '',
        dueAt: activityDraft.dueAt || undefined,
        subject,
      });
      setActivityDraft({ ...emptyActivity(), clientId, createdBy: session.userId, ownerId: session.userId });
      await loadCrm();
    } catch (err: any) {
      setError(err.message || 'No se pudo guardar la actividad.');
    } finally {
      setSaving(false);
    }
  };

  const completeActivity = async (activity: CrmActivity) => {
    await db.updateCrmActivity(activity.id, {
      status: 'done',
      completedAt: new Date().toISOString(),
    });
    await loadCrm();
  };

  const removeContact = async (contact: CrmContact) => {
    if (!confirm(`¿Eliminar contacto "${contact.name}"?`)) return;
    await db.deleteCrmContact(contact.id);
    await loadCrm();
  };

  const removeActivity = async (activity: CrmActivity) => {
    if (!confirm(`¿Eliminar actividad "${activity.subject}"?`)) return;
    await db.deleteCrmActivity(activity.id);
    await loadCrm();
  };

  const inputClass = 'w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-semibold text-slate-800 outline-none focus:ring-2 focus:ring-indigo-300';
  const labelClass = 'mb-1 block text-[10px] font-black uppercase tracking-widest text-slate-400';

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <svg className="h-8 w-8 animate-spin text-indigo-500" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
        </svg>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-bold text-rose-700">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-xs font-black uppercase tracking-wider text-slate-400">Contactos</p>
          <p className="mt-1 text-2xl font-black text-slate-900">{contacts.length}</p>
        </div>
        <div className="rounded-xl border border-amber-200 bg-white p-4">
          <p className="text-xs font-black uppercase tracking-wider text-amber-600">Pendientes</p>
          <p className="mt-1 text-2xl font-black text-amber-700">{openActivities.length}</p>
        </div>
        <div className="rounded-xl border border-emerald-200 bg-white p-4">
          <p className="text-xs font-black uppercase tracking-wider text-emerald-600">Completadas</p>
          <p className="mt-1 text-2xl font-black text-emerald-700">{doneActivities.length}</p>
        </div>
        <div className="rounded-xl border border-indigo-200 bg-white p-4">
          <p className="text-xs font-black uppercase tracking-wider text-indigo-600">Contacto principal</p>
          <p className="mt-1 truncate text-lg font-black text-slate-900">{primaryContact?.name || 'Sin asignar'}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[0.9fr_1.1fr]">
        <section className="space-y-4">
          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <div className="mb-4 flex items-center gap-2">
              <UsersRound className="h-4 w-4 text-indigo-600" />
              <h2 className="text-sm font-black uppercase tracking-widest text-slate-900">Nuevo contacto</h2>
            </div>
            <form onSubmit={saveContact} className="space-y-3">
              <label>
                <span className={labelClass}>Nombre</span>
                <input className={inputClass} value={contactDraft.name} onChange={e => setContactDraft(prev => ({ ...prev, name: e.target.value }))} placeholder="Nombre completo" />
              </label>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <label>
                  <span className={labelClass}>Cargo</span>
                  <input className={inputClass} value={contactDraft.title} onChange={e => setContactDraft(prev => ({ ...prev, title: e.target.value }))} placeholder="CFO, Legal, Tesorería" />
                </label>
                <label>
                  <span className={labelClass}>Área</span>
                  <input className={inputClass} value={contactDraft.department} onChange={e => setContactDraft(prev => ({ ...prev, department: e.target.value }))} placeholder="Finanzas" />
                </label>
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <label>
                  <span className={labelClass}>Email</span>
                  <input className={inputClass} type="email" value={contactDraft.email} onChange={e => setContactDraft(prev => ({ ...prev, email: e.target.value }))} placeholder="correo@empresa.com" />
                </label>
                <label>
                  <span className={labelClass}>Teléfono</span>
                  <input className={inputClass} value={contactDraft.phone} onChange={e => setContactDraft(prev => ({ ...prev, phone: e.target.value }))} placeholder="+52..." />
                </label>
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <label>
                  <span className={labelClass}>Influencia</span>
                  <select className={inputClass} value={contactDraft.influence} onChange={e => setContactDraft(prev => ({ ...prev, influence: e.target.value as CrmInfluence }))}>
                    <option value="medium">Media</option>
                    <option value="high">Alta</option>
                    <option value="decision_maker">Decisor</option>
                    <option value="low">Baja</option>
                  </select>
                </label>
                <label>
                  <span className={labelClass}>Relación</span>
                  <select className={inputClass} value={contactDraft.relationship} onChange={e => setContactDraft(prev => ({ ...prev, relationship: e.target.value as CrmRelationship }))}>
                    <option value="neutral">Neutral</option>
                    <option value="champion">Aliado</option>
                    <option value="risk">Riesgo</option>
                  </select>
                </label>
              </div>
              <label className="flex items-center gap-2 text-sm font-bold text-slate-600">
                <input type="checkbox" checked={contactDraft.isPrimary} onChange={e => setContactDraft(prev => ({ ...prev, isPrimary: e.target.checked }))} />
                Contacto principal
              </label>
              <label>
                <span className={labelClass}>Notas</span>
                <textarea className={`${inputClass} min-h-20`} value={contactDraft.notes} onChange={e => setContactDraft(prev => ({ ...prev, notes: e.target.value }))} placeholder="Preferencias, contexto y señales de relación" />
              </label>
              <button disabled={saving || !contactDraft.name.trim()} className="flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-3 text-sm font-black text-white hover:bg-indigo-500 disabled:opacity-50">
                <Plus className="h-4 w-4" />
                Agregar contacto
              </button>
            </form>
          </div>

          <div className="space-y-3">
            {contacts.map(contact => (
              <article key={contact.id} className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="truncate text-sm font-black text-slate-900">{contact.name}</h3>
                      {contact.isPrimary && <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />}
                    </div>
                    <p className="mt-1 text-xs font-bold text-slate-500">{[contact.title, contact.department].filter(Boolean).join(' · ') || 'Sin cargo'}</p>
                  </div>
                  <button onClick={() => removeContact(contact)} className="rounded-lg p-2 text-slate-400 hover:bg-rose-50 hover:text-rose-600">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <span className={`rounded-lg border px-2 py-1 text-[10px] font-black uppercase tracking-wider ${relationshipClass(contact.relationship)}`}>{contact.relationship}</span>
                  <span className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-[10px] font-black uppercase tracking-wider text-slate-600">{contact.influence}</span>
                </div>
                {(contact.email || contact.phone) && (
                  <div className="mt-3 space-y-1 text-xs font-semibold text-slate-500">
                    {contact.email && <p className="flex items-center gap-2"><Mail className="h-3.5 w-3.5" />{contact.email}</p>}
                    {contact.phone && <p className="flex items-center gap-2"><Phone className="h-3.5 w-3.5" />{contact.phone}</p>}
                  </div>
                )}
                {contact.notes && <p className="mt-3 text-sm leading-6 text-slate-600">{contact.notes}</p>}
              </article>
            ))}
          </div>
        </section>

        <section className="space-y-4">
          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <div className="mb-4 flex items-center gap-2">
              <Clock className="h-4 w-4 text-indigo-600" />
              <h2 className="text-sm font-black uppercase tracking-widest text-slate-900">Nueva actividad</h2>
            </div>
            <form onSubmit={saveActivity} className="space-y-3">
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                <label>
                  <span className={labelClass}>Fase</span>
                  <select className={inputClass} value={activityDraft.phase} onChange={e => setActivityDraft(prev => ({ ...prev, phase: e.target.value }))}>
                    {PHASES.map(phase => <option key={phase} value={phase}>{phase}</option>)}
                  </select>
                </label>
                <label>
                  <span className={labelClass}>Tipo de registro</span>
                  <select
                    className={inputClass}
                    value={activityDraft.recordType}
                    onChange={e => {
                      const recordType = e.target.value;
                      const type = recordType === 'Reunión' ? 'meeting' : recordType === 'Doc. Recibido' ? 'review' : recordType === 'Nota' ? 'note' : 'email';
                      setActivityDraft(prev => ({ ...prev, recordType, type }));
                    }}
                  >
                    {RECORD_TYPES.map(recordType => <option key={recordType} value={recordType}>{recordType}</option>)}
                  </select>
                </label>
                <label>
                  <span className={labelClass}>Nueva etapa</span>
                  <select className={inputClass} value={activityDraft.nextStage} onChange={e => setActivityDraft(prev => ({ ...prev, nextStage: e.target.value }))}>
                    <option value="">Sin cambio</option>
                    {STAGES.map(stage => <option key={stage} value={stage}>{stage}</option>)}
                  </select>
                </label>
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                <label>
                  <span className={labelClass}>Canal</span>
                  <select className={inputClass} value={activityDraft.type} onChange={e => setActivityDraft(prev => ({ ...prev, type: e.target.value as CrmActivityType }))}>
                    <option value="task">Tarea</option>
                    <option value="call">Llamada</option>
                    <option value="meeting">Reunión</option>
                    <option value="email">Correo</option>
                    <option value="review">Revisión</option>
                    <option value="note">Nota</option>
                  </select>
                </label>
                <label>
                  <span className={labelClass}>Prioridad</span>
                  <select className={inputClass} value={activityDraft.priority} onChange={e => setActivityDraft(prev => ({ ...prev, priority: e.target.value as CrmPriority }))}>
                    <option value="normal">Normal</option>
                    <option value="high">Alta</option>
                    <option value="low">Baja</option>
                  </select>
                </label>
                <label>
                  <span className={labelClass}>Fecha</span>
                  <input className={inputClass} type="datetime-local" value={activityDraft.dueAt || ''} onChange={e => setActivityDraft(prev => ({ ...prev, dueAt: e.target.value }))} />
                </label>
              </div>
              <label>
                <span className={labelClass}>Asunto</span>
                <input className={inputClass} value={activityDraft.subject} onChange={e => setActivityDraft(prev => ({ ...prev, subject: e.target.value }))} placeholder="Dar seguimiento a estados financieros de junio" />
              </label>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <label>
                  <span className={labelClass}>Contacto</span>
                  <select
                    className={inputClass}
                    value={activityDraft.contactId || ''}
                    onChange={e => {
                      const contactId = e.target.value;
                      setActivityDraft(prev => ({ ...prev, contactId, contactName: contacts.find(contact => contact.id === contactId)?.name || prev.contactName }));
                    }}
                  >
                    <option value="">Sin contacto ligado</option>
                    {contacts.map(contact => <option key={contact.id} value={contact.id}>{contact.name}</option>)}
                  </select>
                </label>
                <label>
                  <span className={labelClass}>Contacto en tracker</span>
                  <input className={inputClass} value={activityDraft.contactName} onChange={e => setActivityDraft(prev => ({ ...prev, contactName: e.target.value }))} placeholder="Nombre si aún no está en contactos" />
                </label>
              </div>
              <label>
                <span className={labelClass}>Analista</span>
                <input className={inputClass} value={activityDraft.analystName} onChange={e => setActivityDraft(prev => ({ ...prev, analystName: e.target.value }))} placeholder="Denise C., Corde M., etc." />
              </label>
              <label>
                <span className={labelClass}>Nota rápida</span>
                <textarea className={`${inputClass} min-h-20`} value={activityDraft.quickNote} onChange={e => setActivityDraft(prev => ({ ...prev, quickNote: e.target.value }))} placeholder="Resumen corto de lo que pasó" />
              </label>
              <label>
                <span className={labelClass}>Siguiente paso</span>
                <textarea className={`${inputClass} min-h-20`} value={activityDraft.nextStep} onChange={e => setActivityDraft(prev => ({ ...prev, nextStep: e.target.value }))} placeholder="Qué toca hacer después" />
              </label>
              <label>
                <span className={labelClass}>Detalle</span>
                <textarea className={`${inputClass} min-h-20`} value={activityDraft.detail} onChange={e => setActivityDraft(prev => ({ ...prev, detail: e.target.value }))} placeholder="Contexto, acuerdos y próximos pasos" />
              </label>
              <button disabled={saving || !(activityDraft.subject.trim() || activityDraft.quickNote.trim() || activityDraft.nextStep.trim())} className="flex w-full items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 py-3 text-sm font-black text-white hover:bg-slate-800 disabled:opacity-50">
                <Plus className="h-4 w-4" />
                Agregar actividad
              </button>
            </form>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white">
            <div className="border-b border-slate-100 px-5 py-4">
              <h2 className="text-sm font-black uppercase tracking-widest text-slate-900">Pendientes</h2>
            </div>
            <div className="divide-y divide-slate-100">
              {openActivities.length === 0 && <p className="px-5 py-8 text-center text-sm font-semibold text-slate-400">Sin actividades pendientes</p>}
              {openActivities.map(activity => (
                <article key={activity.id} className="p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-black text-slate-900">{activity.subject}</p>
                      <p className="mt-1 text-xs font-bold text-slate-500">{activity.phase || 'Sin fase'} · {activity.recordType || typeLabel(activity.type)} · {fmtDate(activity.dueAt)}</p>
                    </div>
                    <div className="flex items-center gap-1">
                      <button onClick={() => completeActivity(activity)} className="rounded-lg p-2 text-emerald-600 hover:bg-emerald-50">
                        <CheckCircle2 className="h-4 w-4" />
                      </button>
                      <button onClick={() => removeActivity(activity)} className="rounded-lg p-2 text-slate-400 hover:bg-rose-50 hover:text-rose-600">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <span className={`rounded-lg px-2 py-1 text-[10px] font-black uppercase tracking-wider ${priorityClass(activity.priority)}`}>{activity.priority}</span>
                    {(activity.contactName || activity.contactId) && <span className="rounded-lg bg-slate-100 px-2 py-1 text-[10px] font-black uppercase tracking-wider text-slate-600">{activity.contactName || contacts.find(c => c.id === activity.contactId)?.name || 'Contacto'}</span>}
                    {activity.nextStage && <span className="rounded-lg bg-emerald-100 px-2 py-1 text-[10px] font-black uppercase tracking-wider text-emerald-700">{activity.nextStage}</span>}
                    {activity.analystName && <span className="rounded-lg bg-indigo-100 px-2 py-1 text-[10px] font-black uppercase tracking-wider text-indigo-700">{activity.analystName}</span>}
                  </div>
                  {activity.quickNote && <p className="mt-3 text-sm leading-6 text-slate-700">{activity.quickNote}</p>}
                  {activity.nextStep && <p className="mt-2 text-sm font-bold leading-6 text-slate-600">Siguiente paso: {activity.nextStep}</p>}
                  {activity.detail && <p className="mt-2 text-sm leading-6 text-slate-500">{activity.detail}</p>}
                </article>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="text-sm font-black uppercase tracking-widest text-slate-900">Timeline</h2>
            <div className="mt-5 space-y-4">
              {timeline.length === 0 && <p className="py-8 text-center text-sm font-semibold text-slate-400">Aún no hay historia CRM para este cliente</p>}
              {timeline.slice(0, 12).map(item => (
                <div key={`${item.kind}-${item.id}-${item.at}`} className="flex gap-3">
                  <div className="mt-1 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-indigo-50 text-indigo-600">
                    {item.kind === 'contact' ? <UserRound className="h-4 w-4" /> : <Clock className="h-4 w-4" />}
                  </div>
                  <div className="min-w-0 flex-1 border-b border-slate-100 pb-4">
                    <p className="text-sm font-black text-slate-900">{item.title}</p>
                    <p className="mt-1 text-xs font-bold text-slate-400">{fmtDate(item.at)}</p>
                    {item.detail && <p className="mt-2 text-sm leading-6 text-slate-600">{item.detail}</p>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
};

export default CrmPanel;
