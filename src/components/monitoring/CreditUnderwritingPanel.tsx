import React from 'react';
import { Client, Covenant_DB, FinancialStatement_DB, LoanTape_DB, Transaction } from '../../db/index';
import { AlertTriangle, ArrowDownRight, ArrowUpRight, CheckCircle, Circle, FileClock, Gauge, Landmark, Lock, Minus, ShieldCheck, FileSpreadsheet, Scale, TrendingUp } from 'lucide-react';
import { evaluateCovenantAuto, evaluateCovenantForStatement, isPercentCovenant, resolveCovenantThreshold, standardRatios } from '../../lib/financialMetrics';

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

function money(value: number, currency = 'MXN') {
  return value.toLocaleString('es-MX', { style: 'currency', currency, maximumFractionDigits: 0 });
}

function pct(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'N/A';
  return `${(value * 100).toFixed(1)}%`;
}

function compactNumber(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'N/A';
  return value.toLocaleString('es-MX', { maximumFractionDigits: 4 });
}

function statusClass(status: string) {
  if (status === 'incumple') return 'bg-rose-50 text-rose-800 border-rose-200';
  if (status === 'alerta') return 'bg-amber-50 text-amber-800 border-amber-200';
  return 'bg-emerald-50 text-emerald-800 border-emerald-200';
}

function strongStatusClass(status: string) {
  if (status === 'incumple') return 'bg-rose-600 text-white border-rose-700';
  if (status === 'alerta') return 'bg-amber-400 text-amber-950 border-amber-500';
  return 'bg-emerald-600 text-white border-emerald-700';
}

function movementIcon(delta: number | null) {
  if (delta === null || Math.abs(delta) < 0.000001) return <Minus className="w-3.5 h-3.5 text-slate-400" />;
  return delta > 0 ? <ArrowUpRight className="w-3.5 h-3.5 text-amber-600" /> : <ArrowDownRight className="w-3.5 h-3.5 text-emerald-600" />;
}

function parsePercentText(value?: string) {
  if (!value) return null;
  const normalized = value.replace('%', '').replace(',', '.').trim();
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;
  return parsed > 1 ? parsed / 100 : parsed;
}

function covenantOperatorLabel(operator: Covenant_DB['operator']) {
  if (operator === 'gte') return '>=';
  if (operator === 'gt') return '>';
  if (operator === 'lte') return '<=';
  if (operator === 'lt') return '<';
  return 'N/A';
}

function covenantValueLabel(value: number | null, covenant: Covenant_DB) {
  if (value === null || !Number.isFinite(value)) return 'N/A';
  if (isPercentCovenant(covenant) && Math.abs(value) <= 3) return `${(value * 100).toFixed(1)}%`;
  return value.toLocaleString('es-MX', { maximumFractionDigits: 2 });
}

function covenantRequirementLabel(covenant: Covenant_DB) {
  if (covenant.operator === 'none' || !covenant.threshold) return 'Sin umbral';
  const threshold = resolveCovenantThreshold(covenant);
  const value = threshold === null ? covenant.threshold : covenantValueLabel(threshold, covenant);
  return `${covenantOperatorLabel(covenant.operator)} ${value}`;
}

function covenantHeadroom(value: number | null, covenant: Covenant_DB) {
  const threshold = resolveCovenantThreshold(covenant);
  if (value === null || threshold === null || covenant.operator === 'none') return null;
  if (covenant.operator === 'gte' || covenant.operator === 'gt') return value - threshold;
  if (covenant.operator === 'lte' || covenant.operator === 'lt') return threshold - value;
  return null;
}

const CreditUnderwritingPanel: React.FC<Props> = ({ client, transactions, statements, covenants, loanTapes }) => {
  const sortedStatements = [...statements].sort((a, b) => a.periodDate.localeCompare(b.periodDate));
  const latestStatement = sortedStatements.at(-1);
  const previousStatement = sortedStatements.at(-2);
  const sortedTapes = [...loanTapes].sort((a, b) => (b.uploadDate || '').localeCompare(a.uploadDate || ''));
  const latestTape = sortedTapes[0];
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
  const previousRatios = previousStatement ? standardRatios(previousStatement) : [];
  const ratioRows = latestRatios.map(ratio => {
    const previous = previousRatios.find(item => item.key === ratio.key)?.value ?? null;
    const delta = ratio.value !== null && previous !== null ? ratio.value - previous : null;
    return { ...ratio, previous, delta };
  });
  const covenantResults = covenants.filter(c => c.type === 'financial').map(c => ({ covenant: c, ...evaluateCovenantAuto(c, sortedStatements) }));
  const breaches = covenantResults.filter(r => r.status === 'incumple');
  const warnings = covenantResults.filter(r => r.status === 'alerta');
  const priorityCovenants = covenantResults
    .sort((a, b) => {
      const rank: Record<string, number> = { incumple: 0, alerta: 1, cumple: 2 };
      return rank[a.status] - rank[b.status] || a.covenant.name.localeCompare(b.covenant.name);
    });
  const covenantStatementWindow = sortedStatements.slice(-6);
  const uploadedFinancialFiles = new Set(statements.map(s => s.fileName).filter(Boolean));
  const testedCovenants = covenantResults.filter(r => r.value !== null || r.mode === 'manual').length;
  const complianceScore = covenantResults.length === 0 ? null : Math.round(((covenantResults.length - breaches.length - warnings.length * 0.5) / covenantResults.length) * 100);
  const primaryTransaction = transactions[0];
  const facilityAmount = primaryTransaction?.originalAmount || client.totalCreditValue || 0;
  const utilization = facilityAmount > 0 ? tapeBalance / facilityAmount : null;
  const remainingAvailability = facilityAmount > 0 ? Math.max(facilityAmount - tapeBalance, 0) : null;
  const aforoRequired = parsePercentText(client.aforoRequerido);
  const collateralCoverage = tapeBalance > 0 && client.currentDue > 0 ? tapeBalance / client.currentDue : null;
  const highValidationIssues = tapeValidation.filter((issue: any) => issue?.severity === 'high').length;
  const anomalyCounts = {
    newLoans: tapeAnomalies.new_loans?.length || 0,
    disappeared: tapeAnomalies.disappeared_loans?.length || 0,
    dpdDeterioration: tapeAnomalies.dpd_deterioration?.length || 0,
    conditionChanges: tapeAnomalies.condition_changes?.length || 0,
  };
  const financialCompleteness = latestRatios.length === 0 ? 0 : Math.round((latestRatios.filter(r => r.value !== null).length / latestRatios.length) * 100);
  const contractChecks = [
    {
      label: 'Contrato / facility',
      value: primaryTransaction?.name || client.contractName || 'Pendiente',
      status: primaryTransaction || client.contractName ? 'cumple' : 'incumple',
    },
    {
      label: 'Saldo tape vs línea',
      value: utilization === null ? 'N/A' : pct(utilization),
      status: utilization === null ? 'alerta' : utilization > 1 ? 'incumple' : utilization > 0.9 ? 'alerta' : 'cumple',
    },
    {
      label: 'Aforo / cobertura',
      value: collateralCoverage === null ? (client.aforoRequerido || 'N/A') : `${collateralCoverage.toFixed(2)}x`,
      status: collateralCoverage === null || aforoRequired === null ? 'alerta' : collateralCoverage >= aforoRequired ? 'cumple' : 'incumple',
    },
    {
      label: 'Vencimiento contrato',
      value: primaryTransaction?.maturityAt || 'Pendiente',
      status: primaryTransaction?.maturityAt ? (daysSince(primaryTransaction.maturityAt) > 0 ? 'incumple' : 'cumple') : 'alerta',
    },
  ];
  const alerts = [
    ...breaches.map(r => ({ severity: 'critical', title: `Covenant incumplido: ${r.covenant.name}`, detail: r.value === null ? 'Sin valor calculable' : `Valor actual ${r.value.toLocaleString('es-MX', { maximumFractionDigits: 4 })}` })),
    ...(daysSince(latestStatement?.periodDate) > 45 ? [{ severity: 'warning', title: 'Estados financieros vencidos', detail: latestStatement ? `Último periodo hace ${daysSince(latestStatement.periodDate)} días` : 'Sin estados financieros cargados' }] : []),
    ...(loanTapes.length === 0 ? [{ severity: 'warning', title: 'Loan tape faltante', detail: 'No hay loan tape cargada para monitoreo' }] : []),
    ...(latestTape && !tapeAnalysis ? [{ severity: 'warning', title: 'Loan tape sin analizar', detail: 'Carga hecha, falta correr análisis de cartera' }] : []),
    ...(vencidaPct > 0 ? [{ severity: vencidaPct > 0.1 ? 'critical' : 'warning', title: 'Cartera vencida detectada', detail: `${(vencidaPct * 100).toFixed(1)}% del saldo en >90 DPD` }] : []),
    ...(utilization !== null && utilization > 1 ? [{ severity: 'critical', title: 'Loan tape excede línea contratada', detail: `Utilización calculada ${pct(utilization)} sobre ${money(facilityAmount, client.currency)}` }] : []),
    ...(maxClient?.pct > 0.2 ? [{ severity: 'warning', title: 'Concentración alta por cliente', detail: `${maxClient.name}: ${pct(maxClient.pct)} del saldo` }] : []),
    ...(highValidationIssues > 0 ? [{ severity: 'warning', title: 'Calidad de datos del tape', detail: `${highValidationIssues} validaciones críticas en el archivo` }] : []),
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
      <div className="underwriting-hero rounded-2xl p-6">
        <div className="flex flex-col xl:flex-row xl:items-end justify-between gap-5">
          <div>
            <p className="text-[10px] font-black uppercase tracking-widest">Expediente de crédito</p>
            <h2 className="text-2xl font-black tracking-tight mt-1">{client.name}</h2>
            <p className="text-sm font-bold mt-2">
              Underwriting, covenants, estados financieros, contrato y soporte de cartera.
            </p>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 min-w-full xl:min-w-[680px]">
            <div className="underwriting-hero-metric rounded-xl px-4 py-3">
              <p className="text-[10px] font-black uppercase tracking-widest">Acreditado</p>
              <p className="text-sm font-black truncate mt-1">{client.industry || 'Industria pendiente'}</p>
            </div>
            <div className="underwriting-hero-metric rounded-xl px-4 py-3">
              <p className="text-[10px] font-black uppercase tracking-widest">Score</p>
              <p className="text-sm font-black truncate mt-1">{client.score || 'N/A'}</p>
            </div>
            <div className="underwriting-hero-metric rounded-xl px-4 py-3">
              <p className="text-[10px] font-black uppercase tracking-widest">Línea</p>
              <p className="text-sm font-black truncate mt-1">{facilityAmount ? money(facilityAmount, client.currency) : 'N/A'}</p>
            </div>
            <div className="underwriting-hero-metric rounded-xl px-4 py-3">
              <p className="text-[10px] font-black uppercase tracking-widest">Último corte</p>
              <p className="text-sm font-black truncate mt-1">{latestStatement?.period || client.lastPeriod || 'N/A'}</p>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-2xl p-5">
          <p className="text-xs font-black text-slate-400 uppercase tracking-widest">Preparación expediente</p>
          <p className="text-3xl font-black text-slate-900 mt-2">{readiness}/{readinessChecks.length}</p>
          <div className="h-2 bg-slate-100 rounded-full mt-3 overflow-hidden">
            <div className="h-full bg-indigo-600 rounded-full" style={{ width: `${(readiness / readinessChecks.length) * 100}%` }} />
          </div>
        </div>
        <div className="bg-white border border-rose-200 rounded-2xl p-5">
          <p className="text-xs font-black text-rose-500 uppercase tracking-widest">Incumplimientos</p>
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

      <div className="grid grid-cols-1 2xl:grid-cols-5 gap-6">
        <div className="2xl:col-span-3 bg-white border border-slate-200 rounded-2xl p-6">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 mb-5">
            <div>
              <h3 className="text-sm font-black text-slate-900 uppercase tracking-widest flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-indigo-600" />Monitoreo financiero
              </h3>
              <p className="text-xs text-slate-500 font-bold mt-1">
                {latestStatement ? `${latestStatement.period} vs ${previousStatement?.period || 'sin comparativo'}` : 'Sin estado financiero cargado'}
              </p>
            </div>
            <span className="text-xs font-black text-indigo-700 bg-indigo-50 border border-indigo-100 rounded-full px-3 py-1">
              {financialCompleteness}% variables calculables
            </span>
          </div>

          <div className="overflow-x-auto border border-slate-100 rounded-xl">
            <table className="w-full text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="text-left px-4 py-3 text-[10px] font-black text-slate-500 uppercase tracking-widest">Métrica</th>
                  <th className="text-right px-4 py-3 text-[10px] font-black text-slate-500 uppercase tracking-widest">Actual</th>
                  <th className="text-right px-4 py-3 text-[10px] font-black text-slate-500 uppercase tracking-widest">Anterior</th>
                  <th className="text-right px-4 py-3 text-[10px] font-black text-slate-500 uppercase tracking-widest">Cambio</th>
                </tr>
              </thead>
              <tbody>
                {ratioRows.slice(0, 8).map(row => (
                  <tr key={row.key} className="border-t border-slate-100">
                    <td className="px-4 py-3">
                      <p className="font-black text-slate-800">{row.label}</p>
                      <p className="text-[10px] text-slate-400 font-mono">{row.formula}</p>
                    </td>
                    <td className="px-4 py-3 text-right font-mono font-black text-slate-900">{compactNumber(row.value)}</td>
                    <td className="px-4 py-3 text-right font-mono text-slate-500">{compactNumber(row.previous)}</td>
                    <td className="px-4 py-3 text-right">
                      <span className="inline-flex items-center justify-end gap-1 font-mono font-black text-slate-700">
                        {movementIcon(row.delta)}
                        {compactNumber(row.delta)}
                      </span>
                    </td>
                  </tr>
                ))}
                {ratioRows.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center text-sm font-bold text-slate-400">Carga EFF para activar el monitoreo financiero.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="2xl:col-span-2 bg-white border border-slate-200 rounded-2xl p-6">
          <div className="flex items-center justify-between gap-3 mb-5">
            <h3 className="text-sm font-black text-slate-900 uppercase tracking-widest flex items-center gap-2">
              <Scale className="w-4 h-4 text-indigo-600" />Covenants financieros
            </h3>
            <span className="text-xs font-black text-slate-500">{testedCovenants}/{covenantResults.length}</span>
          </div>
          <div className="space-y-3">
            {covenantResults.slice(0, 6).map(row => (
              <div key={row.covenant.id} className={`border rounded-xl px-4 py-3 ${statusClass(row.status)}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-black truncate">{row.covenant.name}</p>
                    <p className="text-[10px] font-bold opacity-75 mt-0.5">{row.mode === 'manual' ? 'Manual' : row.covenant.formula || 'Sin fórmula'} · {row.covenant.operator} {row.covenant.threshold || 'N/A'}</p>
                  </div>
                  <span className="text-[10px] font-black uppercase">{row.status}</span>
                </div>
                <p className="font-mono font-black text-right mt-2">{compactNumber(row.value)}</p>
              </div>
            ))}
            {covenantResults.length === 0 && (
              <p className="text-sm text-slate-400 font-bold bg-slate-50 border border-slate-100 rounded-xl px-4 py-5 text-center">
                Sin covenants financieros configurados.
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
        <div className="px-6 py-5 border-b border-slate-100 flex flex-col xl:flex-row xl:items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-black text-slate-900 uppercase tracking-widest flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-indigo-600" />Covenants vs estados financieros
            </h3>
            <p className="text-xs text-slate-500 font-bold mt-1">
              Lectura directa de requisito, valor, estatus y holgura por periodo cargado.
            </p>
          </div>
          <div className="flex gap-2 text-[10px] font-black uppercase">
            <span className="rounded-full bg-emerald-100 text-emerald-800 px-2.5 py-1">Cumple</span>
            <span className="rounded-full bg-amber-100 text-amber-800 px-2.5 py-1">Cerca</span>
            <span className="rounded-full bg-rose-100 text-rose-800 px-2.5 py-1">Incumple</span>
          </div>
        </div>

        {priorityCovenants.length > 0 && covenantStatementWindow.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50">
                <tr>
                  <th className="text-left px-4 py-3 font-black text-slate-500 uppercase tracking-widest min-w-[220px]">Covenant</th>
                  <th className="text-left px-4 py-3 font-black text-slate-500 uppercase tracking-widest">Requisito</th>
                  <th className="text-right px-4 py-3 font-black text-slate-500 uppercase tracking-widest">Actual</th>
                  <th className="text-right px-4 py-3 font-black text-slate-500 uppercase tracking-widest">Holgura</th>
                  {covenantStatementWindow.map(stmt => (
                    <th key={stmt.id} className="text-center px-3 py-3 font-black text-slate-500 uppercase tracking-widest whitespace-nowrap">{stmt.period}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {priorityCovenants.map(row => {
                  const latestHeadroom = covenantHeadroom(row.value, row.covenant);
                  return (
                    <tr key={row.covenant.id} className="border-t border-slate-100">
                      <td className="px-4 py-3">
                        <p className="font-black text-slate-900">{row.covenant.name}</p>
                        <p className="text-[10px] font-bold text-slate-400 truncate max-w-[260px]">{row.covenant.formula || row.covenant.description || 'Sin fórmula'}</p>
                      </td>
                      <td className="px-4 py-3 font-mono font-black text-slate-700 whitespace-nowrap">{covenantRequirementLabel(row.covenant)}</td>
                      <td className="px-4 py-3 text-right font-mono font-black text-slate-900">{covenantValueLabel(row.value, row.covenant)}</td>
                      <td className={`px-4 py-3 text-right font-mono font-black ${latestHeadroom !== null && latestHeadroom < 0 ? 'text-rose-700' : latestHeadroom !== null ? 'text-emerald-700' : 'text-slate-400'}`}>
                        {latestHeadroom === null ? 'N/A' : covenantValueLabel(latestHeadroom, row.covenant)}
                      </td>
                      {covenantStatementWindow.map(stmt => {
                        const result = evaluateCovenantForStatement(row.covenant, stmt);
                        return (
                          <td key={stmt.id} className="px-3 py-3 text-center">
                            <div className={`inline-flex min-w-20 flex-col items-center rounded-lg border px-2.5 py-1.5 ${result.value === null ? 'bg-slate-50 text-slate-400 border-slate-200' : strongStatusClass(result.status)}`}>
                              <span className="font-mono font-black">{covenantValueLabel(result.value, row.covenant)}</span>
                              <span className="text-[9px] font-black uppercase opacity-80">{result.value === null ? 'N/D' : result.status}</span>
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="px-6 py-8 text-sm text-slate-400 font-bold text-center">
            Configura covenants con umbral y carga estados financieros para activar la matriz de cumplimiento.
          </p>
        )}
      </div>

      <div className="bg-white border border-slate-200 rounded-2xl p-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 mb-5">
          <div>
            <h3 className="text-sm font-black text-slate-900 uppercase tracking-widest flex items-center gap-2">
              <Landmark className="w-4 h-4 text-indigo-600" />Contrato vs Loan Tape
            </h3>
            <p className="text-xs text-slate-500 font-bold mt-1">
              Reconciliación de línea contratada, saldo analizado, aforo y vencimiento.
            </p>
          </div>
          <span className="text-xs font-black text-slate-500 bg-slate-100 rounded-full px-3 py-1">
            {primaryTransaction?.name || client.contractName || 'sin contrato'}
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-5">
          <div className="rounded-xl bg-slate-50 p-4">
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Línea contratada</p>
            <p className="text-xl font-black text-slate-900 mt-1">{facilityAmount ? money(facilityAmount, client.currency) : 'N/A'}</p>
          </div>
          <div className="rounded-xl bg-slate-50 p-4">
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Saldo loan tape</p>
            <p className="text-xl font-black text-slate-900 mt-1">{money(tapeBalance, client.currency)}</p>
          </div>
          <div className="rounded-xl bg-indigo-50 p-4">
            <p className="text-[10px] font-black text-indigo-600 uppercase tracking-widest">Utilización</p>
            <p className="text-xl font-black text-indigo-900 mt-1">{pct(utilization)}</p>
            <p className="text-[10px] text-indigo-600 font-bold mt-1">Disponible {remainingAvailability === null ? 'N/A' : money(remainingAvailability, client.currency)}</p>
          </div>
          <div className="rounded-xl bg-slate-50 p-4">
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Cobertura / Aforo</p>
            <p className="text-xl font-black text-slate-900 mt-1">{collateralCoverage === null ? 'N/A' : `${collateralCoverage.toFixed(2)}x`}</p>
            <p className="text-[10px] text-slate-500 font-bold mt-1">Req. {client.aforoRequerido || 'N/A'}</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          {contractChecks.map(check => (
            <div key={check.label} className={`rounded-xl border px-4 py-3 ${statusClass(check.status)}`}>
              <p className="text-[10px] font-black uppercase tracking-widest opacity-75">{check.label}</p>
              <p className="text-sm font-black mt-1 truncate">{check.value}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-2xl p-6">
        <div className="flex items-center justify-between gap-4 mb-5">
          <h3 className="text-sm font-black text-slate-900 uppercase tracking-widest flex items-center gap-2">
            <FileSpreadsheet className="w-4 h-4 text-indigo-600" />Cartera / Loan Tape
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

            <div className="grid grid-cols-1 xl:grid-cols-4 gap-4">
              <div className="rounded-xl border border-slate-200 p-4">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-2">
                  <Gauge className="w-3.5 h-3.5" />Calidad de datos
                </p>
                <p className="text-2xl font-black text-slate-900 mt-2">{highValidationIssues}</p>
                <p className="text-xs text-slate-500 font-bold">validaciones críticas · {tapeValidation.length} totales</p>
              </div>
              <div className="rounded-xl border border-slate-200 p-4">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Nuevos créditos</p>
                <p className="text-2xl font-black text-slate-900 mt-2">{anomalyCounts.newLoans}</p>
                <p className="text-xs text-slate-500 font-bold">vs corte anterior</p>
              </div>
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
                <p className="text-[10px] font-black text-amber-600 uppercase tracking-widest">Deterioros DPD</p>
                <p className="text-2xl font-black text-amber-800 mt-2">{anomalyCounts.dpdDeterioration}</p>
                <p className="text-xs text-amber-700 font-bold">créditos con mayor atraso</p>
              </div>
              <div className="rounded-xl border border-slate-200 p-4">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Cambios condición</p>
                <p className="text-2xl font-black text-slate-900 mt-2">{anomalyCounts.conditionChanges}</p>
                <p className="text-xs text-slate-500 font-bold">{anomalyCounts.disappeared} créditos desaparecen</p>
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

            {tapeValidation.length > 0 && (
              <div className="rounded-xl border border-slate-200 overflow-hidden">
                <div className="px-4 py-3 bg-slate-50 text-xs font-black uppercase tracking-widest text-slate-600">Validaciones principales</div>
                <div className="divide-y divide-slate-100">
                  {tapeValidation.slice(0, 6).map((issue: any, index: number) => (
                    <div key={`${issue.rule_id || 'issue'}-${index}`} className="grid grid-cols-1 md:grid-cols-[140px_1fr_110px] gap-2 px-4 py-3 text-sm">
                      <span className="font-mono font-black text-slate-500">{issue.loan_id || 'fila'}</span>
                      <span className="font-bold text-slate-700">{issue.message || issue.field || 'Validación pendiente'}</span>
                      <span className={`justify-self-start md:justify-self-end text-[10px] font-black uppercase rounded-full px-2 py-1 ${
                        issue.severity === 'high' ? 'bg-rose-100 text-rose-800' :
                        issue.severity === 'medium' ? 'bg-amber-100 text-amber-800' :
                        'bg-slate-100 text-slate-600'
                      }`}>
                        {issue.severity || 'info'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="bg-white border border-slate-200 rounded-2xl p-6">
          <h3 className="text-sm font-black text-slate-900 uppercase tracking-widest mb-4 flex items-center gap-2"><ShieldCheck className="w-4 h-4 text-indigo-600" />Ficha de underwriting</h3>
          <div className="space-y-4">
            <div className="rounded-xl bg-slate-50 p-4">
              <p className="text-xs font-black text-slate-400 uppercase">Acreditado</p>
              <p className="font-black text-slate-900">{client.name}</p>
              <p className="text-xs text-slate-500">{client.industry || 'Industria pendiente'} · Score {client.score || 'N/A'}</p>
            </div>
            <div className="rounded-xl bg-slate-50 p-4">
              <p className="text-xs font-black text-slate-400 uppercase">Contrato / línea</p>
              <p className="font-black text-slate-900">{client.contractName || transactions[0]?.name || 'Contrato pendiente'}</p>
              <p className="text-xs text-slate-500">{client.currency} {client.totalCreditValue.toLocaleString('es-MX')}</p>
            </div>
            <div className="rounded-xl bg-slate-50 p-4">
              <p className="text-xs font-black text-slate-400 uppercase">Garantía / cartera</p>
              <p className="font-black text-slate-900">{latestTape?.name || 'Loan tape pendiente'}</p>
              <p className="text-xs text-slate-500">{latestTape?.fileName || 'Sin archivo'}</p>
            </div>
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl p-6">
          <h3 className="text-sm font-black text-slate-900 uppercase tracking-widest mb-4 flex items-center gap-2"><Lock className="w-4 h-4 text-indigo-600" />Checklist expediente</h3>
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
        <h3 className="text-sm font-black text-slate-900 uppercase tracking-widest mb-4 flex items-center gap-2"><AlertTriangle className="w-4 h-4 text-amber-600" />Hallazgos de crédito</h3>
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

export default CreditUnderwritingPanel;
