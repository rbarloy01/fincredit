import React, { useMemo } from 'react';
import { CalendarClock, Check, CircleAlert } from 'lucide-react';
import { Client, CrmActivity } from '../../db/index';
import { OpenReminder, REMINDER_BUCKETS, ReminderBucket, collectOpenReminders } from '../../lib/crmPipeline';

interface Props {
  clientsById: Record<string, Client>;
  activitiesByClient: Record<string, CrmActivity[]>;
  now: Date;
  onSelectClient: (clientId: string) => void;
  onComplete: (activityId: string) => void;
  completingId: string;
}

const bucketTone: Record<ReminderBucket, string> = {
  vencidas: 'text-rose-600 bg-rose-50 border-rose-200',
  hoy: 'text-amber-600 bg-amber-50 border-amber-200',
  semana: 'text-indigo-600 bg-indigo-50 border-indigo-200',
  proximas: 'text-slate-600 bg-slate-50 border-slate-200',
  sin_fecha: 'text-slate-500 bg-slate-50 border-slate-200',
};

const priorityDot: Record<string, string> = {
  high: 'bg-rose-500',
  normal: 'bg-indigo-400',
  low: 'bg-slate-300',
};

function fmtDue(value?: string) {
  if (!value) return 'Sin fecha';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return 'Sin fecha';
  return new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium' }).format(d);
}

const RemindersInbox: React.FC<Props> = ({ clientsById, activitiesByClient, now, onSelectClient, onComplete, completingId }) => {
  const reminders = useMemo(() => collectOpenReminders(activitiesByClient, now), [activitiesByClient, now]);
  const byBucket = useMemo(() => {
    const map: Record<ReminderBucket, OpenReminder[]> = { vencidas: [], hoy: [], semana: [], proximas: [], sin_fecha: [] };
    for (const r of reminders) map[r.bucket].push(r);
    return map;
  }, [reminders]);

  if (reminders.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-12 text-center">
        <CalendarClock className="mx-auto h-8 w-8 text-slate-300" />
        <p className="mt-3 text-sm font-black text-slate-500">Sin seguimientos pendientes</p>
        <p className="mt-1 text-xs font-semibold text-slate-400">Las tareas y actividades planeadas con fecha aparecerán aquí.</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {REMINDER_BUCKETS.map(({ key, label }) => {
        const items = byBucket[key];
        if (!items.length) return null;
        return (
          <div key={key} className="rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="flex items-center gap-2 border-b border-slate-100 px-5 py-3">
              {key === 'vencidas' ? <CircleAlert className="h-4 w-4 text-rose-500" /> : <CalendarClock className="h-4 w-4 text-slate-400" />}
              <p className="text-xs font-black uppercase tracking-widest text-slate-700">{label}</p>
              <span className={`rounded-md border px-2 py-0.5 text-[10px] font-black ${bucketTone[key]}`}>{items.length}</span>
            </div>
            <div className="divide-y divide-slate-50">
              {items.map(({ activity, clientId, daysUntil }) => {
                const client = clientsById[clientId];
                const busy = completingId === activity.id;
                const overdueLabel = Number.isFinite(daysUntil)
                  ? daysUntil < 0 ? `${Math.abs(daysUntil)}d vencida` : daysUntil === 0 ? 'Hoy' : `en ${daysUntil}d`
                  : '';
                return (
                  <div key={activity.id} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-slate-50/70">
                    <span className={`h-2 w-2 flex-shrink-0 rounded-full ${priorityDot[activity.priority] || priorityDot.normal}`} title={`Prioridad ${activity.priority}`} />
                    <button type="button" onClick={() => onSelectClient(clientId)} className="min-w-0 flex-1 text-left">
                      <p className="truncate text-sm font-black text-slate-900 hover:text-indigo-700">
                        {client?.name || 'Cliente'} <span className="font-bold text-slate-400">·</span> <span className="font-bold text-slate-600">{activity.subject || activity.nextStep || 'Seguimiento'}</span>
                      </p>
                      <p className="truncate text-xs font-semibold text-slate-500">
                        {[activity.analystName || client?.analystName, activity.nextStep && activity.nextStep !== activity.subject ? activity.nextStep : '', activity.phase].filter(Boolean).join(' · ')}
                      </p>
                    </button>
                    <div className="flex flex-shrink-0 items-center gap-3">
                      <div className="text-right">
                        <p className="text-xs font-black text-slate-700">{fmtDue(activity.dueAt)}</p>
                        {overdueLabel && <p className={`text-[10px] font-black uppercase tracking-wider ${daysUntil < 0 ? 'text-rose-600' : 'text-slate-400'}`}>{overdueLabel}</p>}
                      </div>
                      <button
                        type="button"
                        onClick={() => onComplete(activity.id)}
                        disabled={busy}
                        title="Marcar como completada"
                        className="inline-flex items-center gap-1 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-[11px] font-black uppercase tracking-wider text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
                      >
                        <Check className="h-3.5 w-3.5" />{busy ? '…' : 'Listo'}
                      </button>
                    </div>
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

export default RemindersInbox;
