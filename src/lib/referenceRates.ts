// Tasas variables (TIIE + sobretasa) para Pasivos Institucionales.
//
// Regla: una línea con tasa "TIIE + sobretasa" NO es tasa fija. Su tasa de cada mes = TIIE de ese mes (Banxico, al cierre
// del mes) + sobretasa, acotada por piso/techo si el contrato los trae. Se lee del texto de la tasa del pasivo:
//   "TIIE + 350 pb" · "TIIE 28 + 3.5%" · "TIIE de fondeo + 4 pp, piso 12%" · "TIIE91 + 2.75 puntos techo 18%"
// Sin fórmula reconocible, la línea usa su tasa capturada (fija) o la implícita de los estados.

export type ReferenceSeries = 'tiie28' | 'tiie91' | 'tiie_fondeo';
export interface RateFormula { series: ReferenceSeries; spread: number; floor: number | null; cap: number | null; text: string }   // decimales (0.035 = 3.5 pp)

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const num = (s: string) => Number(s.replace(',', '.'));

export function parseRateFormula(text: string | null | undefined): RateFormula | null {
  if (!text) return null;
  const n = norm(text);
  if (!/tiie/.test(n)) return null;
  const series: ReferenceSeries = /fondeo/.test(n) ? 'tiie_fondeo' : /\b91\b|tiie ?91/.test(n) ? 'tiie91' : 'tiie28';
  // Sobretasa: "+ 350 pb" (puntos base) · "+ 3.5%" / "+ 3.5 pp" / "+ 3.5 puntos"
  const bp = n.match(/\+\s*(\d+(?:[.,]\d+)?)\s*(pb|bps|puntos base|p\.b\.)/);
  const pp = n.match(/\+\s*(\d+(?:[.,]\d+)?)\s*(%|pp|puntos porcentuales|puntos|pts)?/);
  const spread = bp ? num(bp[1]) / 10000 : pp ? num(pp[1]) / 100 : 0;
  const floorM = n.match(/(piso|minim[oa]|floor)[^0-9]*(\d+(?:[.,]\d+)?)/);
  const capM = n.match(/(techo|maxim[oa]|cap)[^0-9]*(\d+(?:[.,]\d+)?)/);
  return { series, spread, floor: floorM ? num(floorM[2]) / 100 : null, cap: capM ? num(capM[2]) / 100 : null, text };
}

// Tasa del mes: TIIE (%) del mes + sobretasa, con piso/techo. TIIE en % anual (Banxico) → decimal.
export function rateForMonth(f: RateFormula, tiiePct: number | null | undefined): number | null {
  if (tiiePct === null || tiiePct === undefined || !Number.isFinite(tiiePct)) return null;
  let r = tiiePct / 100 + f.spread;
  if (f.floor !== null && r < f.floor) r = f.floor;
  if (f.cap !== null && r > f.cap) r = f.cap;
  return r;
}

export type MonthlySeries = Record<string, number>;   // 'YYYY-MM' → % anual al cierre del mes
