// Parte ligera (sin dependencias) de las métricas de cartera del loan tape: la usa getMetric de forma síncrona.
// El cálculo y la persistencia viven en tapePortfolio.ts.

export const TAPE_PORTFOLIO_KEY = 'finmonitor_tape_portfolio';

export interface TapePortfolioPoint {
  cutoff: string;          // YYYY-MM-DD
  fileName: string;
  loans: number;
  balance: number;         // cartera total viva
  vigente: number;
  atrasada: number;
  vencida: number;         // más de 90 días (portfolioRules)
  sinDato: number;
  pastDue30: number;       // atrasada + vencida (30+ días)
}

export type TapePortfolio = Record<string, TapePortfolioPoint>;

// Regla: el loan tape solo sustituye al estado financiero si trae días de atraso para la gran mayoría del saldo.
// Un tape sin DPD (14 de 27 clientes al 2026-10-12) daría cartera vencida 0% — falta de dato, no cartera sana.
export const TAPE_MIN_DPD_COVERAGE = 0.8;
// Regla: además, el saldo del loan tape debe cuadrar con la cartera del balance del mismo corte (±15%). Un tape incompleto
// (Afix dic-24→abr-25: 120M debajo del balance) o que incluye intereses/IVA (may-25 en adelante: +28-56M) daría un IMOR
// sobre una cartera equivocada; entonces manda el estado financiero.
export const TAPE_MAX_BALANCE_GAP = 0.15;
// Más de +60% sobre el balance no es error del tape: es cartera administrada FUERA de balance (plataforma de
// financiamiento colectivo como Red Girasol, cartera cedida o en fideicomiso). Ahí el tape es la cartera administrada.
export const TAPE_OFF_BALANCE_GAP = 0.6;
export const tapeIsOffBalanceManaged = (gap: number | null) => gap !== null && gap > TAPE_OFF_BALANCE_GAP;
export const tapeBalanceGap = (p: TapePortfolioPoint, statementPortfolio: number | null) =>
  statementPortfolio && statementPortfolio > 0 ? (p.balance - statementPortfolio) / statementPortfolio : null;
export const tapeDpdCoverage = (p: TapePortfolioPoint) => (p.balance > 0 ? 1 - p.sinDato / p.balance : 0);
export const isTapePointUsable = (p: TapePortfolioPoint | null | undefined): boolean => !!p && p.balance > 0 && tapeDpdCoverage(p) >= TAPE_MIN_DPD_COVERAGE;

// Caché en memoria por cliente (getMetric es síncrono).
const cache = new Map<string, TapePortfolio>();
export function setTapePortfolioCache(clientId: string, value: TapePortfolio) { cache.set(clientId, value || {}); }

export const tapePortfolioCached = (clientId: string) => cache.get(clientId);

// Corte del loan tape que corresponde al periodo del estado: misma fecha o mismo mes (cierres 30 vs 31, etc.).
export function tapePointForPeriod(clientId: string | undefined, periodDate: string | undefined): TapePortfolioPoint | null {
  if (!clientId || !periodDate) return null;
  const tp = cache.get(clientId);
  if (!tp) return null;
  if (tp[periodDate]) return tp[periodDate];
  const month = periodDate.slice(0, 7);
  const hit = Object.values(tp).filter(p => p.cutoff.slice(0, 7) === month).sort((a, b) => b.cutoff.localeCompare(a.cutoff))[0];
  return hit || null;
}

// Métricas que el loan tape sustituye en los indicadores (cartera total administrada y vencida 90+).
export function tapeMetric(clientId: string | undefined, periodDate: string | undefined, key: string): number | null {
  const p = tapePointForPeriod(clientId, periodDate);
  if (!isTapePointUsable(p)) return null;
  if (key === 'pastDuePortfolio') return p.vencida;
  if (key === 'managedPortfolio') return p.balance;
  if (key === 'pastDue30Portfolio') return p.pastDue30;
  return null;
}
