import React, { useMemo, useState } from 'react';
import { AlertTriangle, FileWarning, GripVertical } from 'lucide-react';
import { Client, CrmActivity } from '../../db/index';
import { ClientSignal } from '../../lib/portfolioAnalytics';
import { CRM_STAGES, CrmStage, currentStage, groupClientsByStage } from '../../lib/crmPipeline';

interface Props {
  clients: Client[];
  activitiesByClient: Record<string, CrmActivity[]>;
  signalsByClient: Record<string, ClientSignal>;
  onSelectClient: (clientId: string) => void;
  onMoveStage: (clientId: string, toStage: CrmStage) => void;
  movingId: string;
}

const MonitorBadges: React.FC<{ signal?: ClientSignal }> = ({ signal }) => {
  if (!signal) return null;
  const badges: React.ReactNode[] = [];
  if (signal.breachCount > 0) {
    badges.push(
      <span key="breach" className="inline-flex items-center gap-1 rounded-md border border-rose-200 bg-rose-50 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wider text-rose-700">
        <AlertTriangle className="h-2.5 w-2.5" />{signal.breachCount} breach
      </span>,
    );
  }
  if (signal.reporting.reason === 'sin_eeff') {
    badges.push(
      <span key="sineeff" className="inline-flex items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wider text-amber-700">
        <FileWarning className="h-2.5 w-2.5" />sin EEFF
      </span>,
    );
  } else if (signal.reporting.isOverdue) {
    badges.push(
      <span key="overdue" className="inline-flex items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wider text-amber-700">
        <FileWarning className="h-2.5 w-2.5" />EEFF vencido
      </span>,
    );
  }
  if (!badges.length) return null;
  return <div className="mt-2 flex flex-wrap gap-1">{badges}</div>;
};

const KanbanBoard: React.FC<Props> = ({ clients, activitiesByClient, signalsByClient, onSelectClient, onMoveStage, movingId }) => {
  const [dragId, setDragId] = useState('');
  const [overStage, setOverStage] = useState<CrmStage | ''>('');

  const groups = useMemo(() => groupClientsByStage(clients, activitiesByClient), [clients, activitiesByClient]);

  const handleDrop = (stage: CrmStage) => {
    if (dragId) {
      const from = currentStage(activitiesByClient[dragId] || []);
      if (from !== stage) onMoveStage(dragId, stage);
    }
    setDragId('');
    setOverStage('');
  };

  return (
    <div className="flex gap-3 overflow-x-auto pb-4">
      {CRM_STAGES.map(stage => {
        const items = groups[stage] || [];
        const isOver = overStage === stage;
        return (
          <div
            key={stage}
            onDragOver={e => { e.preventDefault(); setOverStage(stage); }}
            onDragLeave={() => setOverStage(prev => (prev === stage ? '' : prev))}
            onDrop={() => handleDrop(stage)}
            className={`flex w-72 flex-shrink-0 flex-col rounded-2xl border bg-slate-50/80 transition-colors ${isOver ? 'border-indigo-400 bg-indigo-50/70' : 'border-slate-200'}`}
          >
            <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2.5">
              <p className="truncate text-xs font-black uppercase tracking-wider text-slate-700">{stage}</p>
              <span className="rounded-md bg-white px-2 py-0.5 text-[10px] font-black text-slate-500">{items.length}</span>
            </div>
            <div className="flex flex-1 flex-col gap-2 p-2">
              {items.length === 0 && <p className="px-2 py-6 text-center text-[11px] font-bold text-slate-300">—</p>}
              {items.map(client => {
                const signal = signalsByClient[client.id];
                const busy = movingId === client.id;
                return (
                  <div
                    key={client.id}
                    draggable={!busy}
                    onDragStart={() => setDragId(client.id)}
                    onDragEnd={() => { setDragId(''); setOverStage(''); }}
                    onClick={() => onSelectClient(client.id)}
                    className={`group cursor-pointer rounded-xl border border-slate-200 bg-white p-3 shadow-sm transition-shadow hover:shadow-md ${busy ? 'opacity-50' : ''} ${dragId === client.id ? 'ring-2 ring-indigo-400' : ''}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="min-w-0 flex-1 truncate text-sm font-black text-slate-900 group-hover:text-indigo-700">{client.name}</p>
                      <GripVertical className="h-4 w-4 flex-shrink-0 text-slate-300" />
                    </div>
                    {client.analystName && <p className="mt-0.5 truncate text-[11px] font-bold text-slate-400">{client.analystName}</p>}
                    <MonitorBadges signal={signal} />
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

export default KanbanBoard;
