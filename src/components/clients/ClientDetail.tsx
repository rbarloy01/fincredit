import React, { lazy, Suspense, useState, useEffect, useRef } from 'react';
import { db, Client, Transaction, FinancialStatement_DB, Covenant_DB, LoanTape_DB, CustomField } from '../../db/index';
import { Session } from '../../services/auth';
import { AISettings } from '../../services/ai';
import { ChevronLeft, Building2, Download, FileText, Trash2 } from 'lucide-react';
import TransactionPanel from '../transactions/TransactionPanel';
import FinancialCovenantsPanel from '../covenants/FinancialCovenantsPanel';
import HacerNoHacerPanel from '../covenants/HacerNoHacerPanel';
import CreditUnderwritingPanel from '../monitoring/CreditUnderwritingPanel';
import AuditPanel from '../audit/AuditPanel';
import WorkingOverlay from '../common/WorkingOverlay';
import CompanyOverviewPanel from './CompanyOverviewPanel';

const FinancialPanel = lazy(() => import('../financials/FinancialPanel'));
const LoanTapePanel = lazy(() => import('../loantape/LoanTapePanel'));
const ClientReportView = lazy(() => import('../report/ReportView'));

interface Props {
  clientId: string;
  session: Session;
  aiSettings: AISettings;
  onBack: () => void;
  onDeleted?: () => void;
}

type Tab = 'monitor' | 'resumen' | 'company_overview' | 'transacciones' | 'estados' | 'auditoria' | 'loantape' | 'cov_financiero' | 'hacer_no_hacer' | 'reporte';

const TABS: { id: Tab; label: string }[] = [
  { id: 'monitor', label: 'Underwriting' },
  { id: 'resumen', label: 'Resumen' },
  { id: 'company_overview', label: 'Company Overview' },
  { id: 'transacciones', label: 'Transacciones' },
  { id: 'estados', label: 'Estados Financieros' },
  { id: 'auditoria', label: 'Auditoría' },
  { id: 'loantape', label: 'Loan Tape' },
  { id: 'cov_financiero', label: 'Covenants Financieros' },
  { id: 'hacer_no_hacer', label: 'Hacer / No Hacer' },
  { id: 'reporte', label: 'Reporte' },
];

function fmtCurrency(value: number, currency: string): string {
  const prefix = currency === 'MXN' ? '$' : currency === 'USD' ? 'USD ' : '€';
  if (value >= 1_000_000) return `${prefix}${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${prefix}${(value / 1_000).toFixed(1)}K`;
  return `${prefix}${value.toLocaleString('es-MX')}`;
}

const StatusCircle = ({ status }: { status?: string }) => {
  const bg = status === 'paid' ? 'bg-emerald-500' : status === 'unpaid' ? 'bg-rose-500' : 'bg-slate-200';
  return (
    <div className={`w-6 h-6 rounded-full ${bg} flex items-center justify-center mx-auto`}>
      {status === 'paid' && <svg className="w-3 h-3 text-white" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-6" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>}
      {status === 'unpaid' && <svg className="w-3 h-3 text-white" viewBox="0 0 12 12" fill="none"><path d="M3 3l6 6M9 3l-6 6" stroke="white" strokeWidth="2" strokeLinecap="round" /></svg>}
    </div>
  );
};

const TabFallback = () => (
  <div className="flex items-center justify-center py-16">
    <svg className="animate-spin h-7 w-7 text-indigo-500" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
    </svg>
  </div>
);

const ResumenTab: React.FC<{ client: Client; transactions: Transaction[]; covenants: Covenant_DB[] }> = ({ client, transactions, covenants }) => {
  const history = client.paymentHistory?.slice(0, 6) || [];
  const aforo = client.aforoHistory?.slice(0, 6) || [];
  const [exporting, setExporting] = useState<'excel' | 'pdf' | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const handleExport = async (format: 'excel' | 'pdf') => {
    setExporting(format);
    try {
      const { exportResumen } = await import('../../lib/export');
      await exportResumen(client, transactions, covenants, format, format === 'pdf' ? panelRef.current ?? undefined : undefined);
    } finally {
      setExporting(null);
    }
  };

  return (
    <div ref={panelRef} className="space-y-6">
      {/* Export bar */}
      <div className="flex justify-end gap-2">
        <button onClick={() => handleExport('excel')} disabled={!!exporting} className="flex items-center gap-1.5 bg-white border border-slate-200 text-slate-600 font-bold px-3 py-2 rounded-xl text-xs hover:bg-slate-50 disabled:opacity-50 transition-all">
          {exporting === 'excel' ? <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/></svg> : <Download className="w-3.5 h-3.5" />}
          Excel
        </button>
        <button onClick={() => handleExport('pdf')} disabled={!!exporting} className="flex items-center gap-1.5 bg-white border border-slate-200 text-slate-600 font-bold px-3 py-2 rounded-xl text-xs hover:bg-slate-50 disabled:opacity-50 transition-all">
          {exporting === 'pdf' ? <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/></svg> : <FileText className="w-3.5 h-3.5" />}
          PDF
        </button>
      </div>

      {/* Credit profile */}
      <div className="bg-white border border-slate-200 rounded-2xl p-6">
        <h3 className="text-sm font-black text-slate-900 uppercase tracking-widest mb-5">Perfil Crediticio</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-slate-50 rounded-xl p-4">
            <p className="text-xs text-slate-500 font-bold uppercase tracking-wide">Línea Total</p>
            <p className="text-xl font-black text-slate-900 mt-1">{fmtCurrency(client.totalCreditValue, client.currency)}</p>
          </div>
          <div className="bg-slate-50 rounded-xl p-4">
            <p className="text-xs text-slate-500 font-bold uppercase tracking-wide">Moneda</p>
            <p className="text-xl font-black text-slate-900 mt-1">{client.currency}</p>
          </div>
          <div className="bg-slate-50 rounded-xl p-4">
            <p className="text-xs text-slate-500 font-bold uppercase tracking-wide">Calificación</p>
            <p className="text-xl font-black text-slate-900 mt-1">{client.score || '—'}</p>
          </div>
          <div className="bg-slate-50 rounded-xl p-4">
            <p className="text-xs text-slate-500 font-bold uppercase tracking-wide">Días en Mora</p>
            <p className="text-xl font-black text-slate-900 mt-1">{client.maxDefaultDays}</p>
          </div>
          <div className="bg-slate-50 rounded-xl p-4">
            <p className="text-xs text-slate-500 font-bold uppercase tracking-wide">Tipo de Crédito</p>
            <p className="text-sm font-bold text-slate-900 mt-1">{client.creditType?.join(', ') || '—'}</p>
          </div>
          <div className="bg-slate-50 rounded-xl p-4">
            <p className="text-xs text-slate-500 font-bold uppercase tracking-wide">Industria</p>
            <p className="text-sm font-bold text-slate-900 mt-1">{client.industry}</p>
          </div>
          <div className="bg-slate-50 rounded-xl p-4">
            <p className="text-xs text-slate-500 font-bold uppercase tracking-wide">Analista</p>
            <p className="text-sm font-bold text-slate-900 mt-1">{client.analystName || '—'}</p>
          </div>
          <div className="bg-slate-50 rounded-xl p-4">
            <p className="text-xs text-slate-500 font-bold uppercase tracking-wide">Frecuencia</p>
            <p className="text-sm font-bold text-slate-900 mt-1 capitalize">{client.frequency}</p>
          </div>
        </div>
      </div>

      {/* Payment history */}
      {history.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-2xl p-6">
          <h3 className="text-sm font-black text-slate-900 uppercase tracking-widest mb-5">Historial de Pagos</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50">
                  <th className="text-left px-4 py-2 text-xs font-black text-slate-600 uppercase tracking-wider">Mes</th>
                  <th className="text-center px-4 py-2 text-xs font-black text-slate-600 uppercase tracking-wider">Principal</th>
                  <th className="text-center px-4 py-2 text-xs font-black text-slate-600 uppercase tracking-wider">Interés</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h, i) => (
                  <tr key={i} className="border-t border-slate-100">
                    <td className="px-4 py-3 font-semibold text-slate-700">{h.month}</td>
                    <td className="px-4 py-3"><StatusCircle status={h.principalStatus} /></td>
                    <td className="px-4 py-3"><StatusCircle status={h.interestStatus} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Aforo */}
      {aforo.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-2xl p-6">
          <h3 className="text-sm font-black text-slate-900 uppercase tracking-widest mb-1">Historial de Aforo</h3>
          <p className="text-xs text-slate-500 mb-5">Requerido: {client.aforoRequerido || 'N/D'}</p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50">
                  <th className="text-left px-4 py-2 text-xs font-black text-slate-600 uppercase tracking-wider">Mes</th>
                  <th className="text-center px-4 py-2 text-xs font-black text-slate-600 uppercase tracking-wider">Valor</th>
                  <th className="text-center px-4 py-2 text-xs font-black text-slate-600 uppercase tracking-wider">Estado</th>
                </tr>
              </thead>
              <tbody>
                {aforo.map((a, i) => (
                  <tr key={i} className="border-t border-slate-100">
                    <td className="px-4 py-3 font-semibold text-slate-700">{a.month}</td>
                    <td className="px-4 py-3 text-center font-mono text-slate-800">{a.value}</td>
                    <td className="px-4 py-3 text-center">
                      <span className={`text-xs font-black px-2 py-1 rounded-lg ${
                        a.status === 'good' ? 'bg-emerald-100 text-emerald-800' :
                        a.status === 'warning' ? 'bg-amber-100 text-amber-800' :
                        'bg-rose-100 text-rose-800'
                      }`}>
                        {a.status === 'good' ? 'CUMPLE' : a.status === 'warning' ? 'ALERTA' : 'INCUMPLE'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Opinion */}
      {client.opinion && (
        <div className="bg-white border border-slate-200 rounded-2xl p-6">
          <h3 className="text-sm font-black text-slate-900 uppercase tracking-widest mb-4">Opinión del Analista</h3>
          <p className="text-slate-700 text-sm leading-relaxed whitespace-pre-wrap">{client.opinion}</p>
        </div>
      )}
    </div>
  );
};

const ClientDetail: React.FC<Props> = ({ clientId, session, aiSettings, onBack, onDeleted }) => {
  const [client, setClient] = useState<Client | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [statements, setStatements] = useState<FinancialStatement_DB[]>([]);
  const [covenants, setCovenants] = useState<Covenant_DB[]>([]);
  const [loanTapes, setLoanTapes] = useState<LoanTape_DB[]>([]);
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [activeTab, setActiveTab] = useState<Tab>('monitor');
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);

  const loadData = async () => {
    setLoading(true);
    try {
      const [c, txs, stmts, covs, tapes, fields] = await Promise.all([
        db.getClientById(clientId),
        db.getTransactions(clientId),
        db.getStatements(clientId),
        db.getCovenants(clientId),
        db.getLoanTapes(clientId),
        db.getCustomFields(clientId),
      ]);
      if (c) setClient(c);
      setTransactions(txs);
      setStatements(stmts);
      setCovenants(covs);
      setLoanTapes(tapes);
      setCustomFields(fields);
      await Promise.all([
        db.getClientSetting(clientId, `finmonitor_defined_concepts_${clientId}`, []),
        db.getClientSetting(clientId, `finmonitor_vertical_bases_${clientId}`, {}),
        db.getClientSetting(clientId, `finmonitor_contract_covs_${clientId}`, []),
        db.getClientSetting(clientId, `finmonitor_hidden_standard_covs_${clientId}`, []),
        db.getClientSetting(clientId, `finmonitor_eff_mappings_${clientId}`, {}),
      ]);
    } catch (err) {
      console.error('Error loading client data:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadData(); }, [clientId]);

  const handleClientUpdate = async (updates: Partial<Client>) => {
    if (!client) return;
    const next = { ...client, ...updates };
    setClient(next);
    await db.updateClient(client.id, updates);
  };

  const handleDeleteClient = async () => {
    if (!client || session.role !== 'manager') return;
    if (!confirm(`¿Eliminar cliente "${client.name}" y toda su información cargada?`)) return;
    setDeleting(true);
    try {
      await db.deleteClient(client.id);
      onDeleted?.();
      onBack();
    } catch (err: any) {
      alert(`Error al eliminar cliente: ${err.message}`);
    } finally {
      setDeleting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <svg className="animate-spin h-8 w-8 text-indigo-500" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
        </svg>
      </div>
    );
  }

  if (!client) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center">
        <Building2 className="w-12 h-12 text-slate-300 mb-4" />
        <p className="text-slate-500">Cliente no encontrado</p>
        <button onClick={onBack} className="mt-4 text-indigo-600 hover:text-indigo-700 text-sm font-bold">
          Volver al listado
        </button>
      </div>
    );
  }

  return (
    <div className="flex-1 bg-slate-50 min-h-screen">
      <WorkingOverlay
        show={deleting}
        title="Eliminando cliente"
        messages={['Almost there...', 'Working on it...', 'Borrando documentos ligados...', 'Limpiando covenants...', 'Regresando al portafolio...']}
      />
      {/* Header */}
      <div className="bg-white border-b border-slate-200 px-8 py-6">
        <div className="flex items-center gap-4 mb-4">
          <button onClick={onBack} className="text-slate-500 hover:text-slate-900 transition-colors">
            <ChevronLeft className="w-5 h-5" />
          </button>
          <div className="flex-1">
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-black text-slate-900 tracking-tight">{client.name}</h1>
              {client.score && (
                <span className="text-xs font-black px-2.5 py-1 bg-indigo-100 text-indigo-800 rounded-lg border border-indigo-200">
                  {client.score}
                </span>
              )}
            </div>
            <p className="text-slate-500 text-sm mt-0.5 font-mono">{client.taxId} · {client.industry}</p>
          </div>
          {session.role === 'manager' && (
            <button
              onClick={handleDeleteClient}
              disabled={deleting}
              className="flex items-center gap-2 bg-white border border-rose-200 text-rose-600 hover:bg-rose-50 font-bold px-4 py-2.5 rounded-xl text-sm transition-all disabled:opacity-50"
            >
              <Trash2 className="w-4 h-4" />
              Eliminar
            </button>
          )}
        </div>

        {/* Tabs */}
        <div className="flex gap-1 overflow-x-auto">
          {TABS.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-2 rounded-lg text-sm font-bold whitespace-nowrap transition-all ${
                activeTab === tab.id
                  ? 'bg-indigo-600 text-white'
                  : 'text-slate-500 hover:text-slate-900 hover:bg-slate-100'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div className="p-8">
        <Suspense fallback={<TabFallback />}>
          {activeTab === 'monitor' && (
            <CreditUnderwritingPanel
              client={client}
              transactions={transactions}
              statements={statements}
              covenants={covenants}
              loanTapes={loanTapes}
            />
          )}
          {activeTab === 'resumen' && <ResumenTab client={client} transactions={transactions} covenants={covenants} />}
          {activeTab === 'company_overview' && (
            <CompanyOverviewPanel
              client={client}
              statements={statements}
              covenants={covenants}
              customFields={customFields}
              aiSettings={aiSettings}
            />
          )}
          {activeTab === 'transacciones' && (
            <TransactionPanel
              clientId={clientId}
              clientName={client.name}
              session={session}
              aiSettings={aiSettings}
              onCovenantsExtracted={() => loadData()}
            />
          )}
          {activeTab === 'estados' && (
            <FinancialPanel
              clientId={clientId}
              clientName={client.name}
              session={session}
              aiSettings={aiSettings}
              covenants={covenants}
              onStatementsChange={setStatements}
              onCovenantsChange={setCovenants}
            />
          )}
          {activeTab === 'loantape' && (
            <LoanTapePanel
              clientId={clientId}
              clientName={client.name}
              session={session}
              aiSettings={aiSettings}
              onTapesChange={setLoanTapes}
            />
          )}
          {activeTab === 'auditoria' && (
            <AuditPanel
              statements={statements}
              onStatementsChange={setStatements}
            />
          )}
          {activeTab === 'cov_financiero' && (
            <FinancialCovenantsPanel
              clientId={clientId}
              clientName={client.name}
              session={session}
              statements={statements}
              onCovenantsChange={setCovenants}
            />
          )}
          {activeTab === 'hacer_no_hacer' && (
            <HacerNoHacerPanel
              clientId={clientId}
              clientName={client.name}
              session={session}
              onCovenantsChange={setCovenants}
            />
          )}
          {activeTab === 'reporte' && (
            <ClientReportView
              client={client}
              statements={statements}
              covenants={covenants}
              loanTapes={loanTapes}
              customFields={customFields}
              onCustomFieldsChange={setCustomFields}
              onClientUpdate={handleClientUpdate}
              onClose={() => setActiveTab('resumen')}
            />
          )}
        </Suspense>
      </div>
    </div>
  );
};

export default ClientDetail;
