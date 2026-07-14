import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Building2, CheckCircle2, ExternalLink, FileText, Search, TrendingUp } from 'lucide-react';
import { Client, ContractFile, CrmActivity, db, FinancialStatement_DB, LoanTape_DB, Transaction } from '../../db/index';

interface Props {
  onSelectClient: (clientId: string) => void;
}

function fmtCurrency(value: number, currency = 'MXN') {
  const prefix = currency === 'USD' ? 'USD ' : currency === 'EUR' ? 'EUR ' : '$';
  return `${prefix}${Math.round(value || 0).toLocaleString('es-MX')}`;
}

function pct(value: number) {
  if (!Number.isFinite(value)) return '0%';
  return `${Math.round(value)}%`;
}

function statusClass(value: string) {
  const normalized = value.toLowerCase();
  if (normalized.includes('vencid') || normalized.includes('sin actividad')) return 'bg-rose-100 text-rose-800 border-rose-200';
  if (normalized.includes('urgente') || normalized.includes('alta') || normalized.includes('pendiente')) return 'bg-amber-100 text-amber-800 border-amber-200';
  if (normalized.includes('complet')) return 'bg-emerald-100 text-emerald-800 border-emerald-200';
  return 'bg-slate-100 text-slate-700 border-slate-200';
}

function monitorClass(value: string) {
  if (value === 'Listo') return 'bg-emerald-100 text-emerald-800 border-emerald-200';
  if (value === 'Parcial') return 'bg-amber-100 text-amber-800 border-amber-200';
  return 'bg-slate-100 text-slate-600 border-slate-200';
}

function dateTime(value?: string) {
  if (!value) return Number.POSITIVE_INFINITY;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : Number.POSITIVE_INFINITY;
}

function fmtShortDate(value?: string) {
  if (!value) return 'Sin fecha';
  return new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium' }).format(new Date(value));
}

function activityDate(activity?: CrmActivity) {
  return activity?.completedAt || activity?.dueAt || activity?.createdAt;
}

function openActivities(activities: CrmActivity[] = []) {
  return activities.filter(activity => activity.status === 'planned');
}

function urgentActivity(activities: CrmActivity[] = []) {
  const priorityRank = { high: 0, normal: 1, low: 2 };
  return openActivities(activities).sort((a, b) => (
    dateTime(a.dueAt) - dateTime(b.dueAt)
    || priorityRank[a.priority] - priorityRank[b.priority]
    || dateTime(a.createdAt) - dateTime(b.createdAt)
  ))[0];
}

function latestActivity(activities: CrmActivity[] = []) {
  return [...activities].sort((a, b) => {
    const aDate = new Date(a.completedAt || a.dueAt || a.createdAt).getTime();
    const bDate = new Date(b.completedAt || b.dueAt || b.createdAt).getTime();
    return bDate - aDate;
  })[0];
}

function rowDateSort(a?: CrmActivity, b?: CrmActivity) {
  return dateTime(activityDate(b)) - dateTime(activityDate(a));
}

function rowActivityStatus(activities: CrmActivity[] = []) {
  const open = openActivities(activities);
  const urgent = urgentActivity(activities);
  const latest = latestActivity(activities);
  const now = Date.now();
  const threeDays = 3 * 24 * 60 * 60 * 1000;

  if (urgent?.dueAt && dateTime(urgent.dueAt) < now) return 'Vencido';
  if (urgent?.dueAt && dateTime(urgent.dueAt) <= now + threeDays) return 'Urgente';
  if (urgent?.priority === 'high') return 'Prioridad alta';
  if (open.length) return 'Pendiente';
  if (latest?.status === 'done') return 'Completado';
  if (latest?.status === 'canceled') return 'Cancelado';
  return 'Sin actividad CRM';
}

function urgencyRank(activities: CrmActivity[] = []) {
  const urgent = urgentActivity(activities);
  if (!urgent) return Number.POSITIVE_INFINITY;
  const overduePenalty = urgent.dueAt && dateTime(urgent.dueAt) < Date.now() ? -1_000_000_000 : 0;
  const priorityPenalty = urgent.priority === 'high' ? -100_000_000 : urgent.priority === 'normal' ? 0 : 100_000_000;
  return dateTime(urgent.dueAt) + overduePenalty + priorityPenalty;
}

function monitoringStatus(statements: FinancialStatement_DB[] = [], loanTapes: LoanTape_DB[] = []) {
  if (statements.length && loanTapes.length) return 'Listo';
  if (statements.length || loanTapes.length) return 'Parcial';
  return 'Pendiente';
}

const CrmDashboardPage: React.FC<Props> = ({ onSelectClient }) => {
  const [clients, setClients] = useState<Client[]>([]);
  const [transactionsByClient, setTransactionsByClient] = useState<Record<string, Transaction[]>>({});
  const [activitiesByClient, setActivitiesByClient] = useState<Record<string, CrmActivity[]>>({});
  const [contractFilesByTransaction, setContractFilesByTransaction] = useState<Record<string, ContractFile[]>>({});
  const [statementsByClient, setStatementsByClient] = useState<Record<string, FinancialStatement_DB[]>>({});
  const [loanTapesByClient, setLoanTapesByClient] = useState<Record<string, LoanTape_DB[]>>({});
  const [openingFileId, setOpeningFileId] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    const load = async () => {
      setLoading(true);
      setError('');
      try {
        const nextClients = await db.getClients();
        const clientIds = nextClients.map(client => client.id);
        const [nextTransactions, nextActivities, nextStatements, nextLoanTapes] = await Promise.all([
          db.getTransactionsForClients(clientIds),
          db.getCrmActivitiesForClients(clientIds),
          db.getStatementsForClients(clientIds),
          db.getLoanTapesForClients(clientIds),
        ]);
        const transactionIds = Object.values(nextTransactions).flat().map(tx => tx.id);
        const nextContractFiles = await db.getContractFilesForTransactions(transactionIds);
        if (!active) return;
        setClients(nextClients);
        setTransactionsByClient(nextTransactions);
        setActivitiesByClient(nextActivities);
        setContractFilesByTransaction(nextContractFiles);
        setStatementsByClient(nextStatements);
        setLoanTapesByClient(nextLoanTapes);
      } catch (err: any) {
        if (active) setError(err.message || 'No se pudo cargar CRM.');
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => { active = false; };
  }, []);

  const rows = useMemo(() => {
    return clients.flatMap(client => {
      const transactions = transactionsByClient[client.id] || [];
      const activities = activitiesByClient[client.id] || [];
      const latest = latestActivity(activities);
      const urgent = urgentActivity(activities);
      const status = rowActivityStatus(activities);
      const statements = statementsByClient[client.id] || [];
      const loanTapes = loanTapesByClient[client.id] || [];
      const monitor = monitoringStatus(statements, loanTapes);
      const baseRows = transactions.length ? transactions : [{
        id: `${client.id}-portfolio`,
        clientId: client.id,
        name: client.contractName || 'Portafolio',
        description: '',
        date: '',
        creditType: client.creditType?.[0] || '',
        originalAmount: client.totalCreditValue,
        currency: client.currency,
        signedAt: '',
        maturityAt: '',
        createdBy: '',
        createdAt: client.createdAt,
      }];
      return baseRows.map(tx => {
        const amount = tx.originalAmount || client.totalCreditValue || 0;
        const balance = client.currentDue || amount;
        const contractFiles = contractFilesByTransaction[tx.id] || [];
        return {
          id: tx.id,
          client,
          transaction: tx,
          latest,
          urgent,
          contractFiles,
          contract: tx.name || client.contractName || tx.creditType || 'Sin contrato',
          amount,
          balance,
          utilization: amount ? (balance / amount) * 100 : 0,
          status,
          monitor,
          monitorDetail: `${statements.length} EEFF · ${loanTapes.length} loan tape${loanTapes.length === 1 ? '' : 's'}`,
          sortKey: urgencyRank(activities),
        };
      });
    }).filter(row => {
      const q = search.trim().toLowerCase();
      if (!q) return true;
      return [
        row.contract,
        row.client.name,
        row.client.taxId,
        row.client.industry,
        row.client.analystName,
        row.monitor,
        row.latest?.analystName,
        row.latest?.quickNote,
        row.latest?.nextStep,
        row.urgent?.subject,
        row.urgent?.nextStep,
        row.status,
      ].filter(Boolean).join(' ').toLowerCase().includes(q);
    }).sort((a, b) => a.sortKey - b.sortKey || rowDateSort(a.latest, b.latest) || a.client.name.localeCompare(b.client.name));
  }, [clients, transactionsByClient, activitiesByClient, contractFilesByTransaction, statementsByClient, loanTapesByClient, search]);

  const openContractFile = async (file: ContractFile) => {
    setOpeningFileId(file.id);
    const target = window.open('', '_blank', 'noopener,noreferrer');
    try {
      let url = '';
      if (file.sourceDocumentId) {
        url = await db.createSignedDocumentUrl(file.sourceDocumentId, 180);
      } else if (file.base64Data) {
        url = file.base64Data.startsWith('data:')
          ? file.base64Data
          : `data:${file.mimeType || 'application/octet-stream'};base64,${file.base64Data}`;
      } else {
        throw new Error('El contrato no tiene archivo asociado para abrir.');
      }
      if (target) target.location.href = url;
      else window.open(url, '_blank', 'noopener,noreferrer');
    } catch (err: any) {
      target?.close();
      setError(err.message || 'No se pudo abrir el documento.');
    } finally {
      setOpeningFileId('');
    }
  };

  const exposure = rows.reduce((sum, row) => sum + row.amount, 0);
  const balance = rows.reduce((sum, row) => sum + row.balance, 0);
  const risky = rows.filter(row => ['vencido', 'urgente', 'prioridad alta', 'sin actividad crm'].includes(row.status.toLowerCase())).length;

  const metrics = [
    { label: 'Clientes', value: clients.length.toLocaleString('es-MX'), icon: Building2, tone: 'slate' },
    { label: 'Monto autorizado', value: fmtCurrency(exposure), icon: TrendingUp, tone: 'blue' },
    { label: 'Saldo actual', value: fmtCurrency(balance), icon: CheckCircle2, tone: 'emerald' },
    { label: 'Alertas abiertas', value: risky.toLocaleString('es-MX'), icon: AlertTriangle, tone: 'rose' },
  ];

  return (
    <div className="crm-page min-h-screen px-5 py-6 md:px-8">
      <div className="mb-5 flex flex-col gap-4 border-b border-slate-200/80 pb-5 xl:flex-row xl:items-end xl:justify-between">
        <div className="max-w-2xl">
          <p className="text-[11px] font-black uppercase tracking-[0.18em] text-blue-700">Tracker comercial</p>
          <h1 className="mt-1 text-3xl font-black tracking-tight text-slate-950">CRM</h1>
          <p className="mt-1 text-sm font-semibold text-slate-500">Contratos, seguimiento y monitoreo en una vista de trabajo.</p>
        </div>
        <div className="relative w-full xl:w-[28rem]">
          <Search className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            value={search}
            onChange={event => setSearch(event.target.value)}
            placeholder="Buscar contrato, cliente, analista o siguiente paso..."
            className="crm-input w-full rounded-lg border border-slate-300 bg-white py-3 pl-11 pr-4 text-sm font-semibold text-slate-800 outline-none focus:ring-2 focus:ring-blue-200"
          />
        </div>
      </div>

      <div className="mb-5 grid grid-cols-1 gap-3 md:grid-cols-4">
        {metrics.map(metric => {
          const Icon = metric.icon;
          return (
            <div key={metric.label} className={`crm-card crm-metric crm-metric-${metric.tone}`}>
              <div className="flex items-center justify-between gap-3">
                <p className="text-[11px] font-black uppercase tracking-wider text-slate-500">{metric.label}</p>
                <span className="crm-metric-icon">
                  <Icon className="h-4 w-4" />
                </span>
              </div>
              <p className="mt-3 truncate text-2xl font-black tracking-tight text-slate-950">{metric.value}</p>
            </div>
          );
        })}
      </div>

      {error && (
        <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-800">
          {error}
        </div>
      )}

      <div className="crm-card overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-3">
          <p className="text-xs font-black uppercase tracking-widest text-slate-600">Pipeline de seguimiento</p>
          <p className="text-xs font-bold text-slate-500">{rows.length.toLocaleString('es-MX')} registros</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1280px] text-left text-sm">
            <thead className="bg-white">
              <tr>
                {['Contrato', 'Cliente', 'RFC', 'Industria', 'Term Sheet', 'Monitoreo', 'Monto', 'Saldo Actual', '% Utilización', 'Estatus CRM', 'Analista', 'Última actualización', 'Siguiente paso'].map(header => (
                  <th key={header} className="whitespace-nowrap border-b border-slate-200 px-4 py-3 text-[10px] font-black uppercase tracking-widest text-slate-500">{header}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading && (
                <tr>
                  <td colSpan={13} className="px-4 py-12 text-center text-sm font-bold text-slate-400">Cargando CRM...</td>
                </tr>
              )}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={13} className="px-4 py-12 text-center text-sm font-bold text-slate-400">Sin registros de seguimiento</td>
                </tr>
              )}
              {!loading && rows.map(row => (
                <tr key={`${row.client.id}-${row.id}`} className="transition-colors hover:bg-blue-50/60">
                  <td className="max-w-[16rem] px-4 py-3 font-black text-slate-900">
                    <span className="line-clamp-2">{row.contract}</span>
                  </td>
                  <td className="px-4 py-3">
                    <button onClick={() => onSelectClient(row.client.id)} className="text-left font-black text-blue-700 hover:text-blue-500">
                      {row.client.name}
                    </button>
                  </td>
                  <td className="px-4 py-3 font-semibold text-slate-600">{row.client.taxId || '-'}</td>
                  <td className="px-4 py-3 font-semibold text-slate-600">{row.client.industry || '-'}</td>
                  <td className="px-4 py-3">
                    {row.contractFiles[0] ? (
                      <button
                        onClick={() => openContractFile(row.contractFiles[0])}
                        disabled={openingFileId === row.contractFiles[0].id}
                        className="inline-flex items-center gap-1 rounded-md border border-blue-200 bg-blue-50 px-2 py-1 text-[10px] font-black uppercase tracking-wider text-blue-700 hover:bg-blue-100 disabled:opacity-50"
                        title={row.contractFiles[0].originalName}
                      >
                        <FileText className="h-3.5 w-3.5" />
                        {openingFileId === row.contractFiles[0].id ? 'Abriendo' : 'Abrir'}
                        <ExternalLink className="h-3 w-3" />
                      </button>
                    ) : (
                      <span className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-[10px] font-black uppercase tracking-wider text-slate-500">Sin archivo</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span title={row.monitorDetail} className={`rounded-md border px-2 py-1 text-[10px] font-black uppercase tracking-wider ${monitorClass(row.monitor)}`}>{row.monitor}</span>
                  </td>
                  <td className="px-4 py-3 font-mono font-bold text-slate-700">{fmtCurrency(row.amount, row.transaction.currency || row.client.currency)}</td>
                  <td className="px-4 py-3 font-mono font-bold text-slate-700">{fmtCurrency(row.balance, row.transaction.currency || row.client.currency)}</td>
                  <td className="px-4 py-3 font-mono font-bold text-slate-700">{pct(row.utilization)}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-md border px-2 py-1 text-[10px] font-black uppercase tracking-wider ${statusClass(row.status)}`}>{row.status}</span>
                  </td>
                  <td className="px-4 py-3 font-bold text-slate-600">{row.urgent?.analystName || row.latest?.analystName || row.client.analystName || '-'}</td>
                  <td className="max-w-sm px-4 py-3 text-xs font-semibold leading-5 text-slate-600">
                    {row.latest ? (
                      <>
                        <span className="font-black text-slate-700">{fmtShortDate(activityDate(row.latest))}</span>
                        {row.latest.quickNote || row.latest.detail ? ` · ${row.latest.quickNote || row.latest.detail}` : ''}
                      </>
                    ) : '-'}
                  </td>
                  <td className="max-w-sm px-4 py-3 text-xs font-bold leading-5 text-slate-700">
                    {row.urgent?.nextStep || row.urgent?.subject || row.latest?.nextStep || '-'}
                    {row.urgent?.dueAt && <span className="mt-1 block font-semibold text-slate-400">Vence {fmtShortDate(row.urgent.dueAt)}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default CrmDashboardPage;
