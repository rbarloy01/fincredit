import React from 'react';
import { Client, Covenant_DB, FinancialStatement_DB, LoanTape_DB, Transaction } from '../../db/index';
import { AlertTriangle, CheckCircle, Circle, FileClock, Lock, ShieldCheck, FileSpreadsheet, Scale } from 'lucide-react';
import { evaluateCovenantAuto, standardRatios } from '../../lib/financialMetrics';

interface Props {
  client: Client;
  transactions: Transaction[];
  statements: FinancialStatement_DB[];
  covenants: Covenant_DB[];
  loanTapes: LoanTape_DB[];
}

const Step = ({ done, label }: { done: boolean; label: string; key?: string }) => (
  <div className="flex items-center gap-2 text-sm">
    {done ? <CheckCircle className="w-4 h-4 text-emerald-600" /> : <Circle className="w-4 h-4 text-slate-300" />}
    <span className={done ? 'font-bold text-slate-800' : 'text-slate-400'}>{label}</span>
  </div>
);

function daysSince(date?: string) {
  if (!date) return Infinity;
  return Math.floor((Date.now() - new Date(date).getTime()) / 86400000);
}

const SaaSMonitorPanel: React.FC<Props> = ({ client, transactions, statements, covenants, loanTapes }) => {
  const sortedStatements = [...statements].sort((a, b) => a.periodDate.localeCompare(b.periodDate));
  const latestStatement = sortedStatements.at(-1);
  const latestTape = loanTapes[0];
  const tapeAnalysis = latestTape?.extractedData?._analysis || null;
  const tapeQuality = tapeAnalysis?.portfolioQuality || {};
  const tapeConcentrations = tapeAnalysis?.concentrations || {};
  const tapeValidation = tapeAnalysis?.validation || [];
  const tapeAnomalies = tapeAnalysis?.anomalies || {};
  const tapeBalance = (Object.values(tapeQuality) as any[]).reduce((sum, item) => sum + (item?.balance || 0), 0);
  const tapeLoanCount = (Object.values(tapeQuality) as any[]).reduce((sum, item) => sum + (item?.count || 0), 0);
  const vencidaPct = (tapeQuality as any).vencida?.pct || 0;
  const atrasadaPct = (tapeQuality as any).atrasada?.pct || 0;
  const maxClient = tapeConcentrations.by_client?.[0];
  const tapeAlertCount = tapeValidation.length
    + Object.values(tapeAnomalies).reduce((sum: number, rows: any) => sum + (Array.isArray(rows) ? rows.length : 0), 0);
  const latestRatios = latestStatement ? standardRatios(latestStatement) : [];
  const covenantResults = covenants.filter(c => c.type === 'financial').map(c => ({ covenant: c, ...evaluateCovenantAuto(c, sortedStatements) }));
  const breaches = covenantResults.filter(r => r.status === 'incumple');
  const warnings = covenantResults.filter(r => r.status === 'alerta');
  const uploadedFinancialFiles = new Set(statements.map(s => s.fileName).filter(Boolean));
  const testedCovenants = covenantResults.filter(r => r.value !== null || r.mode === 'manual').length;
  const complianceScore = covenantResults.length === 0 ? null : Math.round(((covenantResults.length - breaches.length - warnings.length * 0.5) / covenantResults.length) * 100);
  const alerts = [
    ...breaches.map(r => ({ severity: 'critical', title: `Covenant incumplido: ${r.covenant.name}`, detail: r.value === null ? 'Sin valor calculable' : `Valor actual ${r.value.toLocaleString('es-MX', { maximumFractionDigits: 4 })}` })),
    ...(daysSince(latestStatement?.periodDate) > 45 ? [{ severity: 'warning', title: 'Estados financieros vencidos', detail: latestStatement ? `Último periodo hace ${daysSince(latestStatement.periodDate)} días` : 'Sin estados financieros cargados' }] : []),
    ...(loanTapes.length === 0 ? [{ severity: 'warning', title: 'Loan tape faltante', detail: 'No hay loan tape cargada para monitoreo' }] : []),
    ...(latestTape && !tapeAnalysis ? [{ severity: 'warning', title: 'Loan tape sin analizar', detail: 'Carga hecha, falta correr análisis de cartera' }] : []),
    ...(vencidaPct > 0 ? [{ severity: vencidaPct > 0.1 ? 'critical' : 'warning', title: 'Cartera vencida detectada', detail: `${(vencidaPct * 100).toFixed(1)}% del saldo en >90 DPD` }] : []),
    ...(transactions.length === 0 ? [{ severity: 'warning', title: 'Contrato/facility faltante', detail: 'No hay transacción registrada' }] : []),
  ];
  const readinessChecks = [
    { done: !!client.name, label: 'Cliente registrado' },
    { done: transactions.length > 0, label: 'Contrato/facility cargado' },
    { done: statements.length > 0, label: 'EFF extraídos' },
    { done: covenants.length > 0, label: 'Covenants configurados' },
    { done: loanTapes.length > 0, label: 'Loan tape cargada' },
    { done: covenantResults.length > 0 && testedCovenants === covenantResults.length, label: 'Covenants calculables/manuales' },
  ];
  const readiness = readinessChecks.filter(x => x.done).length;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 xl:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-2xl p-5">
          <p className="text-xs font-black text-slate-400 uppercase tracking-widest">Readiness SaaS</p>
          <p className="text-3xl font-black text-slate-900 mt-2">{readiness}/{readinessChecks.length}</p>
          <div className="h-2 bg-slate-100 rounded-full mt-3 overflow-hidden">
            <div className="h-full bg-indigo-600 rounded-full" style={{ width: `${(readiness / readinessChecks.length) * 100}%` }} />
          </div>
        </div>
        <div className="bg-white border border-rose-200 rounded-2xl p-5">
          <p className="text-xs font-black text-rose-500 uppercase tracking-widest">Breaches</p>
          <p className="text-3xl font-black text-rose-700 mt-2">{breaches.length}</p>
        </div>
        <div className="bg-white border border-amber-200 rounded-2xl p-5">
          <p className="text-xs font-black text-amber-600 uppercase tracking-widest">Alertas abiertas</p>
          <p className="text-3xl font-black text-amber-700 mt-2">{alerts.length}</p>
        </div>
        <div className="bg-white border border-indigo-200 rounded-2xl p-5">
          <p className="text-xs font-black text-indigo-600 uppercase tracking-widest">Cumplimiento</p>
          <p className="text-3xl font-black text-indigo-800 mt-2">{complianceScore === null ? 'N/A' : `${complianceScore}%`}</p>
          <p className="text-xs text-indigo-500 font-bold mt-1">{testedCovenants}/{covenantResults.length} covenants evaluables</p>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-2xl p-5">
          <p className="text-xs font-black text-slate-400 uppercase tracking-widest flex items-center gap-2"><FileSpreadsheet className="w-4 h-4" />EFF</p>
          <p className="text-2xl font-black text-slate-900 mt-2">{uploadedFinancialFiles.size} archivos</p>
          <p className="text-xs text-slate-500 font-bold">{statements.length} periodos</p>
        </div>
        <div className="bg-white border border-slate-200 rounded-2xl p-5">
          <p className="text-xs font-black text-slate-400 uppercase tracking-widest flex items-center gap-2"><Scale className="w-4 h-4" />Covenants</p>
          <p className="text-2xl font-black text-slate-900 mt-2">{covenantResults.length}</p>
          <p className="text-xs text-slate-500 font-bold">{breaches.length} breach · {warnings.length} alerta</p>
        </div>
        <div className="bg-white border border-slate-200 rounded-2xl p-5">
          <p className="text-xs font-black text-slate-400 uppercase tracking-widest">Loan tapes</p>
          <p className="text-2xl font-black text-slate-900 mt-2">{loanTapes.length}</p>
          <p className="text-xs text-slate-500 font-bold">{latestTape?.fileName || 'sin archivo'}</p>
        </div>
        <div className="bg-white border border-slate-200 rounded-2xl p-5">
          <p className="text-xs font-black text-slate-400 uppercase tracking-widest">Último periodo</p>
          <p className="text-xl font-black text-slate-900 mt-3">{latestStatement?.period || client.lastPeriod || 'N/A'}</p>
          <p className="text-xs text-slate-500 font-bold">{latestStatement?.periodDate || ''}</p>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-2xl p-6">
        <div className="flex items-center justify-between gap-4 mb-5">
          <h3 className="text-sm font-black text-slate-900 uppercase tracking-widest flex items-center gap-2">
            <FileSpreadsheet className="w-4 h-4 text-indigo-600" />Dashboard Loan Tape
          </h3>
          <span className="text-xs font-black text-slate-500 bg-slate-100 rounded-full px-3 py-1">
            {latestTape?.fileName || 'sin archivo'}
          </span>
        </div>

        {!tapeAnalysis ? (
          <p className="text-sm text-slate-500 font-bold bg-slate-50 border border-slate-100 rounded-xl px-4 py-3">
            Sube y analiza un loan tape para poblar este dashboard.
          </p>
        ) : (
          <div className="space-y-5">
            <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
              <div className="rounded-xl bg-slate-50 p-4">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Saldo cartera</p>
                <p className="text-xl font-black text-slate-900 mt-1">{tapeBalance.toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 })}</p>
              </div>
              <div className="rounded-xl bg-slate-50 p-4">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Créditos</p>
                <p className="text-xl font-black text-slate-900 mt-1">{tapeLoanCount}</p>
              </div>
              <div className="rounded-xl bg-amber-50 p-4">
                <p className="text-[10px] font-black text-amber-600 uppercase tracking-widest">Atrasada</p>
                <p className="text-xl font-black text-amber-800 mt-1">{(atrasadaPct * 100).toFixed(1)}%</p>
              </div>
              <div className="rounded-xl bg-rose-50 p-4">
                <p className="text-[10px] font-black text-rose-600 uppercase tracking-widest">Vencida</p>
                <p className="text-xl font-black text-rose-800 mt-1">{(vencidaPct * 100).toFixed(1)}%</p>
              </div>
              <div className="rounded-xl bg-indigo-50 p-4">
                <p className="text-[10px] font-black text-indigo-600 uppercase tracking-widest">Alertas tape</p>
                <p className="text-xl font-black text-indigo-900 mt-1">{tapeAlertCount}</p>
              </div>
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
              <div className="rounded-xl border border-slate-200 overflow-hidden">
                <div className="px-4 py-3 bg-slate-50 text-xs font-black uppercase tracking-widest text-slate-600">Calidad de cartera</div>
                <div className="divide-y divide-slate-100">
                  {Object.entries(tapeQuality).map(([name, item]: any) => (
                    <div key={name} className="flex justify-between px-4 py-3 text-sm">
                      <span className="font-bold capitalize text-slate-600">{name}</span>
                      <span className="font-mono font-black text-slate-900">{(item.pct * 100).toFixed(1)}%</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 overflow-hidden">
                <div className="px-4 py-3 bg-slate-50 text-xs font-black uppercase tracking-widest text-slate-600">Top clientes</div>
                <div className="divide-y divide-slate-100">
                  {(tapeConcentrations.by_client || []).slice(0, 5).map((row: any) => (
                    <div key={row.name} className="flex justify-between gap-3 px-4 py-3 text-sm">
                      <span className="font-bold text-slate-600 truncate">{row.name}</span>
                      <span className="font-mono font-black text-slate-900">{(row.pct * 100).toFixed(1)}%</span>
                    </div>
                  ))}
                  {!maxClient && <p className="px-4 py-3 text-sm text-slate-400">Sin concentración calculada.</p>}
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 overflow-hidden">
                <div className="px-4 py-3 bg-slate-50 text-xs font-black uppercase tracking-widest text-slate-600">DPD</div>
                <div className="divide-y divide-slate-100">
                  {(tapeAnalysis.dpd_distribution || []).map((row: any) => (
                    <div key={row.bucket} className="flex justify-between px-4 py-3 text-sm">
                      <span className="font-bold text-slate-600">{row.bucket}</span>
                      <span className="font-mono font-black text-slate-900">{(row.pct * 100).toFixed(1)}%</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="bg-white border border-slate-200 rounded-2xl p-6">
          <h3 className="text-sm font-black text-slate-900 uppercase tracking-widest mb-4 flex items-center gap-2"><ShieldCheck className="w-4 h-4 text-indigo-600" />Perfil 3-FSM</h3>
          <div className="space-y-4">
            <div className="rounded-xl bg-slate-50 p-4">
              <p className="text-xs font-black text-slate-400 uppercase">Borrower</p>
              <p className="font-black text-slate-900">{client.name}</p>
              <p className="text-xs text-slate-500">{client.industry || 'Industria pendiente'} · Score {client.score || 'N/A'}</p>
            </div>
            <div className="rounded-xl bg-slate-50 p-4">
              <p className="text-xs font-black text-slate-400 uppercase">Facility</p>
              <p className="font-black text-slate-900">{client.contractName || transactions[0]?.name || 'Contrato pendiente'}</p>
              <p className="text-xs text-slate-500">{client.currency} {client.totalCreditValue.toLocaleString('es-MX')}</p>
            </div>
            <div className="rounded-xl bg-slate-50 p-4">
              <p className="text-xs font-black text-slate-400 uppercase">Collateral / Loan Tape</p>
              <p className="font-black text-slate-900">{latestTape?.name || 'Loan tape pendiente'}</p>
              <p className="text-xs text-slate-500">{latestTape?.fileName || 'Sin archivo'}</p>
            </div>
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl p-6">
          <h3 className="text-sm font-black text-slate-900 uppercase tracking-widest mb-4 flex items-center gap-2"><Lock className="w-4 h-4 text-indigo-600" />Workflow</h3>
          <div className="space-y-3">
            {readinessChecks.map(check => <Step key={check.label} done={check.done} label={check.label} />)}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl p-6">
          <h3 className="text-sm font-black text-slate-900 uppercase tracking-widest mb-4 flex items-center gap-2"><FileClock className="w-4 h-4 text-indigo-600" />Ratios clave</h3>
          <div className="space-y-2">
            {latestRatios.slice(0, 6).map(r => (
              <div key={r.key} className="flex justify-between text-sm border-b border-slate-100 py-2">
                <span className="text-slate-500 font-bold">{r.label}</span>
                <span className="font-mono font-black text-slate-900">{r.value === null ? 'N/A' : r.value.toLocaleString('es-MX', { maximumFractionDigits: 4 })}</span>
              </div>
            ))}
            {latestRatios.length === 0 && <p className="text-sm text-slate-400">Sin EFF aprobado/cargado.</p>}
          </div>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-2xl p-6">
        <h3 className="text-sm font-black text-slate-900 uppercase tracking-widest mb-4 flex items-center gap-2"><AlertTriangle className="w-4 h-4 text-amber-600" />Alert Center</h3>
        <div className="space-y-2">
          {alerts.map((a, i) => (
            <div key={i} className={`rounded-xl px-4 py-3 border ${a.severity === 'critical' ? 'bg-rose-50 border-rose-200 text-rose-800' : 'bg-amber-50 border-amber-200 text-amber-800'}`}>
              <p className="text-sm font-black">{a.title}</p>
              <p className="text-xs opacity-80 mt-0.5">{a.detail}</p>
            </div>
          ))}
          {alerts.length === 0 && <p className="text-sm text-emerald-700 font-bold bg-emerald-50 border border-emerald-100 rounded-xl px-4 py-3">Sin alertas abiertas calculadas.</p>}
        </div>
      </div>
    </div>
  );
};

export default SaaSMonitorPanel;
