import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  CircleDollarSign,
  ClipboardCheck,
  FileSpreadsheet,
  FileText,
  Filter,
  Landmark,
  Loader2,
  Search,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import { db, Client, Covenant_DB, FinancialStatement_DB, LoanTape_DB, Transaction } from '../../db/index';
import { ALL_FACILITIES, facilityDisplayName, matchesFacilityFilter } from '../../lib/facilityHistory';
import { evaluateCovenantAuto } from '../../lib/financialMetrics';
import { parseFinancialNumber } from '../../lib/numberParsing';

type Disposition = {
  id: string;
  date: string;
  amount: string;
  currency: string;
  notes: string;
};

type DispositionMap = Record<string, Disposition[]>;

const dispositionsKey = (clientId: string) => `finmonitor_transaction_dispositions_${clientId}`;

type LifeRow = {
  client: Client;
  transactions: Transaction[];
  statements: FinancialStatement_DB[];
  covenants: Covenant_DB[];
  loanTapes: LoanTape_DB[];
  dispositions: DispositionMap;
};

type TimelineEvent = {
  id: string;
  date: string;
  periodLabel: string;
  title: string;
  detail: string;
  type: 'contract' | 'disposition' | 'payment' | 'aforo' | 'statement' | 'loantape' | 'covenant' | 'maturity';
  severity: 'good' | 'warning' | 'bad' | 'info';
  amount?: number;
  currency?: string;
  meta?: string;
};

type FacilitySummary = {
  id: string;
  name: string;
  type: string;
  amount: number;
  currency: string;
  startDate: string;
  endDate: string;
  status: 'vigente' | 'vencida' | 'sin-fecha';
};

const eventIcon = {
  contract: Landmark,
  disposition: CircleDollarSign,
  payment: CircleDollarSign,
  aforo: ShieldCheck,
  statement: FileText,
  loantape: FileSpreadsheet,
  covenant: ClipboardCheck,
  maturity: CalendarDays,
};

const severityClass = {
  good: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  warning: 'bg-amber-50 text-amber-700 border-amber-200',
  bad: 'bg-rose-50 text-rose-700 border-rose-200',
  info: 'bg-indigo-50 text-indigo-700 border-indigo-200',
};

const dotClass = {
  good: 'bg-emerald-500',
  warning: 'bg-amber-500',
  bad: 'bg-rose-500',
  info: 'bg-indigo-500',
};

function parsePeriodDate(value?: string) {
  if (!value) return '';
  const clean = String(value).trim();
  if (/^\d{4}-\d{2}/.test(clean)) return clean.length === 7 ? `${clean}-01` : clean.substring(0, 10);

  const monthMap: Record<string, string> = {
    ene: '01',
    feb: '02',
    mar: '03',
    abr: '04',
    may: '05',
    jun: '06',
    jul: '07',
    ago: '08',
    sep: '09',
    oct: '10',
    nov: '11',
    dic: '12',
  };
  const match = clean.toLowerCase().match(/(ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic)[\s-]*(\d{2,4})/);
  if (!match) return '';
  const year = match[2].length === 2 ? `20${match[2]}` : match[2];
  return `${year}-${monthMap[match[1]]}-01`;
}

function fmtDate(value?: string) {
  if (!value) return 'Sin fecha';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return new Intl.DateTimeFormat('es-MX', { month: 'short', year: 'numeric' }).format(d).replace('.', '');
}

function fmtFullDate(value?: string) {
  if (!value) return 'Sin fecha';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return new Intl.DateTimeFormat('es-MX', { day: '2-digit', month: 'short', year: 'numeric' }).format(d).replace('.', '');
}

function fmtCurrency(value: number | undefined, currency: string) {
  if (value === undefined || value === null) return '';
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(value);
}

function facilityStartDate(tx: Transaction) {
  return tx.signedAt || tx.date || tx.createdAt || '';
}

function facilityEndDate(tx: Transaction) {
  return tx.maturityAt || '';
}

function facilitySummaries(row: LifeRow): FacilitySummary[] {
  return row.transactions.map(tx => {
    const startDate = facilityStartDate(tx);
    const endDate = facilityEndDate(tx);
    const endTime = endDate ? new Date(endDate).getTime() : NaN;
    const status: FacilitySummary['status'] = !endDate ? 'sin-fecha' : endTime < Date.now() ? 'vencida' : 'vigente';
    return {
      id: tx.id,
      name: tx.name || tx.creditType || 'Facility sin nombre',
      type: tx.creditType || row.client.creditType?.join(', ') || 'Sin tipo',
      amount: tx.originalAmount || 0,
      currency: tx.currency || row.client.currency || 'MXN',
      startDate,
      endDate,
      status,
    };
  }).sort((a, b) => new Date(b.startDate || 0).getTime() - new Date(a.startDate || 0).getTime());
}

function loanRows(tape: LoanTape_DB) {
  const data = tape.extractedData;
  if (Array.isArray(data?._standardized)) return data._standardized;
  if (Array.isArray(data?.rows)) return data.rows;
  return Array.isArray(data) ? data : [];
}

function tapeStats(tape: LoanTape_DB) {
  const analysis = tape.extractedData?._analysis;
  const rows = loanRows(tape);
  const total = rows.reduce((sum: number, row: any) => sum + Number(row.outstanding_balance || row.balance || row.amount || 0), 0);
  const overdue = rows.filter((row: any) => Number(row.days_overdue || row.dpd || 0) > 0);
  const severe = rows.filter((row: any) => Number(row.days_overdue || row.dpd || 0) > 90);
  return {
    count: rows.length || analysis?.summary?.loan_count || 0,
    total: total || analysis?.summary?.total_balance || 0,
    overdue: overdue.length,
    severe: severe.length,
  };
}

function covenantSeverity(status: string): TimelineEvent['severity'] {
  if (status === 'incumple') return 'bad';
  if (status === 'alerta') return 'warning';
  if (status === 'cumple') return 'good';
  return 'info';
}

function buildEvents(row: LifeRow, selectedTransactionId: string): TimelineEvent[] {
  const { client, transactions, statements, covenants, loanTapes, dispositions } = row;
  const currency = client.currency || 'MXN';
  const selectedTransaction = selectedTransactionId === ALL_FACILITIES
    ? undefined
    : transactions.find(tx => tx.id === selectedTransactionId);
  const txs = selectedTransaction ? [selectedTransaction] : transactions;

  const events: TimelineEvent[] = [];

  txs.forEach(tx => {
    const startDate = tx.signedAt || tx.date || tx.createdAt;
    if (startDate) {
      events.push({
        id: `contract-${tx.id}`,
        date: startDate,
        periodLabel: fmtDate(startDate),
        title: `Alta de crédito: ${tx.name || tx.creditType || 'Crédito'}`,
        detail: tx.description || `Monto original ${fmtCurrency(tx.originalAmount, tx.currency || currency) || 'sin monto capturado'}.`,
        type: 'contract',
        severity: 'info',
        amount: tx.originalAmount,
        currency: tx.currency || currency,
        meta: tx.creditType || client.creditType?.join(', '),
      });
    }
    if (tx.maturityAt) {
      const isPastDue = new Date(tx.maturityAt).getTime() < Date.now();
      events.push({
        id: `maturity-${tx.id}`,
        date: tx.maturityAt,
        periodLabel: fmtDate(tx.maturityAt),
        title: `Vencimiento de ${tx.name || 'crédito'}`,
        detail: isPastDue ? 'Fecha de vencimiento ya transcurrida.' : 'Vencimiento programado del crédito.',
        type: 'maturity',
        severity: isPastDue ? 'warning' : 'info',
        meta: tx.creditType,
      });
    }

    (dispositions[tx.id] || []).forEach(disposition => {
      const amount = parseFinancialNumber(disposition.amount);
      const dispositionCurrency = disposition.currency || tx.currency || currency;
      const note = disposition.notes?.trim();
      events.push({
        id: `disposition-${tx.id}-${disposition.id}`,
        date: disposition.date,
        periodLabel: fmtFullDate(disposition.date),
        title: `Desembolso de ${tx.name || tx.creditType || 'facility'}`,
        detail: note || 'Disposición registrada sin nota adicional.',
        type: 'disposition',
        severity: 'good',
        amount,
        currency: dispositionCurrency,
        meta: tx.name || tx.creditType,
      });
    });
  });

  client.paymentHistory
    ?.filter(payment => matchesFacilityFilter(payment, selectedTransactionId, transactions.length))
    .forEach((payment, index) => {
      const date = parsePeriodDate(payment.month) || client.reportDate || client.createdAt;
      const hasBreach = payment.principalStatus === 'unpaid' || payment.interestStatus === 'unpaid';
      events.push({
        id: `payment-${payment.transactionId || 'general'}-${index}-${payment.month}`,
        date,
        periodLabel: payment.month,
        title: hasBreach ? 'Pago con atraso' : 'Pago registrado',
        detail: `Capital: ${payment.principalStatus}. Interés: ${payment.interestStatus}.`,
        type: 'payment',
        severity: hasBreach ? 'bad' : payment.principalStatus === 'none' && payment.interestStatus === 'none' ? 'warning' : 'good',
        meta: facilityDisplayName(transactions.find(tx => tx.id === payment.transactionId)?.name || '', payment),
      });
    });

  client.aforoHistory
    ?.filter(aforo => matchesFacilityFilter(aforo, selectedTransactionId, transactions.length))
    .forEach((aforo, index) => {
      const date = parsePeriodDate(aforo.month) || client.reportDate || client.createdAt;
      const facilityName = facilityDisplayName(transactions.find(tx => tx.id === aforo.transactionId)?.name || '', aforo);
      events.push({
        id: `aforo-${aforo.transactionId || 'general'}-${index}-${aforo.month}`,
        date,
        periodLabel: aforo.month,
        title: aforo.status === 'good' ? 'Aforo en cumplimiento' : aforo.status === 'warning' ? 'Aforo en alerta' : 'Aforo incumplido',
        detail: `Aforo observado ${aforo.value}. Requerido ${client.aforoRequerido || 'N/D'}.`,
        type: 'aforo',
        severity: aforo.status === 'good' ? 'good' : aforo.status === 'warning' ? 'warning' : 'bad',
        meta: facilityName,
      });
    });

  statements.forEach(statement => {
    events.push({
      id: `statement-${statement.id}`,
      date: statement.periodDate || statement.uploadDate,
      periodLabel: statement.period || fmtDate(statement.periodDate),
      title: 'Estado financiero cargado',
      detail: statement.fileName || statement.documentType || 'Documento financiero',
      type: 'statement',
      severity: 'info',
      meta: statement.documentType,
    });
  });

  loanTapes.forEach(tape => {
    const stats = tapeStats(tape);
    events.push({
      id: `loantape-${tape.id}`,
      date: tape.uploadDate,
      periodLabel: fmtDate(tape.uploadDate),
      title: 'Loan tape actualizado',
      detail: `${stats.count} créditos, ${fmtCurrency(stats.total, currency) || 'saldo no calculado'}${stats.overdue ? `, ${stats.overdue} con mora` : ''}.`,
      type: 'loantape',
      severity: stats.severe ? 'bad' : stats.overdue ? 'warning' : 'good',
      meta: tape.fileName || tape.name,
    });
  });

  covenants
    .filter(covenant => matchesFacilityFilter(covenant, selectedTransactionId, transactions.length))
    .forEach(covenant => {
      const status = evaluateCovenantAuto(covenant, statements).status;
      events.push({
        id: `covenant-${covenant.id}`,
        date: covenant.createdAt,
        periodLabel: fmtDate(covenant.createdAt),
        title: covenant.type === 'financial' ? `Covenant financiero: ${covenant.name}` : `Covenant ${covenant.type}: ${covenant.name}`,
        detail: covenant.description || `Umbral ${covenant.operator} ${covenant.threshold || 'N/D'}.`,
        type: 'covenant',
        severity: covenantSeverity(status),
        meta: status,
      });
    });

  return events
    .filter(event => event.date)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

function eventScore(event: TimelineEvent) {
  if (event.severity === 'bad') return -2;
  if (event.severity === 'warning') return -1;
  if (event.severity === 'good') return 1;
  return 0;
}

const LifecyclePage: React.FC = () => {
  const [rows, setRows] = useState<LifeRow[]>([]);
  const [selectedClientId, setSelectedClientId] = useState<string>(ALL_FACILITIES);
  const [selectedTransactionId, setSelectedTransactionId] = useState<string>(ALL_FACILITIES);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const clients = await db.getClients();
        const loaded = await Promise.all(clients.map(async client => {
          const [transactions, statements, covenants, loanTapes, dispositions] = await Promise.all([
            db.getTransactions(client.id),
            db.getStatements(client.id),
            db.getCovenants(client.id),
            db.getLoanTapes(client.id),
            db.getClientSetting<DispositionMap>(client.id, dispositionsKey(client.id), {}),
          ]);
          return { client, transactions, statements, covenants, loanTapes, dispositions };
        }));
        if (active) {
          setRows(loaded);
          if (loaded.length && selectedClientId === 'all') setSelectedClientId(loaded[0].client.id);
        }
      } catch (err: any) {
        if (active) setError(err.message || 'No se pudo cargar la línea de vida.');
      } finally {
        if (active) setLoading(false);
      }
    };
    load();
    return () => { active = false; };
  }, []);

  const selectedRow = useMemo(() => {
    return rows.find(row => row.client.id === selectedClientId) || rows[0];
  }, [rows, selectedClientId]);

  const transactionOptions = selectedRow?.transactions || [];

  useEffect(() => {
    setSelectedTransactionId(ALL_FACILITIES);
  }, [selectedClientId]);

  const events = useMemo(() => {
    if (!selectedRow) return [];
    return buildEvents(selectedRow, selectedTransactionId);
  }, [selectedRow, selectedTransactionId]);

  const facilities = useMemo(() => {
    if (!selectedRow) return [];
    return facilitySummaries(selectedRow);
  }, [selectedRow]);

  const filteredEvents = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return events;
    return events.filter(event => (
      event.title.toLowerCase().includes(q) ||
      event.detail.toLowerCase().includes(q) ||
      event.periodLabel.toLowerCase().includes(q) ||
      event.meta?.toLowerCase().includes(q)
    ));
  }, [events, search]);

  const summary = useMemo(() => {
    const balance = selectedRow?.loanTapes.at(0) ? tapeStats(selectedRow.loanTapes.at(0)!).total : selectedRow?.client.totalCreditValue || 0;
    return {
      credits: selectedRow?.transactions.length || 0,
      events: events.length,
      riskEvents: events.filter(event => event.severity === 'bad' || event.severity === 'warning').length,
      health: events.reduce((sum, event) => sum + eventScore(event), 0),
      balance,
    };
  }, [selectedRow, events]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-5 py-4 text-sm font-black text-slate-600 shadow-sm">
          <Loader2 className="h-5 w-5 animate-spin text-indigo-600" />
          Cargando línea de vida...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-slate-50 p-8">
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-6 text-rose-700">
          <p className="font-black">No se pudo cargar la sección</p>
          <p className="mt-1 text-sm font-semibold">{error}</p>
        </div>
      </div>
    );
  }

  if (!selectedRow) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-slate-50 p-8 text-center">
        <Activity className="mb-4 h-12 w-12 text-slate-300" />
        <h1 className="text-2xl font-black text-slate-900">Línea de vida</h1>
        <p className="mt-2 text-sm font-semibold text-slate-500">Crea un cliente para comenzar a visualizar la vida de sus créditos.</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 p-8">
      <div className="mb-8 flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-indigo-100 bg-indigo-50 px-3 py-1 text-[11px] font-black uppercase tracking-widest text-indigo-700">
            <Activity className="h-3.5 w-3.5" />
            Monitoreo por crédito
          </div>
          <h1 className="text-3xl font-black tracking-tight text-slate-900">Línea de vida</h1>
          <p className="mt-1 max-w-2xl text-sm font-semibold text-slate-500">
            Cronología de contratos, pagos, aforo, covenants, estados financieros y loan tapes para cada crédito.
          </p>
        </div>

        <div className="grid gap-3 md:grid-cols-3 xl:min-w-[740px]">
          <label className="block">
            <span className="mb-1 block text-[10px] font-black uppercase tracking-widest text-slate-400">Cliente</span>
            <select
              value={selectedClientId}
              onChange={event => setSelectedClientId(event.target.value)}
              className="h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-bold text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300"
            >
              {rows.map(row => (
                <option key={row.client.id} value={row.client.id}>{row.client.name}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-[10px] font-black uppercase tracking-widest text-slate-400">Crédito</span>
            <select
              value={selectedTransactionId}
              onChange={event => setSelectedTransactionId(event.target.value)}
              className="h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-bold text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300"
            >
              <option value={ALL_FACILITIES}>Todos los créditos</option>
              {transactionOptions.map(tx => (
                <option key={tx.id} value={tx.id}>{tx.name || tx.creditType || 'Crédito sin nombre'}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-[10px] font-black uppercase tracking-widest text-slate-400">Buscar hito</span>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                value={search}
                onChange={event => setSearch(event.target.value)}
                placeholder="Pago, covenant, loan tape..."
                className="h-11 w-full rounded-xl border border-slate-200 bg-white pl-9 pr-3 text-sm font-bold text-slate-700 outline-none focus:ring-2 focus:ring-indigo-300"
              />
            </div>
          </label>
        </div>
      </div>

      <div className="mb-8 grid grid-cols-2 gap-4 xl:grid-cols-5">
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Cliente</p>
          <p className="mt-1 truncate text-lg font-black text-slate-900">{selectedRow.client.name}</p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Créditos</p>
          <p className="mt-1 text-2xl font-black text-slate-900">{summary.credits}</p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Hitos</p>
          <p className="mt-1 text-2xl font-black text-slate-900">{summary.events}</p>
        </div>
        <div className="rounded-2xl border border-amber-200 bg-white p-4">
          <p className="flex items-center gap-1 text-[10px] font-black uppercase tracking-widest text-amber-600">
            <AlertTriangle className="h-3.5 w-3.5" />
            Alertas
          </p>
          <p className="mt-1 text-2xl font-black text-amber-700">{summary.riskEvents}</p>
        </div>
        <div className="rounded-2xl border border-indigo-200 bg-white p-4">
          <p className="text-[10px] font-black uppercase tracking-widest text-indigo-600">Saldo base</p>
          <p className="mt-1 text-lg font-black text-indigo-800">{fmtCurrency(summary.balance, selectedRow.client.currency)}</p>
        </div>
      </div>

      <section className="mb-8 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="mb-5 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-sm font-black uppercase tracking-widest text-slate-900">Facilities</h2>
            <p className="mt-1 text-xs font-semibold text-slate-500">Fechas de inicio y fin por cada crédito/facility del cliente.</p>
          </div>
          <button
            onClick={() => setSelectedTransactionId(ALL_FACILITIES)}
            className={`inline-flex items-center justify-center rounded-xl px-3 py-2 text-xs font-black transition-all ${
              selectedTransactionId === ALL_FACILITIES
                ? 'bg-indigo-600 text-white shadow-md shadow-indigo-100'
                : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
            }`}
          >
            Ver todas
          </button>
        </div>

        {facilities.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-6 text-center">
            <p className="text-sm font-black text-slate-700">Sin facilities capturadas</p>
            <p className="mt-1 text-xs font-semibold text-slate-500">Agrega transacciones/créditos para ver fecha inicio y fecha fin.</p>
          </div>
        ) : (
          <div className="grid gap-3 xl:grid-cols-2">
            {facilities.map(facility => {
              const active = selectedTransactionId === facility.id;
              return (
                <button
                  key={facility.id}
                  onClick={() => setSelectedTransactionId(facility.id)}
                  className={`text-left rounded-2xl border p-4 transition-all ${
                    active
                      ? 'border-indigo-300 bg-indigo-50 shadow-md shadow-indigo-100'
                      : 'border-slate-200 bg-white hover:border-indigo-200 hover:bg-slate-50'
                  }`}
                >
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-black text-slate-900">{facility.name}</span>
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-black uppercase ${
                          facility.status === 'vigente'
                            ? 'bg-emerald-100 text-emerald-700'
                            : facility.status === 'vencida'
                              ? 'bg-amber-100 text-amber-700'
                              : 'bg-slate-100 text-slate-600'
                        }`}>
                          {facility.status === 'vigente' ? 'Vigente' : facility.status === 'vencida' ? 'Vencida' : 'Sin fecha fin'}
                        </span>
                      </div>
                      <p className="mt-1 text-xs font-semibold text-slate-500">{facility.type}</p>
                    </div>
                    <p className="text-sm font-black text-slate-900">{fmtCurrency(facility.amount, facility.currency) || 'Sin monto'}</p>
                  </div>
                  <div className="mt-4 grid grid-cols-2 gap-3">
                    <div className="rounded-xl border border-slate-200 bg-white px-3 py-2">
                      <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Fecha inicio</p>
                      <p className="mt-1 text-sm font-black text-slate-900">{fmtFullDate(facility.startDate)}</p>
                    </div>
                    <div className="rounded-xl border border-slate-200 bg-white px-3 py-2">
                      <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Fecha fin</p>
                      <p className="mt-1 text-sm font-black text-slate-900">{fmtFullDate(facility.endDate)}</p>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </section>

      <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_320px]">
        <section className="relative">
          <div className="absolute bottom-8 left-[27px] top-8 hidden w-1 rounded-full bg-slate-200 md:block" />
          {filteredEvents.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-12 text-center">
              <Filter className="mx-auto mb-3 h-10 w-10 text-slate-300" />
              <p className="font-black text-slate-700">No hay hitos para estos filtros</p>
              <p className="mt-1 text-sm font-semibold text-slate-500">Prueba con otro crédito o limpia la búsqueda.</p>
            </div>
          ) : (
            <div className="space-y-5">
              {filteredEvents.map(event => {
                const Icon = eventIcon[event.type];
                return (
                  <article key={event.id} className="relative md:pl-20">
                    <div className={`mb-3 flex h-14 w-14 items-center justify-center rounded-2xl border-4 border-white text-white shadow-sm md:absolute md:left-0 md:top-1 ${dotClass[event.severity]}`}>
                      <Icon className="h-6 w-6" />
                    </div>
                    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                        <div className="min-w-0">
                          <div className="mb-2 flex flex-wrap items-center gap-2">
                            <span className={`rounded-full border px-2.5 py-1 text-[10px] font-black uppercase tracking-widest ${severityClass[event.severity]}`}>
                              {event.type}
                            </span>
                            <span className="text-[11px] font-black uppercase tracking-widest text-slate-400">{event.periodLabel}</span>
                            {event.meta && <span className="truncate text-[11px] font-bold text-slate-400">{event.meta}</span>}
                          </div>
                          <h3 className="text-base font-black text-slate-900">{event.title}</h3>
                          <p className="mt-1 text-sm font-semibold leading-6 text-slate-600">{event.detail}</p>
                        </div>
                        {event.amount !== undefined ? (
                          <div className="rounded-xl bg-slate-50 px-3 py-2 text-right">
                            <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Monto</p>
                            <p className="text-sm font-black text-slate-900">{fmtCurrency(event.amount, event.currency || selectedRow.client.currency)}</p>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        <aside className="space-y-4">
          <div className="rounded-2xl border border-slate-200 bg-white p-5">
            <h2 className="text-sm font-black uppercase tracking-widest text-slate-900">Pulso del crédito</h2>
            <div className="mt-5 space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-bold text-slate-500">Salud neta</span>
                <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-black ${summary.health >= 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>
                  {summary.health >= 0 ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}
                  {summary.health}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm font-bold text-slate-500">Último hito</span>
                <span className="text-right text-sm font-black text-slate-900">{filteredEvents[0]?.periodLabel || 'N/D'}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm font-bold text-slate-500">Loan tapes</span>
                <span className="text-sm font-black text-slate-900">{selectedRow.loanTapes.length}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm font-bold text-slate-500">Estados financieros</span>
                <span className="text-sm font-black text-slate-900">{selectedRow.statements.length}</span>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-5">
            <h2 className="text-sm font-black uppercase tracking-widest text-slate-900">Leyenda</h2>
            <div className="mt-4 space-y-3">
              <div className="flex items-center gap-2 text-sm font-bold text-slate-600"><CheckCircle2 className="h-4 w-4 text-emerald-500" /> Cumplimiento o actualización sana</div>
              <div className="flex items-center gap-2 text-sm font-bold text-slate-600"><AlertTriangle className="h-4 w-4 text-amber-500" /> Alerta o deterioro moderado</div>
              <div className="flex items-center gap-2 text-sm font-bold text-slate-600"><AlertTriangle className="h-4 w-4 text-rose-500" /> Incumplimiento o mora severa</div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
};

export default LifecyclePage;
