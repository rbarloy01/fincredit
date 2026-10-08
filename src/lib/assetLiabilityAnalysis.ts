// Activo vs. pasivo: cruza la cartera (último corte del loan tape) contra los
// pasivos institucionales para responder "¿lo que cobra la cartera alcanza para
// lo que se paga a los fondeadores?". Descriptivo, sin juicio crediticio.
//
// Supuestos (se muestran en el reporte):
// - Cartera que cobra = vigente (0-30 DPD según portfolioRules); atrasada y
//   vencida no cuentan como cobranza esperada.
// - Cobranza mensual = cuota reportada (installment) cuando existe; si no,
//   capital lineal hasta end_date + interés mensual (saldo × tasa / 12).
// - Recuperación de capital de cartera: lineal mensual hasta end_date.
// - Servicio de deuda: calendario proyectado de pasivos (analyzeLiabilities) + interés.

import type { StandardLoan } from './loanTapeAnalytics';
import type { PortfolioAnalysis } from './loanTapeReport';
import { classifyDpd } from './portfolioRules';
import type { LiabilitiesAnalysis, LiabilityInsight } from './institutionalLiabilitiesAnalytics';

const MONTH_MS = 86400000 * 30.44;
const MONTHS_ES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

export interface QuarterGapRow {
  label: string;
  assetPrincipal: number;
  assetInterest: number;
  liabilityPrincipal: number;
  liabilityInterest: number;
  net: number;
  cumulative: number;
}

export interface LenderSpreadRow { lender: string; currentBalance: number; rate: number | null; spread: number | null }

export interface AssetLiabilityAnalysis {
  portfolioLabel: string;
  asset: {
    saldo: number;
    vigente: number;
    vigentePct: number;
    waRate: number | null;
    waRemainingMonths: number | null;
    annualInterestIncome: number;
    monthlyCollections: number;
    collectionsSource: 'cuota' | 'estimada' | 'mixta';
  };
  liability: {
    saldo: number;
    waRate: number | null;
    waRemainingMonths: number | null;
    annualInterest: number;
    monthlyDebtService: number;
  };
  spread: number | null;
  annualMargin: number;
  interestCoverage: number | null;
  serviceCoverage: number | null;
  aforoVigente: number | null;
  aforoTotal: number | null;
  termGapMonths: number | null;
  quarters: QuarterGapRow[];
  lenderSpreads: LenderSpreadRow[];
  insights: LiabilityInsight[];
}

const HORIZON = 25;

function monthsUntil(asOf: Date, date: string | null): number | null {
  if (!date) return null;
  const d = new Date(date);
  return Number.isFinite(d.getTime()) ? (d.getTime() - asOf.getTime()) / MONTH_MS : null;
}

function quarterSlices<T>(monthly: T[], reduce: (slice: T[]) => number): number[] {
  const out: number[] = [];
  for (let q = 0; q < 8; q++) out.push(reduce(monthly.slice(q === 0 ? 0 : q * 3 + 1, q * 3 + 4)));
  return out;
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const pp = (v: number) => `${(v * 100).toFixed(2)} pp`;
const mm = (v: number) => `$${(v / 1e6).toLocaleString('es-MX', { maximumFractionDigits: 1 })} M`;

export function analyzeAssetLiability(portfolio: PortfolioAnalysis | null, liab: LiabilitiesAnalysis, asOf: Date = new Date()): AssetLiabilityAnalysis | null {
  if (!portfolio || !portfolio.rows.length || liab.kpi.totalBalance <= 0) return null;

  const rows: StandardLoan[] = portfolio.rows;
  const bal = (r: StandardLoan) => Math.max(0, r.outstanding_balance ?? 0);
  const performing = rows.filter(r => classifyDpd(r.days_overdue) === 'vigente');
  const saldo = rows.reduce((s, r) => s + bal(r), 0);
  const vigente = performing.reduce((s, r) => s + bal(r), 0);

  const rated = performing.filter(r => r.interest_rate !== null && r.interest_rate > 0 && bal(r) > 0);
  const ratedBal = rated.reduce((s, r) => s + bal(r), 0);
  const waRate = ratedBal > 0 ? rated.reduce((s, r) => s + bal(r) * (r.interest_rate as number), 0) / ratedBal : portfolio.kpi.waRate;
  const annualInterestIncome = performing.reduce((s, r) => s + bal(r) * (r.interest_rate ?? waRate ?? 0), 0);

  // Monthly asset cash flow: principal (linear to end_date) + interest
  const assetPrincipal = Array(HORIZON).fill(0);
  const assetInterest = Array(HORIZON).fill(0);
  let withInstallment = 0;
  let monthlyCollections = 0;
  performing.forEach(r => {
    const b = bal(r);
    if (b <= 0) return;
    const rate = r.interest_rate ?? waRate ?? 0;
    const remaining = monthsUntil(asOf, r.end_date);
    const n = remaining === null ? null : Math.max(1, Math.ceil(remaining));
    let balance = b;
    for (let m = 1; m < HORIZON; m++) {
      if (balance <= 0) break;
      assetInterest[m] += balance * rate / 12;
      if (n !== null) {
        const principal = m >= n ? balance : b / n;
        assetPrincipal[m] += principal;
        balance -= principal;
      }
    }
    if (r.installment && r.installment > 0) {
      withInstallment += 1;
      monthlyCollections += r.installment;
    } else {
      monthlyCollections += (n !== null ? b / n : 0) + b * rate / 12;
    }
  });
  const collectionsSource = withInstallment === 0 ? 'estimada' : withInstallment === performing.length ? 'cuota' : 'mixta';

  // Monthly liability flow: projected principal + interest on the running balance
  const liabPrincipal = liab.monthlySchedule.slice(0, HORIZON).map(r => r.principal);
  const liabInterest = liab.monthlySchedule.slice(0, HORIZON).map((r, i) => {
    const opening = i === 0 ? liab.kpi.totalBalance : liab.monthlySchedule[i - 1].endingBalance;
    return i === 0 ? 0 : opening * (liab.kpi.waRate ?? 0) / 12;
  });
  const debtService12 = liabPrincipal.slice(0, 13).reduce((s, v) => s + v, 0) + liabInterest.slice(0, 13).reduce((s, v) => s + v, 0);
  const monthlyDebtService = debtService12 / 12;

  const sumSlice = (a: number[]) => a.reduce((s, v) => s + v, 0);
  const aP = quarterSlices(assetPrincipal, sumSlice);
  const aI = quarterSlices(assetInterest, sumSlice);
  const lP = quarterSlices(liabPrincipal, sumSlice);
  const lI = quarterSlices(liabInterest, sumSlice);
  let cumulative = 0;
  const quarters: QuarterGapRow[] = aP.map((_, q) => {
    const d = new Date(asOf.getFullYear(), asOf.getMonth() + q * 3 + 1, 1);
    const net = aP[q] + aI[q] - lP[q] - lI[q];
    cumulative += net;
    return {
      label: `T${q + 1} (${MONTHS_ES[d.getMonth()]}-${String(d.getFullYear()).slice(2)})`,
      assetPrincipal: aP[q], assetInterest: aI[q], liabilityPrincipal: lP[q], liabilityInterest: lI[q], net, cumulative,
    };
  });

  const liabRate = liab.kpi.waRate;
  const spread = waRate !== null && liabRate !== null ? waRate - liabRate : null;
  const annualMargin = annualInterestIncome - liab.kpi.annualInterest;
  const interestCoverage = liab.kpi.annualInterest > 0 ? annualInterestIncome / liab.kpi.annualInterest : null;
  const serviceCoverage = monthlyDebtService > 0 ? monthlyCollections / monthlyDebtService : null;
  const aforoVigente = liab.kpi.totalBalance > 0 ? vigente / liab.kpi.totalBalance : null;
  const aforoTotal = liab.kpi.totalBalance > 0 ? saldo / liab.kpi.totalBalance : null;
  const assetTerm = portfolio.kpi.waRemainingMonths;
  const termGapMonths = assetTerm !== null && liab.kpi.waRemainingMonths !== null ? assetTerm - liab.kpi.waRemainingMonths : null;

  const lenderSpreads: LenderSpreadRow[] = liab.lenders.map(l => ({
    lender: l.lender, currentBalance: l.currentBalance, rate: l.waRate,
    spread: waRate !== null && l.waRate !== null ? waRate - l.waRate : null,
  }));

  // Insights
  const insights: LiabilityInsight[] = [];
  if (spread !== null) {
    insights.push({
      severity: spread < 0 ? 'critical' : spread < 0.03 ? 'warning' : 'info',
      title: 'Spread tasa activa vs. pasiva',
      detail: `La cartera vigente rinde ${pct(waRate as number)} y el fondeo cuesta ${pct(liabRate as number)}: spread de ${pp(spread)}.`,
      recommendation: spread < 0.03 ? 'El margen es estrecho: revisar pricing de cartera y renegociación de las líneas más caras.' : 'Spread holgado; vigilar que se mantenga si sube la tasa de referencia (TIIE).',
    });
  }
  const negative = lenderSpreads.filter(l => l.spread !== null && l.spread < 0);
  if (negative.length) {
    insights.push({
      severity: 'warning',
      title: 'Fondeo más caro que la cartera',
      detail: `${negative.map(l => l.lender).join(', ')} cobra(n) más que la tasa activa ponderada.`,
      recommendation: 'Identificar qué cartera fondea cada línea y si existe un producto con tasa suficiente para cubrirla.',
    });
  }
  if (aforoVigente !== null) {
    insights.push({
      severity: aforoVigente < 1 ? 'critical' : aforoVigente < 1.2 ? 'warning' : 'info',
      title: 'Cobertura de cartera vigente sobre pasivos (aforo)',
      detail: `Cartera vigente ${mm(vigente)} vs. pasivos ${mm(liab.kpi.totalBalance)}: ${aforoVigente.toFixed(2)}x.`,
      recommendation: aforoVigente < 1.2 ? 'La cartera vigente apenas cubre (o no cubre) el fondeo; validar aforos contractuales de cada línea.' : 'Cobertura holgada contra el saldo institucional.',
    });
  }
  if (serviceCoverage !== null) {
    insights.push({
      severity: serviceCoverage < 1 ? 'critical' : serviceCoverage < 1.2 ? 'warning' : 'info',
      title: 'Cobranza vs. servicio de deuda',
      detail: `Cobranza mensual esperada ${mm(monthlyCollections)} (${collectionsSource}) vs. servicio de deuda promedio 12m ${mm(monthlyDebtService)}: ${serviceCoverage.toFixed(2)}x.`,
      recommendation: serviceCoverage < 1.2 ? 'La cobranza no alcanza con holgura para capital + intereses: depende de renovaciones o nueva deuda.' : 'La cobranza cubre el servicio de deuda proyectado.',
    });
  }
  const firstNegative = quarters.find(q => q.cumulative < 0);
  if (firstNegative) {
    insights.push({
      severity: 'warning',
      title: 'Brecha de liquidez',
      detail: `El flujo acumulado (cobranza − servicio de deuda) se vuelve negativo en ${firstNegative.label}: ${mm(firstNegative.cumulative)}.`,
      recommendation: 'Confirmar renovación de las líneas que vencen en ese periodo o fuentes alternas de liquidez.',
    });
  }
  if (termGapMonths !== null && termGapMonths > 6) {
    insights.push({
      severity: 'warning',
      title: 'Descalce de plazos',
      detail: `La cartera tiene plazo remanente ponderado ${termGapMonths.toFixed(1)} meses mayor que los pasivos.`,
      recommendation: 'El fondeo vence antes que la cartera: riesgo de refinanciamiento.',
    });
  }

  return {
    portfolioLabel: portfolio.focusLabel,
    asset: { saldo, vigente, vigentePct: saldo > 0 ? vigente / saldo : 0, waRate, waRemainingMonths: assetTerm, annualInterestIncome, monthlyCollections, collectionsSource },
    liability: { saldo: liab.kpi.totalBalance, waRate: liabRate, waRemainingMonths: liab.kpi.waRemainingMonths, annualInterest: liab.kpi.annualInterest, monthlyDebtService },
    spread, annualMargin, interestCoverage, serviceCoverage, aforoVigente, aforoTotal, termGapMonths,
    quarters, lenderSpreads, insights,
  };
}
