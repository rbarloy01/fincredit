// Portfolio-wide analytics for the global dashboard (and reused by the CRM).
// Pure functions: all "now" is injected so this stays testable and deterministic.
import { Client, Covenant_DB, CrmActivity, FinancialStatement_DB, Transaction } from '../db/index';
import { evaluateCovenantAuto, RatioStatus } from './financialMetrics';
import { CreditRiskPrediction, predictCreditRisk } from './creditRiskModel';

const DAY_MS = 24 * 60 * 60 * 1000;

function parseDate(value?: string | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function addMonths(d: Date, months: number): Date {
  const r = new Date(d.getTime());
  r.setMonth(r.getMonth() + months);
  return r;
}

export function daysBetween(a: Date, b: Date): number {
  return Math.round((a.getTime() - b.getTime()) / DAY_MS);
}

export interface CovenantBreach {
  name: string;
  value: number | null;
  status: RatioStatus;
}

export interface ReportingStatus {
  cadenceMonths: number;
  latestPeriodDate: Date | null;
  latestPeriodLabel: string | null;
  hasStatements: boolean;
  nextDueDate: Date | null;
  daysOverdue: number; // >0 = overdue, <=0 = on time / not yet due
  isOverdue: boolean;
  reason: 'sin_eeff' | 'cadencia' | 'ok';
}

export interface UpcomingMaturity {
  transactionId: string;
  name: string;
  maturityAt: string;
  days: number; // days from now (0..window)
  amount: number;
  currency: string;
}

export interface ClientSignal {
  client: Client;
  exposure: number;
  balance: number;
  currency: string;
  financialCovenantCount: number;
  breaches: CovenantBreach[];
  warnings: CovenantBreach[];
  breachCount: number;
  warningCount: number;
  worst: CovenantBreach | null;
  risk: CreditRiskPrediction | null;
  reporting: ReportingStatus;
  docsOutstanding: number; // documentation entries flagged not compliant
  upcomingMaturities: UpcomingMaturity[];
  openActivities: number;
  overdueActivities: number;
  // A single 0..100 severity score used for watchlist ordering.
  severity: number;
}

export interface PortfolioInputs {
  clients: Client[];
  statementsByClient: Record<string, FinancialStatement_DB[]>;
  covenantsByClient: Record<string, Covenant_DB[]>;
  transactionsByClient: Record<string, Transaction[]>;
  activitiesByClient: Record<string, CrmActivity[]>;
  now: Date;
  maturityWindowDays?: number; // default 90
  reportingGraceDays?: { monthly: number; quarterly: number };
}

function computeReporting(
  client: Client,
  statements: FinancialStatement_DB[],
  now: Date,
  grace: { monthly: number; quarterly: number },
): ReportingStatus {
  const cadenceMonths = client.frequency === 'trimestral' ? 3 : 1;
  const graceDays = cadenceMonths === 3 ? grace.quarterly : grace.monthly;
  const sorted = [...statements].sort((a, b) => {
    const da = parseDate(a.periodDate)?.getTime() ?? 0;
    const dbt = parseDate(b.periodDate)?.getTime() ?? 0;
    return db_num(da) - db_num(dbt);
  });
  const latest = sorted[sorted.length - 1];
  const latestPeriodDate = latest ? parseDate(latest.periodDate) : null;
  const hasStatements = statements.length > 0;

  if (!hasStatements || !latestPeriodDate) {
    return {
      cadenceMonths,
      latestPeriodDate: null,
      latestPeriodLabel: latest?.period ?? null,
      hasStatements,
      nextDueDate: null,
      daysOverdue: hasStatements ? 0 : Number.POSITIVE_INFINITY,
      isOverdue: !hasStatements,
      reason: hasStatements ? 'ok' : 'sin_eeff',
    };
  }

  // Next statement is expected one cadence after the latest reported period,
  // plus a filing grace period. Overdue only once that due date has passed.
  const nextDueDate = new Date(addMonths(latestPeriodDate, cadenceMonths).getTime() + graceDays * DAY_MS);
  const daysOverdue = daysBetween(now, nextDueDate);
  const isOverdue = daysOverdue > 0;
  return {
    cadenceMonths,
    latestPeriodDate,
    latestPeriodLabel: latest?.period ?? null,
    hasStatements,
    nextDueDate,
    daysOverdue,
    isOverdue,
    reason: isOverdue ? 'cadencia' : 'ok',
  };
}

// tiny guard so NaN sorts last
function db_num(n: number): number {
  return Number.isFinite(n) ? n : 0;
}

export function computeClientSignal(
  client: Client,
  statements: FinancialStatement_DB[],
  covenants: Covenant_DB[],
  transactions: Transaction[],
  activities: CrmActivity[],
  now: Date,
  maturityWindowDays: number,
  grace: { monthly: number; quarterly: number },
): ClientSignal {
  const financialCovenants = covenants.filter(c => c.type === 'financial');
  const breaches: CovenantBreach[] = [];
  const warnings: CovenantBreach[] = [];
  for (const cov of financialCovenants) {
    const evalResult = evaluateCovenantAuto(cov, statements);
    if (evalResult.status === 'incumple') breaches.push({ name: cov.name, value: evalResult.value, status: 'incumple' });
    else if (evalResult.status === 'alerta') warnings.push({ name: cov.name, value: evalResult.value, status: 'alerta' });
  }
  const worst = breaches[0] || warnings[0] || null;

  let risk: CreditRiskPrediction | null = null;
  try {
    risk = statements.length ? predictCreditRisk(statements, covenants) : null;
  } catch {
    risk = null;
  }

  const reporting = computeReporting(client, statements, now, grace);

  const docsOutstanding = (client.documentation || []).filter(d => d && d.isCompliant === false).length;

  const upcomingMaturities: UpcomingMaturity[] = [];
  for (const tx of transactions) {
    const maturity = parseDate(tx.maturityAt);
    if (!maturity) continue;
    const days = daysBetween(maturity, now);
    if (days >= 0 && days <= maturityWindowDays) {
      upcomingMaturities.push({
        transactionId: tx.id,
        name: tx.name || client.contractName || tx.creditType || 'Contrato',
        maturityAt: tx.maturityAt,
        days,
        amount: tx.originalAmount || 0,
        currency: tx.currency || client.currency,
      });
    }
  }
  upcomingMaturities.sort((a, b) => a.days - b.days);

  const openActivities = activities.filter(a => a.status === 'planned').length;
  const overdueActivities = activities.filter(a => {
    if (a.status !== 'planned' || !a.dueAt) return false;
    const due = parseDate(a.dueAt);
    return due ? due.getTime() < now.getTime() : false;
  }).length;

  const exposure = transactions.reduce((sum, tx) => sum + (tx.originalAmount || 0), 0) || client.totalCreditValue || 0;
  const balance = client.currentDue || exposure;

  // Severity: an actual covenant breach is the single most actionable signal and must
  // always outrank heuristic risk / stale reporting, so it carries the heaviest weight.
  let severity = 0;
  severity += breaches.length * 40;
  severity += warnings.length * 10;
  if (reporting.reason === 'sin_eeff') severity += 20;
  else if (reporting.isOverdue) severity += Math.min(15, 4 + reporting.daysOverdue / 20);
  if (risk?.riskBand === 'high') severity += 15;
  else if (risk?.riskBand === 'medium') severity += 6;
  severity += overdueActivities * 6;
  severity += docsOutstanding * 4;
  severity = Math.min(100, Math.round(severity));

  return {
    client,
    exposure,
    balance,
    currency: client.currency,
    financialCovenantCount: financialCovenants.length,
    breaches,
    warnings,
    breachCount: breaches.length,
    warningCount: warnings.length,
    worst,
    risk,
    reporting,
    docsOutstanding,
    upcomingMaturities,
    openActivities,
    overdueActivities,
    severity,
  };
}

export interface PortfolioSummary {
  signals: ClientSignal[];
  totalClients: number;
  monitoredClients: number; // has any statement or loan tape context (statements here)
  exposureByCurrency: Record<string, number>;
  balanceByCurrency: Record<string, number>;
  clientsInBreach: ClientSignal[];
  clientsWithWarnings: ClientSignal[];
  overdueReporting: ClientSignal[];
  docsOutstandingTotal: number;
  riskDistribution: { low: number; medium: number; high: number; unknown: number };
  upcomingMaturities: Array<UpcomingMaturity & { client: Client }>;
  watchlist: ClientSignal[];
}

export function buildPortfolioSummary(inputs: PortfolioInputs): PortfolioSummary {
  const now = inputs.now;
  const maturityWindowDays = inputs.maturityWindowDays ?? 90;
  const grace = inputs.reportingGraceDays ?? { monthly: 40, quarterly: 75 };

  const signals = inputs.clients.map(client =>
    computeClientSignal(
      client,
      inputs.statementsByClient[client.id] || [],
      inputs.covenantsByClient[client.id] || [],
      inputs.transactionsByClient[client.id] || [],
      inputs.activitiesByClient[client.id] || [],
      now,
      maturityWindowDays,
      grace,
    ),
  );

  const exposureByCurrency: Record<string, number> = {};
  const balanceByCurrency: Record<string, number> = {};
  const riskDistribution = { low: 0, medium: 0, high: 0, unknown: 0 };
  let docsOutstandingTotal = 0;
  let monitoredClients = 0;

  for (const s of signals) {
    exposureByCurrency[s.currency] = (exposureByCurrency[s.currency] || 0) + s.exposure;
    balanceByCurrency[s.currency] = (balanceByCurrency[s.currency] || 0) + s.balance;
    docsOutstandingTotal += s.docsOutstanding;
    if (s.reporting.hasStatements) monitoredClients += 1;
    if (!s.risk) riskDistribution.unknown += 1;
    else riskDistribution[s.risk.riskBand] += 1;
  }

  const clientsInBreach = signals.filter(s => s.breachCount > 0).sort((a, b) => b.severity - a.severity);
  const clientsWithWarnings = signals.filter(s => s.breachCount === 0 && s.warningCount > 0).sort((a, b) => b.severity - a.severity);
  const overdueReporting = signals
    .filter(s => s.reporting.isOverdue || s.docsOutstanding > 0)
    .sort((a, b) => {
      const ao = a.reporting.reason === 'sin_eeff' ? Number.POSITIVE_INFINITY : a.reporting.daysOverdue;
      const bo = b.reporting.reason === 'sin_eeff' ? Number.POSITIVE_INFINITY : b.reporting.daysOverdue;
      return db_num(bo) - db_num(ao);
    });

  const upcomingMaturities = signals
    .flatMap(s => s.upcomingMaturities.map(m => ({ ...m, client: s.client })))
    .sort((a, b) => a.days - b.days);

  const watchlist = signals
    .filter(s => s.severity > 0)
    .sort((a, b) => b.severity - a.severity);

  return {
    signals,
    totalClients: inputs.clients.length,
    monitoredClients,
    exposureByCurrency,
    balanceByCurrency,
    clientsInBreach,
    clientsWithWarnings,
    overdueReporting,
    docsOutstandingTotal,
    riskDistribution,
    upcomingMaturities,
    watchlist,
  };
}
