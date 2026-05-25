import React from 'react';
import { Client, Covenant_DB, FinancialStatement_DB, LoanTape_DB, Transaction } from '../../db/index';
import { AlertTriangle, CheckCircle, Circle, FileClock, Lock, ShieldCheck } from 'lucide-react';
import { evaluateCovenantAuto, standardRatios } from '../../lib/financialMetrics';

interface Props {
  client: Client;
  transactions: Transaction[];
  statements: FinancialStatement_DB[];
  covenants: Covenant_DB[];
  loanTapes: LoanTape_DB[];
}

const Step = ({ done, label }: { done: boolean; label: string }) => (
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
  const latestRatios = latestStatement ? standardRatios(latestStatement) : [];
  const covenantResults = covenants.filter(c => c.type === 'financial').map(c => ({ covenant: c, ...evaluateCovenantAuto(c, sortedStatements) }));
  const breaches = covenantResults.filter(r => r.status === 'incumple');
  const alerts = [
    ...breaches.map(r => ({ severity: 'critical', title: `Covenant incumplido: ${r.covenant.name}`, detail: r.value === null ? 'Sin valor calculable' : `Valor actual ${r.value.toLocaleString('es-MX', { maximumFractionDigits: 4 })}` })),
    ...(daysSince(latestStatement?.periodDate) > 45 ? [{ severity: 'warning', title: 'Estados financieros vencidos', detail: latestStatement ? `Último periodo hace ${daysSince(latestStatement.periodDate)} días` : 'Sin estados financieros cargados' }] : []),
    ...(loanTapes.length === 0 ? [{ severity: 'warning', title: 'Loan tape faltante', detail: 'No hay loan tape cargada para monitoreo' }] : []),
    ...(transactions.length === 0 ? [{ severity: 'warning', title: 'Contrato/facility faltante', detail: 'No hay transacción registrada' }] : []),
  ];
  const readiness = [
    !!client.name,
    transactions.length > 0,
    statements.length > 0,
    covenants.length > 0,
    loanTapes.length > 0,
  ].filter(Boolean).length;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 xl:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-2xl p-5">
          <p className="text-xs font-black text-slate-400 uppercase tracking-widest">Readiness SaaS</p>
          <p className="text-3xl font-black text-slate-900 mt-2">{readiness}/5</p>
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
          <p className="text-xs font-black text-indigo-600 uppercase tracking-widest">Último periodo</p>
          <p className="text-xl font-black text-indigo-800 mt-3">{latestStatement?.period || client.lastPeriod || 'N/A'}</p>
        </div>
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
            <Step done={!!client.name} label="Cliente registrado" />
            <Step done={transactions.length > 0} label="Contrato/facility cargado" />
            <Step done={statements.length > 0} label="EFF extraídos y revisados" />
            <Step done={covenants.length > 0} label="Covenants configurados" />
            <Step done={loanTapes.length > 0} label="Loan tape cargada" />
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
