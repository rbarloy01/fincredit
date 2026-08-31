import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowRight, Building2, CalendarClock, FileWarning,
  Gauge, Moon, ShieldAlert, ShieldCheck, TrendingUp, Briefcase, PieChart, Hourglass, Gavel,
} from 'lucide-react';
import { Client, ClientStatus, CrmActivity, Covenant_DB, FinancialStatement_DB, Transaction, db } from '../../db/index';
import { CREDIT_RISK_DISCLAIMER } from '../../lib/creditRiskModel';
import { buildPortfolioSummary, ClientSignal, PortfolioSummary } from '../../lib/portfolioAnalytics';
import { buildPipelineSummary, MasterOrgPipelineMeta, PipelineSummary } from '../../lib/pipelineAnalytics';
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

function fmtPct(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(0)}%`;
}

function fmtDays(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${Math.round(value)} d`;
}

const MONITORING_ESTATUS_TONE: Record<string, string> = {
  Cumplimiento: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  'Incumplimiento técnico': 'border-amber-200 bg-amber-50 text-amber-700',
  Incumplimiento: 'border-rose-200 bg-rose-50 text-rose-700',
};

const RESULTADO_TONE: Record<string, string> = {
  Aprobado: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  Cerrado: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  'Rechazado por Axcess': 'border-rose-200 bg-rose-50 text-rose-700',
  'Rechazado por cliente': 'border-rose-200 bg-rose-50 text-rose-700',
  Dormant: 'border-slate-200 bg-slate-50 text-slate-600',
};

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
  const [pipelineMetaByClient, setPipelineMetaByClient] = useState<Record<string, MasterOrgPipelineMeta>>({});
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
          const [nextStatements, nextCovenants, nextTransactions, nextActivities, nextPipelineMeta] = await Promise.all([
            db.getDashboardStatementsForClients(batch),
            db.getCovenantsForClients(batch),
            db.getTransactionsForClients(batch),
            db.getCrmActivitiesForClients(batch),
            db.getClientSettingsForClients<MasterOrgPipelineMeta>(batch, 'master_org_pipeline'),
          ]);
          if (!active) return;
          setStatementsByClient(prev => ({ ...prev, ...nextStatements }));
          setCovenantsByClient(prev => ({ ...prev, ...nextCovenants }));
          setTransactionsByClient(prev => ({ ...prev, ...nextTransactions }));
          setActivitiesByClient(prev => ({ ...prev, ...nextActivities }));
          setPipelineMetaByClient(prev => ({ ...prev, ...nextPipelineMeta }));
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

  const pipelineSummary: PipelineSummary = useMemo(
    () => buildPipelineSummary(filteredClients, activitiesByClient, pipelineMetaByClient, new Date()),
    [filteredClients, activitiesByClient, pipelineMetaByClient],
  );

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

      {/* Pipeline de Crédito (KPIs equivalentes a UWBR / Dashboard Ejecutivo del Master Org) */}
      <div className="mt-8 border-t border-slate-200 pt-6">
        <p className="mb-4 text-[11px] font-black uppercase tracking-[0.18em] text-indigo-600">Pipeline de crédito · Master Org</p>

        <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
          <StatTile label="Pipeline bruto" value={fmtCompact(pipelineSummary.underwriting.montoTotal)} hint={`${pipelineSummary.underwriting.deals} deals activos`} icon={Briefcase} tone="indigo" />
          <StatTile label="Pipeline ajustado" value={fmtCompact(pipelineSummary.underwriting.montoAjustado)} hint="ponderado × prob. por etapa" icon={Gauge} tone="slate" />
          <StatTile label="Nuevos prospectos" value={`${pipelineSummary.underwriting.nuevosProspectosTrimestre}`} hint="este trimestre" icon={TrendingUp} tone="emerald" />
          <StatTile label="Créditos activos (Monitoring)" value={`${pipelineSummary.monitoring.creditosActivos}`} hint={`${fmtCompact(pipelineSummary.monitoring.saldoVigente)} saldo vigente`} icon={Building2} tone="slate" />
          <StatTile label="Comité de crédito" value={`${pipelineSummary.comite.casos}`} hint={pipelineSummary.comite.proximaFecha ? `próximo: ${fmtDate(pipelineSummary.comite.proximaFecha)}` : 'sin fecha próxima'} icon={Gavel} tone="amber" />
        </div>

        <div className="mb-5 grid grid-cols-1 gap-4 xl:grid-cols-2">
          <SectionCard title="Underwriting por etapa" count={pipelineSummary.underwriting.deals} icon={Briefcase} accent="text-indigo-500">
            {pipelineSummary.underwriting.porEtapa.length === 0 ? (
              <EmptyRow text="Sin deals activos en el pipeline." />
            ) : (
              <div className="space-y-1.5 p-2">
                {pipelineSummary.underwriting.porEtapa.map(e => (
                  <div key={e.stage} className="flex items-center justify-between rounded-lg px-3 py-2 text-sm hover:bg-slate-50">
                    <span className="font-black text-slate-800">{e.stage}</span>
                    <span className="font-bold text-slate-500">{e.count} · {fmtCompact(e.monto)}</span>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>

          <SectionCard title="Monitoring por estatus" count={pipelineSummary.monitoring.creditosActivos} icon={PieChart} accent="text-emerald-500">
            {pipelineSummary.monitoring.porEstatus.length === 0 ? (
              <EmptyRow text="Sin créditos en monitoreo." />
            ) : (
              <>
                <div className="flex flex-wrap gap-2 p-2">
                  {pipelineSummary.monitoring.porEstatus.map(e => (
                    <span key={e.estatus} className={`rounded-md border px-2.5 py-1 text-[11px] font-black uppercase tracking-wider ${MONITORING_ESTATUS_TONE[e.estatus] || 'border-slate-200 bg-slate-50 text-slate-600'}`}>
                      {e.estatus} · {e.count}
                    </span>
                  ))}
                  <span className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-black uppercase tracking-wider text-slate-600">
                    % Utilización prom. · {fmtPct(pipelineSummary.monitoring.pctUtilizacionPromedio)}
                  </span>
                </div>
                {pipelineSummary.monitoring.clientesIncumplimiento.length > 0 && (
                  <div className="mt-1 space-y-1 border-t border-slate-100 p-2">
                    {pipelineSummary.monitoring.clientesIncumplimiento.map(c => (
                      <button
                        key={`${c.clientId}-${c.estatus}`}
                        type="button"
                        onClick={() => onSelectClient(c.clientId)}
                        className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm hover:bg-rose-50/60"
                      >
                        <span className="font-black text-slate-800">{c.name}</span>
                        <span className={`rounded-md border px-2 py-0.5 text-[10px] font-black uppercase tracking-wider ${MONITORING_ESTATUS_TONE[c.estatus] || 'border-slate-200 bg-slate-50 text-slate-600'}`}>{c.estatus}</span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </SectionCard>
        </div>

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <SectionCard title="Ciclo de vida promedio por etapa" icon={Hourglass} accent="text-slate-500">
            {pipelineSummary.cicloVidaPorEtapa.length === 0 ? (
              <EmptyRow text="Aún no hay suficiente historial de transiciones de etapa." />
            ) : (
              <div className="overflow-x-auto p-2">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="text-[10px] font-black uppercase tracking-wider text-slate-400">
                      <th className="px-3 py-1.5">Etapa</th>
                      <th className="px-3 py-1.5">Promedio</th>
                      <th className="px-3 py-1.5">Mínimo</th>
                      <th className="px-3 py-1.5">Máximo</th>
                      <th className="px-3 py-1.5">n</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pipelineSummary.cicloVidaPorEtapa.map(s => (
                      <tr key={s.stage} className="border-t border-slate-100">
                        <td className="px-3 py-2 font-black text-slate-800">{s.stage}</td>
                        <td className="px-3 py-2 font-bold text-slate-600">{fmtDays(s.avgDays)}</td>
                        <td className="px-3 py-2 font-bold text-slate-500">{fmtDays(s.minDays)}</td>
                        <td className="px-3 py-2 font-bold text-slate-500">{fmtDays(s.maxDays)}</td>
                        <td className="px-3 py-2 font-bold text-slate-400">{s.n}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>

          <SectionCard title="Eficiencia" icon={Moon} accent="text-slate-500">
            <div className="flex flex-wrap gap-2 p-2">
              {pipelineSummary.eficiencia.porResultado.map(r => (
                <span key={r.resultado} className={`rounded-md border px-2.5 py-1 text-[11px] font-black uppercase tracking-wider ${RESULTADO_TONE[r.resultado] || 'border-slate-200 bg-slate-50 text-slate-600'}`}>
                  {r.resultado} · {r.count}
                </span>
              ))}
              {pipelineSummary.eficiencia.porResultado.length === 0 && (
                <span className="text-xs font-semibold text-slate-400">Sin historial de deals cerrados/rechazados aún.</span>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3 border-t border-slate-100 p-3 sm:grid-cols-3">
              <div>
                <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">Dormant nuevos (trimestre)</p>
                <p className="text-xl font-black text-slate-900">{pipelineSummary.eficiencia.dormantTrimestre}</p>
              </div>
              <div>
                <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">Deal velocity prom.</p>
                <p className="text-xl font-black text-slate-900">{fmtDays(pipelineSummary.eficiencia.dealVelocityPromedioDias)}</p>
              </div>
              <div>
                <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">Motivo principal</p>
                <p className="truncate text-sm font-black text-slate-900">{pipelineSummary.eficiencia.motivosNoCierre[0]?.motivo || '—'}</p>
              </div>
            </div>
            {pipelineSummary.eficiencia.motivosNoCierre.length > 1 && (
              <div className="space-y-1 border-t border-slate-100 p-2">
                {pipelineSummary.eficiencia.motivosNoCierre.slice(1, 5).map(m => (
                  <div key={m.motivo} className="flex items-center justify-between rounded-lg px-3 py-1.5 text-xs">
                    <span className="font-bold text-slate-600">{m.motivo}</span>
                    <span className="font-black text-slate-400">{m.count}</span>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>
        </div>
      </div>
    </div>
  );
};

export default DashboardPage;
