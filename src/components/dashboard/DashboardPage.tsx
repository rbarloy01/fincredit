import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowRight, Building2, CalendarClock, FileWarning,
  Gauge, Moon, ShieldAlert, ShieldCheck, TrendingUp,
} from 'lucide-react';
import { Client, ClientStatus, CrmActivity, Covenant_DB, FinancialStatement_DB, Transaction, db } from '../../db/index';
import { CREDIT_RISK_DISCLAIMER } from '../../lib/creditRiskModel';
import { buildPortfolioSummary, ClientSignal, PortfolioSummary } from '../../lib/portfolioAnalytics';
import WorkingOverlay from '../common/WorkingOverlay';

interface Props {
  onSelectClient: (clientId: string) => void;
}

function fmtCurrency(value: number, currency = 'MXN') {
  const prefix = currency === 'USD' ? 'USD ' : currency === 'EUR' ? 'EUR ' : '$';
  return `${prefix}${Math.round(value || 0).toLocaleString('es-MX')}`;
}

function fmtCompact(value: number, currency = 'MXN') {
  const prefix = currency === 'USD' ? 'USD ' : currency === 'EUR' ? 'EUR ' : '$';
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${prefix}${(value / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${prefix}${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${prefix}${(value / 1_000).toFixed(0)}k`;
  return `${prefix}${Math.round(value).toLocaleString('es-MX')}`;
}

function fmtDate(value?: string | Date | null) {
  if (!value) return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium' }).format(d);
}

const DETAIL_BATCH_SIZE = 10;

function yieldToBrowser() {
  return new Promise<void>(resolve => window.setTimeout(resolve, 0));
}

const RISK_LABEL: Record<string, string> = { low: 'Bajo', medium: 'Medio', high: 'Alto', unknown: 'Sin datos' };
const RISK_TONE: Record<string, string> = {
  low: 'bg-emerald-500', medium: 'bg-amber-500', high: 'bg-rose-500', unknown: 'bg-slate-300',
};

const StatTile: React.FC<{
  label: string;
  value: string;
  hint?: string;
  icon: React.ComponentType<{ className?: string }>;
  tone: 'slate' | 'indigo' | 'emerald' | 'rose' | 'amber';
  onClick?: () => void;
}> = ({ label, value, hint, icon: Icon, tone, onClick }) => {
  const tones: Record<string, string> = {
    slate: 'text-slate-600 bg-slate-100',
    indigo: 'text-indigo-600 bg-indigo-100',
    emerald: 'text-emerald-600 bg-emerald-100',
    rose: 'text-rose-600 bg-rose-100',
    amber: 'text-amber-600 bg-amber-100',
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={`text-left rounded-xl border border-slate-300 bg-white p-5 shadow-sm transition-shadow ${onClick ? 'hover:shadow-md cursor-pointer' : 'cursor-default'}`}
    >
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] font-black uppercase tracking-widest text-slate-700">{label}</p>
        <span className={`inline-flex h-8 w-8 items-center justify-center rounded-xl ${tones[tone]}`}>
          <Icon className="h-4 w-4" />
        </span>
      </div>
      <p className="mt-3 truncate text-3xl font-black tracking-tight text-slate-950">{value}</p>
      {hint && <p className="mt-1 truncate text-xs font-bold text-slate-600">{hint}</p>}
    </button>
  );
};

const SectionCard: React.FC<{
  title: string;
  count?: number;
  icon: React.ComponentType<{ className?: string }>;
  accent?: string;
  children: React.ReactNode;
}> = ({ title, count, icon: Icon, accent = 'text-slate-500', children }) => (
  <div className="rounded-xl border border-slate-300 bg-white shadow-sm">
    <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-5 py-3.5">
      <div className="flex items-center gap-2">
        <Icon className={`h-4 w-4 ${accent}`} />
        <p className="text-xs font-black uppercase tracking-widest text-slate-900">{title}</p>
      </div>
      {typeof count === 'number' && (
        <span className="rounded-lg bg-slate-200 px-2.5 py-1 text-xs font-black text-slate-800">{count}</span>
      )}
    </div>
    <div className="p-3">{children}</div>
  </div>
);

const RiskBadge: React.FC<{ band?: string }> = ({ band }) => {
  const b = band || 'unknown';
  const cls: Record<string, string> = {
    low: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    medium: 'bg-amber-50 text-amber-700 border-amber-200',
    high: 'bg-rose-50 text-rose-700 border-rose-200',
    unknown: 'bg-slate-50 text-slate-500 border-slate-200',
  };
  return (
    <span className={`rounded-md border px-2 py-0.5 text-[10px] font-black uppercase tracking-wider ${cls[b]}`}>
      {RISK_LABEL[b]}
    </span>
  );
};

const ClientRow: React.FC<{ signal: ClientSignal; onSelect: () => void; right: React.ReactNode; sub?: React.ReactNode; action?: React.ReactNode }> = ({ signal, onSelect, right, sub, action }) => (
  <div
    role="button"
    tabIndex={0}
    onClick={onSelect}
    onKeyDown={e => { if (e.key === 'Enter') onSelect(); }}
    className="group flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-indigo-50/80"
  >
    <div className="min-w-0 flex-1">
      <p className="truncate text-sm font-black text-slate-950 group-hover:text-indigo-700">{signal.client.name}</p>
      {sub && <p className="truncate text-xs font-semibold text-slate-600">{sub}</p>}
    </div>
    <div className="flex flex-shrink-0 items-center gap-2">
      {right}
      {action}
      <ArrowRight className="h-4 w-4 text-slate-300 group-hover:text-indigo-500" />
    </div>
  </div>
);

const EmptyRow: React.FC<{ text: string }> = ({ text }) => (
  <p className="px-3 py-8 text-center text-sm font-bold text-slate-400">{text}</p>
);

const DashboardPage: React.FC<Props> = ({ onSelectClient }) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [clients, setClients] = useState<Client[]>([]);
  const [statementsByClient, setStatementsByClient] = useState<Record<string, FinancialStatement_DB[]>>({});
  const [covenantsByClient, setCovenantsByClient] = useState<Record<string, Covenant_DB[]>>({});
  const [transactionsByClient, setTransactionsByClient] = useState<Record<string, Transaction[]>>({});
  const [activitiesByClient, setActivitiesByClient] = useState<Record<string, CrmActivity[]>>({});
  const [statusFilter, setStatusFilter] = useState<'activo' | 'dormant' | 'cerrado' | 'todos'>('activo');
  const [taggingId, setTaggingId] = useState('');
  const [detailsLoading, setDetailsLoading] = useState(false);
  // Ids cuyos datos pesados (EEFF/covenants/transacciones/actividades) ya se cargaron,
  // para no volver a descargarlos al cambiar de filtro.
  const loadedDetailIds = useRef<Set<string>>(new Set());

  const clientStatus = (c: Client): ClientStatus => c.status || 'activo';

  // Fase 1: solo la lista de clientes (ligera). Rinde los conteos y las filas al instante.
  useEffect(() => {
    let active = true;
    const load = async () => {
      setLoading(true);
      setError('');
      try {
        const nextClients = await db.getClientsLight();
        if (!active) return;
        setClients(nextClients);
      } catch (err: any) {
        if (active) setError(err.message || 'No se pudo cargar el panel de portafolio.');
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => { active = false; };
  }, []);

  // Fase 2: datos pesados SOLO para los clientes del filtro visible, y solo los que
  // aún no se han cargado. Así "dormant" no jala las transacciones de los activos, etc.
  useEffect(() => {
    let active = true;
    const visible = statusFilter === 'todos' ? clients : clients.filter(c => clientStatus(c) === statusFilter);
    const missing = visible.map(c => c.id).filter(id => !loadedDetailIds.current.has(id));
    if (missing.length === 0) return;

    const loadDetails = async () => {
      setDetailsLoading(true);
      setError('');
      try {
        for (let i = 0; i < missing.length; i += DETAIL_BATCH_SIZE) {
          const batch = missing.slice(i, i + DETAIL_BATCH_SIZE);
          const [nextStatements, nextCovenants, nextTransactions, nextActivities] = await Promise.all([
            db.getDashboardStatementsForClients(batch),
            db.getCovenantsForClients(batch),
            db.getTransactionsForClients(batch),
            db.getCrmActivitiesForClients(batch),
          ]);
          if (!active) return;
          setStatementsByClient(prev => ({ ...prev, ...nextStatements }));
          setCovenantsByClient(prev => ({ ...prev, ...nextCovenants }));
          setTransactionsByClient(prev => ({ ...prev, ...nextTransactions }));
          setActivitiesByClient(prev => ({ ...prev, ...nextActivities }));
          // Marca como cargados aunque no tengan datos, para no reintentar en cada cambio de filtro.
          batch.forEach(id => loadedDetailIds.current.add(id));
          await yieldToBrowser();
        }
      } catch (err: any) {
        if (active) setError(err.message || 'No se pudieron cargar los datos del portafolio.');
      } finally {
        if (active) setDetailsLoading(false);
      }
    };
    void loadDetails();
    return () => { active = false; };
  }, [clients, statusFilter]);

  const statusCounts = useMemo(() => {
    const counts = { activo: 0, dormant: 0, cerrado: 0, todos: clients.length };
    for (const c of clients) counts[clientStatus(c)] += 1;
    return counts;
  }, [clients]);

  const filteredClients = useMemo(
    () => (statusFilter === 'todos' ? clients : clients.filter(c => clientStatus(c) === statusFilter)),
    [clients, statusFilter],
  );

  const setClientStatus = async (clientId: string, status: ClientStatus) => {
    setTaggingId(clientId);
    // optimistic
    setClients(prev => prev.map(c => (c.id === clientId ? { ...c, status } : c)));
    try {
      await db.updateClient(clientId, { status });
    } catch (err: any) {
      setError(err.message || 'No se pudo actualizar el estatus.');
      setClients(prev => prev.map(c => (c.id === clientId ? { ...c, status: undefined } : c)));
    } finally {
      setTaggingId('');
    }
  };

  const summary: PortfolioSummary = useMemo(() => buildPortfolioSummary({
    clients: filteredClients,
    statementsByClient,
    covenantsByClient,
    transactionsByClient,
    activitiesByClient,
    now: new Date(),
    maturityWindowDays: 90,
  }), [filteredClients, statementsByClient, covenantsByClient, transactionsByClient, activitiesByClient]);

  const primaryCurrency = useMemo(() => {
    const entries = Object.entries(summary.exposureByCurrency);
    if (!entries.length) return 'MXN';
    return entries.sort((a, b) => b[1] - a[1])[0][0];
  }, [summary.exposureByCurrency]);

  const otherCurrencies = Object.entries(summary.exposureByCurrency).filter(([c]) => c !== primaryCurrency && summary.exposureByCurrency[c] > 0);
  const totalRiskScored = summary.riskDistribution.low + summary.riskDistribution.medium + summary.riskDistribution.high;
  const riskDenominator = Math.max(1, totalRiskScored + summary.riskDistribution.unknown);

  const statusAction = (signal: ClientSignal) => {
    const current = clientStatus(signal.client);
    const busy = taggingId === signal.client.id;
    const stop = (e: React.MouseEvent) => e.stopPropagation();
    if (current === 'activo') {
      return (
        <button
          type="button"
          onClick={e => { stop(e); void setClientStatus(signal.client.id, 'dormant'); }}
          disabled={busy}
          title="Marcar como dormant (sale de las alertas)"
          className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-slate-500 hover:border-slate-300 hover:text-slate-700 disabled:opacity-50"
        >
          <Moon className="h-3 w-3" />{busy ? '…' : 'Dormant'}
        </button>
      );
    }
    return (
      <button
        type="button"
        onClick={e => { stop(e); void setClientStatus(signal.client.id, 'activo'); }}
        disabled={busy}
        title="Reactivar cliente"
        className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
      >
        {busy ? '…' : 'Activar'}
      </button>
    );
  };

  return (
    <div className="relative flex-1 bg-slate-100 min-h-screen p-6 md:p-8">
      <WorkingOverlay show={loading} title="Cargando portafolio" />

      <div className="mb-6 flex flex-col gap-3 border-b border-slate-200 pb-5 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <p className="text-[11px] font-black uppercase tracking-[0.18em] text-indigo-600">Vista de portafolio</p>
          <h1 className="mt-1 flex items-center gap-2 text-3xl font-black tracking-tight text-slate-950">
            Dashboard global
            {detailsLoading && (
              <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-indigo-600">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-indigo-500" /> cargando datos…
              </span>
            )}
          </h1>
          <p className="mt-1 text-sm font-semibold text-slate-500">Toda la cartera monitoreada en una sola vista: covenants, reporteo, riesgo y vencimientos.</p>
        </div>
        <div className="flex flex-wrap items-center gap-1 rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
          {([
            { key: 'activo', label: 'Activos' },
            { key: 'dormant', label: 'Dormant' },
            { key: 'cerrado', label: 'Cerrados' },
            { key: 'todos', label: 'Todos' },
          ] as const).map(opt => (
            <button
              key={opt.key}
              type="button"
              onClick={() => setStatusFilter(opt.key)}
              className={`rounded-lg px-3 py-1.5 text-xs font-black transition-colors ${
                statusFilter === opt.key ? 'bg-indigo-600 text-white' : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              {opt.label} <span className={statusFilter === opt.key ? 'text-indigo-200' : 'text-slate-400'}>{statusCounts[opt.key]}</span>
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="mb-5 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-bold text-rose-700">{error}</div>
      )}

      {/* KPI tiles */}
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        <StatTile label="Clientes monitoreados" value={`${summary.monitoredClients}`} hint={`de ${summary.totalClients} clientes`} icon={Building2} tone="slate" />
        <StatTile label={`Exposición ${primaryCurrency}`} value={fmtCompact(summary.exposureByCurrency[primaryCurrency] || 0, primaryCurrency)} hint={otherCurrencies.length ? otherCurrencies.map(([c, v]) => fmtCompact(v, c)).join(' · ') : 'monto autorizado'} icon={TrendingUp} tone="indigo" />
        <StatTile label="Breach hoy" value={`${summary.clientsInBreach.length}`} hint={`${summary.clientsWithWarnings.length} en alerta`} icon={ShieldAlert} tone="rose" />
        <StatTile label="EEFF / docs vencidos" value={`${summary.overdueReporting.length}`} hint={summary.docsOutstandingTotal ? `${summary.docsOutstandingTotal} docs marcados` : 'por calendario'} icon={FileWarning} tone="amber" />
        <StatTile label="Vencimientos 90d" value={`${summary.upcomingMaturities.length}`} hint="contratos por vencer" icon={CalendarClock} tone="slate" />
        <StatTile label="En watchlist" value={`${summary.watchlist.length}`} hint="clientes con alertas" icon={AlertTriangle} tone="rose" />
      </div>

      {/* Risk distribution */}
      <div className="mb-5 rounded-xl border border-slate-300 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Gauge className="h-4 w-4 text-indigo-500" />
            <p className="text-xs font-black uppercase tracking-widest text-slate-900">Distribución de riesgo</p>
          </div>
          <div className="flex flex-wrap items-center gap-4 text-xs font-bold text-slate-700">
            {(['low', 'medium', 'high', 'unknown'] as const).map(band => (
              <span key={band} className="flex items-center gap-1.5">
                <span className={`h-2.5 w-2.5 rounded-full ${RISK_TONE[band]}`} />
                {RISK_LABEL[band]} · {summary.riskDistribution[band]}
              </span>
            ))}
          </div>
        </div>
        <div className="mt-4 flex h-4 w-full overflow-hidden rounded-full bg-slate-100">
          {(['high', 'medium', 'low', 'unknown'] as const).map(band => {
            const w = (summary.riskDistribution[band] / riskDenominator) * 100;
            if (!w) return null;
            return <div key={band} className={RISK_TONE[band]} style={{ width: `${w}%` }} title={`${RISK_LABEL[band]}: ${summary.riskDistribution[band]}`} />;
          })}
        </div>
        <p className="mt-3 flex items-start gap-1.5 text-[11px] font-semibold leading-4 text-slate-600">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          {CREDIT_RISK_DISCLAIMER}
        </p>
      </div>

      {/* Breach + Reporting */}
      <div className="mb-5 grid grid-cols-1 gap-4 xl:grid-cols-2">
        <SectionCard title="Covenants en breach hoy" count={summary.clientsInBreach.length} icon={ShieldAlert} accent="text-rose-500">
          {summary.clientsInBreach.length === 0 ? (
            <EmptyRow text="Ningún cliente en incumplimiento hoy." />
          ) : (
            summary.clientsInBreach.slice(0, 8).map(signal => (
              <ClientRow
                key={signal.client.id}
                signal={signal}
                onSelect={() => onSelectClient(signal.client.id)}
                sub={signal.worst ? `${signal.worst.name}${signal.worst.value != null ? ` · ${signal.worst.value.toFixed(2)}` : ''}` : `${signal.breachCount} covenant(s)`}
                right={<span className="rounded-md border border-rose-200 bg-rose-50 px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-rose-700">{signal.breachCount} breach</span>}
              />
            ))
          )}
        </SectionCard>

        <SectionCard title="EEFF / documentos vencidos" count={summary.overdueReporting.length} icon={FileWarning} accent="text-amber-500">
          {summary.overdueReporting.length === 0 ? (
            <EmptyRow text="Reporteo al día en toda la cartera." />
          ) : (
            summary.overdueReporting.slice(0, 8).map(signal => {
              const r = signal.reporting;
              const reason = r.reason === 'sin_eeff'
                ? 'Sin EEFF cargados'
                : r.isOverdue
                  ? `EEFF ${r.daysOverdue}d vencidos (${signal.client.frequency})`
                  : `${signal.docsOutstanding} doc(s) pendientes`;
              return (
                <ClientRow
                  key={signal.client.id}
                  signal={signal}
                  onSelect={() => onSelectClient(signal.client.id)}
                  sub={reason}
                  action={statusAction(signal)}
                  right={
                    r.reason === 'sin_eeff'
                      ? <span className="rounded-md border border-rose-200 bg-rose-50 px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-rose-700">Sin EEFF</span>
                      : signal.docsOutstanding > 0
                        ? <span className="rounded-md border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-amber-700">{signal.docsOutstanding} docs</span>
                        : <span className="rounded-md border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-amber-700">Vencido</span>
                  }
                />
              );
            })
          )}
        </SectionCard>
      </div>

      {/* Maturities + Watchlist */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <SectionCard title="Vencimientos próximos (90 días)" count={summary.upcomingMaturities.length} icon={CalendarClock} accent="text-indigo-500">
          {summary.upcomingMaturities.length === 0 ? (
            <EmptyRow text="Sin vencimientos en los próximos 90 días." />
          ) : (
            summary.upcomingMaturities.slice(0, 8).map(m => (
              <button
                key={m.transactionId}
                type="button"
                onClick={() => onSelectClient(m.client.id)}
                className="group flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-indigo-50/70"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-black text-slate-900 group-hover:text-indigo-700">{m.client.name}</p>
                  <p className="truncate text-xs font-semibold text-slate-500">{m.name} · {fmtCurrency(m.amount, m.currency)}</p>
                </div>
                <div className="flex flex-shrink-0 items-center gap-2">
                  <span className={`rounded-md border px-2 py-0.5 text-[10px] font-black uppercase tracking-wider ${m.days <= 15 ? 'border-rose-200 bg-rose-50 text-rose-700' : m.days <= 45 ? 'border-amber-200 bg-amber-50 text-amber-700' : 'border-slate-200 bg-slate-50 text-slate-600'}`}>
                    {m.days}d · {fmtDate(m.maturityAt)}
                  </span>
                  <ArrowRight className="h-4 w-4 text-slate-300 group-hover:text-indigo-500" />
                </div>
              </button>
            ))
          )}
        </SectionCard>

        <SectionCard title="Watchlist" count={summary.watchlist.length} icon={AlertTriangle} accent="text-rose-500">
          {summary.watchlist.length === 0 ? (
            <EmptyRow text="Sin alertas activas. Toda la cartera en verde." />
          ) : (
            summary.watchlist.slice(0, 8).map(signal => {
              const flags: string[] = [];
              if (signal.breachCount) flags.push(`${signal.breachCount} breach`);
              if (signal.warningCount) flags.push(`${signal.warningCount} alerta`);
              if (signal.reporting.reason === 'sin_eeff') flags.push('sin EEFF');
              else if (signal.reporting.isOverdue) flags.push('EEFF vencido');
              if (signal.docsOutstanding) flags.push(`${signal.docsOutstanding} docs`);
              if (signal.overdueActivities) flags.push(`${signal.overdueActivities} tarea vencida`);
              return (
                <ClientRow
                  key={signal.client.id}
                  signal={signal}
                  onSelect={() => onSelectClient(signal.client.id)}
                  sub={flags.join(' · ') || 'Riesgo elevado'}
                  action={statusAction(signal)}
                  right={<RiskBadge band={signal.risk?.riskBand} />}
                />
              );
            })
          )}
        </SectionCard>
      </div>
    </div>
  );
};

export default DashboardPage;
