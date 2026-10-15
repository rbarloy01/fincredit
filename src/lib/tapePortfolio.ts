// Métricas de cartera tomadas DIRECTO del loan tape para los indicadores financieros.
//
// Regla (2026-10-12, el usuario): la cartera vencida y la cartera total de los indicadores salen del loan tape del
// mismo corte cuando existe; el estado financiero queda como respaldo. Clasificación con portfolioRules (vigente 0-30,
// atrasada 31-89, vencida 90+), solo créditos vivos (activeRows). Se guarda un resumen pequeño por corte en
// client_settings para no cargar los loan tapes completos al calcular indicadores (getMetric es síncrono).

import { db, type LoanTape_DB } from '../db/index';
import { activeRows, type StandardLoan } from './loanTapeAnalytics';
import { classifyDpd } from './portfolioRules';
import { TAPE_PORTFOLIO_KEY, setTapePortfolioCache, tapePortfolioCached, type TapePortfolio, type TapePortfolioPoint } from './tapePortfolioCache';

export { TAPE_PORTFOLIO_KEY, tapeMetric, tapePointForPeriod, type TapePortfolio, type TapePortfolioPoint } from './tapePortfolioCache';

const bal = (r: StandardLoan) => (typeof r.outstanding_balance === 'number' && Number.isFinite(r.outstanding_balance) ? r.outstanding_balance : 0);

export function tapePortfolioPoints(rows: StandardLoan[], fileName: string): TapePortfolioPoint[] {
  const byCutoff = new Map<string, StandardLoan[]>();
  activeRows(rows).forEach(r => {
    if (!r.file_date) return;
    byCutoff.set(r.file_date, [...(byCutoff.get(r.file_date) || []), r]);
  });
  return [...byCutoff.entries()].map(([cutoff, list]) => {
    const sum = (k: ReturnType<typeof classifyDpd>) => list.filter(r => classifyDpd(r.days_overdue) === k).reduce((a, r) => a + bal(r), 0);
    const atrasada = sum('atrasada'), vencida = sum('vencida');
    // Tasa activa: ponderada por saldo de la cartera vigente con tasa (0.12 = 12%).
    const rated = list.filter(r => classifyDpd(r.days_overdue) === 'vigente' && typeof r.interest_rate === 'number' && r.interest_rate > 0 && r.interest_rate < 3);
    const ratedBal = rated.reduce((a, r) => a + bal(r), 0);
    const waRate = ratedBal > 0 ? rated.reduce((a, r) => a + bal(r) * (r.interest_rate as number), 0) / ratedBal : null;
    return {
      waRate,
      cutoff, fileName, loans: list.length,
      balance: list.reduce((a, r) => a + bal(r), 0),
      vigente: sum('vigente'), atrasada, vencida, sinDato: sum('sin_dato'), pastDue30: atrasada + vencida,
    };
  });
}

export function tapePortfolioFromTapes(tapes: LoanTape_DB[]): TapePortfolio {
  const out: TapePortfolio = {};
  tapes.forEach(t => {
    const rows = t.extractedData?._standardized;
    if (!Array.isArray(rows) || !rows.length) return;
    tapePortfolioPoints(rows, t.fileName || t.name || '').forEach(p => { out[p.cutoff] = p; });
  });
  return out;
}

export async function loadTapePortfolio(clientId: string): Promise<TapePortfolio> {
  const v = await db.getClientSetting<TapePortfolio>(clientId, TAPE_PORTFOLIO_KEY, {}).catch(() => ({} as TapePortfolio));
  setTapePortfolioCache(clientId, v);
  return v;
}

export async function loadTapePortfolioForClients(clientIds: string[]): Promise<void> {
  if (!clientIds.length) return;
  const all = await db.getClientSettingsForClients<TapePortfolio>(clientIds, TAPE_PORTFOLIO_KEY).catch(() => ({} as Record<string, TapePortfolio>));
  clientIds.forEach(id => setTapePortfolioCache(id, all[id] || {}));
}

// Se llama cuando el panel de loan tapes tiene los tapes completos (al cargar o subir): recalcula y guarda solo si cambió.
export async function syncTapePortfolio(clientId: string, tapes: LoanTape_DB[]): Promise<void> {
  const fresh = tapePortfolioFromTapes(tapes);
  const current = tapePortfolioCached(clientId);
  setTapePortfolioCache(clientId, fresh);
  if (JSON.stringify(current || {}) === JSON.stringify(fresh)) return;
  await db.setClientSetting(clientId, TAPE_PORTFOLIO_KEY, fresh).catch(() => undefined);
}

