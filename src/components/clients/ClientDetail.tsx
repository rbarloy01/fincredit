import React, { Suspense, useState, useEffect, useMemo } from 'react';
import { db, Client, Transaction, FinancialStatement_DB, Covenant_DB, LoanTape_DB, InstitutionalLiability_DB, CustomField } from '../../db/index';
import { Session } from '../../services/auth';
import { AISettings } from '../../services/ai';
import AuditPanel from '../audit/AuditPanel';
import { ChevronLeft, Building2, Trash2, Pencil } from 'lucide-react';
import TransactionPanel from '../transactions/TransactionPanel';
import FinancialCovenantsPanel from '../covenants/FinancialCovenantsPanel';
import HacerNoHacerPanel from '../covenants/HacerNoHacerPanel';
import CreditUnderwritingPanel from '../monitoring/CreditUnderwritingPanel';
import WorkingOverlay from '../common/WorkingOverlay';
import CompanyOverviewPanel from './CompanyOverviewPanel';
import { lazyWithChunkRetry } from '../../lib/lazyWithChunkRetry';
import { timed } from '../../lib/telemetry';

const FinancialPanel = lazyWithChunkRetry(() => import('../financials/FinancialPanel'), 'financial-panel');
const LoanTapePanel = lazyWithChunkRetry(() => import('../loantape/LoanTapePanel'), 'loan-tape-panel');
const InstitutionalLiabilitiesPanel = lazyWithChunkRetry(() => import('../liabilities/InstitutionalLiabilitiesPanel'), 'institutional-liabilities-panel');
const ClientReportView = lazyWithChunkRetry(() => import('../report/ReportView'), 'client-report-view');
const CrmPanel = lazyWithChunkRetry(() => import('../crm/CrmPanel'), 'crm-panel');

interface Props {
  clientId: string;
  session: Session;
  aiSettings: AISettings;
  onBack: () => void;
  onDeleted?: () => void;
  onEdit?: (client: Client) => void;
}

type Tab = 'monitor' | 'crm' | 'company_overview' | 'transacciones' | 'estados' | 'auditoria' | 'loantape' | 'pasivos_institucionales' | 'cov_financiero' | 'hacer_no_hacer' | 'reporte';

import { QUALITY_SETTING_KEY, usableStatements, type StatementQualityRecord } from '../../lib/statementQuality';
import { MonitoringProvider } from './MonitoringContext';
import { clientStatusLabel, isClientMonitored, MONITORING_PAUSED_TEXT } from '../../lib/clientStatus';
const TABS: { id: Tab; label: string }[] = [
  { id: 'monitor', label: 'Underwriting' },
  { id: 'crm', label: 'CRM' },
  { id: 'company_overview', label: 'Company Overview' },
  { id: 'transacciones', label: 'Transacciones' },
  { id: 'estados', label: 'Estados Financieros' },
  { id: 'auditoria', label: 'Conciliación' },
  { id: 'loantape', label: 'Loan Tape' },
  { id: 'pasivos_institucionales', label: 'Pasivos Institucionales' },
  { id: 'cov_financiero', label: 'Indicadores Financieros' },
  { id: 'hacer_no_hacer', label: 'Hacer / No Hacer' },
  { id: 'reporte', label: 'Reporte' },
];

const TabFallback = () => (
  <div className="flex items-center justify-center py-16">
    <svg className="animate-spin h-7 w-7 text-indigo-500" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
    </svg>
  </div>
);

const ClientDetail: React.FC<Props> = ({ clientId, session, aiSettings, onBack, onDeleted, onEdit }) => {
  const [client, setClient] = useState<Client | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [statements, setStatements] = useState<FinancialStatement_DB[]>([]);
  const [qualityRecords, setQualityRecords] = useState<Record<string, StatementQualityRecord>>({});
  const [covenants, setCovenants] = useState<Covenant_DB[]>([]);
  const [loanTapes, setLoanTapes] = useState<LoanTape_DB[]>([]);
  const [institutionalLiabilities, setInstitutionalLiabilities] = useState<InstitutionalLiability_DB[]>([]);
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [activeTab, setActiveTab] = useState<Tab>('monitor');
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);

  const loadData = async () => {
    setLoading(true);
    try {
      const [c, txs, stmts, covs, tapes, liabilities, fields] = await timed('clientDetail.load', () => Promise.all([
        db.getClientById(clientId),
        db.getTransactions(clientId),
        db.getStatements(clientId),
        db.getCovenants(clientId),
        db.getLoanTapesForDetail(clientId),
        db.getInstitutionalLiabilities(clientId),
        db.getCustomFields(clientId),
      ]));
      if (c) setClient(c);
      setTransactions(txs);
      setStatements(stmts);
      setCovenants(covs);
      setLoanTapes(tapes);
      setInstitutionalLiabilities(liabilities);
      setCustomFields(fields);
      void Promise.all([
        db.getClientSetting(clientId, `finmonitor_defined_concepts_${clientId}`, []),
        db.getClientSetting(clientId, `finmonitor_vertical_bases_${clientId}`, {}),
        db.getClientSetting(clientId, `finmonitor_contract_covs_${clientId}`, []),
        db.getClientSetting(clientId, `finmonitor_hidden_standard_covs_${clientId}`, []),
        db.getClientSetting(clientId, `finmonitor_eff_mappings_${clientId}`, {}),
      ]).catch(err => console.error('Error preloading client settings:', err));
    } catch (err) {
      console.error('Error loading client data:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadData(); }, [clientId]);

  // Estados en revisión (puerta de calidad) no alimentan monitoreo, indicadores ni reporte hasta que se aprueben.
  useEffect(() => {
    let active = true;
    db.getClientSetting<Record<string, StatementQualityRecord>>(clientId, QUALITY_SETTING_KEY, {}).then(records => { if (active) setQualityRecords(records || {}); });
    return () => { active = false; };
  }, [clientId, statements]);
  const analysisStatements = useMemo(() => usableStatements(statements, qualityRecords), [statements, qualityRecords]);

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
            <p className="text-slate-500 text-sm mt-0.5 font-mono">{client.taxId || 'Sin RFC'} · {client.industry}</p>
          </div>
          {session.role === 'manager' && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => onEdit?.(client)}
                className="flex items-center gap-2 bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 font-bold px-4 py-2.5 rounded-xl text-sm transition-all"
              >
                <Pencil className="w-4 h-4" />
                Editar cliente
              </button>
              <button
                onClick={handleDeleteClient}
                disabled={deleting}
                className="flex items-center gap-2 bg-white border border-rose-200 text-rose-600 hover:bg-rose-50 font-bold px-4 py-2.5 rounded-xl text-sm transition-all disabled:opacity-50"
              >
                <Trash2 className="w-4 h-4" />
                Eliminar
              </button>
            </div>
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
      <MonitoringProvider value={isClientMonitored(client)}>
      {!isClientMonitored(client) && (
        <div className="mx-8 mt-6 rounded-xl border border-slate-300 bg-slate-100 px-4 py-3 text-sm font-semibold text-slate-700">
          <span className="mr-2 rounded-md bg-slate-600 px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-white">{clientStatusLabel(client.status)}</span>
          {MONITORING_PAUSED_TEXT}
        </div>
      )}
      <div className="p-8">
        <Suspense fallback={<TabFallback />}>
          {activeTab === 'monitor' && (
            <CreditUnderwritingPanel
              client={client}
              transactions={transactions}
              statements={analysisStatements}
              covenants={covenants}
              loanTapes={loanTapes}
            />
          )}
          {activeTab === 'crm' && (
            <CrmPanel
              clientId={clientId}
              session={session}
            />
          )}
          {activeTab === 'company_overview' && (
            <CompanyOverviewPanel
              client={client}
              transactions={transactions}
              statements={analysisStatements}
              covenants={covenants}
              customFields={customFields}
              aiSettings={aiSettings}
              onClientUpdate={handleClientUpdate}
              onCustomFieldsChange={setCustomFields}
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
          {activeTab === 'pasivos_institucionales' && (
            <InstitutionalLiabilitiesPanel
              clientId={clientId}
              clientName={client.name}
              aiSettings={aiSettings}
              loanTapes={loanTapes}
              onLiabilitiesChange={setInstitutionalLiabilities}
            />
          )}
          {activeTab === 'auditoria' && (
            <AuditPanel
              clientId={clientId}
              statements={statements}
              onStatementsChange={setStatements}
            />
          )}
          {activeTab === 'cov_financiero' && (
            <FinancialCovenantsPanel
              clientId={clientId}
              clientName={client.name}
              transactions={transactions}
              session={session}
              statements={analysisStatements}
              onCovenantsChange={setCovenants}
            />
          )}
          {activeTab === 'hacer_no_hacer' && (
            <HacerNoHacerPanel
              clientId={clientId}
              clientName={client.name}
              transactions={transactions}
              session={session}
              onCovenantsChange={setCovenants}
            />
          )}
          {activeTab === 'reporte' && (
            <ClientReportView
              client={client}
              statements={analysisStatements}
              covenants={covenants}
              loanTapes={loanTapes}
              institutionalLiabilities={institutionalLiabilities}
              transactions={transactions}
              customFields={customFields}
              onCustomFieldsChange={setCustomFields}
              onClientUpdate={handleClientUpdate}
              onClose={() => setActiveTab('monitor')}
            />
          )}
        </Suspense>
      </div>
      </MonitoringProvider>
    </div>
  );
};

export default ClientDetail;
