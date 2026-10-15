// Tasa de la cartera del loan tape con TIIE. Reglas (por crédito):
//
//  R1. Si el crédito trae base de tasa (columna "Tasa Base" / "Tipo de Tasa" / "Referencia"):
//        "TIIE…" / "Variable" / "Flotante"  → la tasa reportada es SOBRETASA: tasa = TIIE del mes del corte + sobretasa.
//        "Fija"                             → la tasa reportada es la tasa total.
//      (Afix: cada crédito dice "TIIE" con sobretasa 13, o es fijo con 24%.)
//  R2. Sin base, si la columna de tasa se llama "sobretasa / sobre tasa / spread / margen" (COFINE, Capital X), se toma
//      como sobretasa sobre TIIE 28 y se marca como SUPUESTO.
//  R3. Si no, la tasa reportada es la tasa total.
//  Tasa efectiva ponderada = Σ saldo × (tasa + TIIE·[variable]) ÷ Σ saldo = tasa reportada ponderada + TIIE × % variable.

import type { StandardLoan, MappingNote } from './loanTapeAnalytics';

export type RateBasis = 'fija' | 'tiie' | 'tiie_supuesto';

const norm = (s: unknown) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

export function rateIsSpreadColumn(mappingReport: Array<Pick<MappingNote, 'target_term' | 'source_header'>> | null | undefined): boolean {
  const h = (mappingReport || []).find(m => m.target_term === 'interest_rate')?.source_header;
  return !!h && /(sobre ?tasa|spread|margen sobre|margin)/.test(norm(h));
}

export function loanRateBasis(row: Pick<StandardLoan, 'rate_base'>, spreadColumn: boolean): RateBasis {
  const b = norm(row.rate_base);
  if (b) {
    if (/tiie|variable|flotante|referencia|float/.test(b)) return 'tiie';
    if (/fij|fixed/.test(b)) return 'fija';
  }
  return spreadColumn ? 'tiie_supuesto' : 'fija';
}

export interface RateProfile {
  waReported: number | null;     // tasa reportada ponderada (sobretasa en los créditos variables)
  variableShare: number;         // % del saldo con tasa TIIE + sobretasa
  assumedShare: number;          // de ese %, cuánto es supuesto (R2: sin columna de base)
  ratedBalance: number;
}

// Sobre los créditos con tasa (el llamador decide el universo: p. ej. cartera vigente).
export function rateProfile(rows: StandardLoan[], spreadColumn: boolean): RateProfile {
  const bal = (r: StandardLoan) => (typeof r.outstanding_balance === 'number' && Number.isFinite(r.outstanding_balance) ? r.outstanding_balance : 0);
  const rated = rows.filter(r => typeof r.interest_rate === 'number' && r.interest_rate > 0 && r.interest_rate < 3);
  const total = rated.reduce((a, r) => a + bal(r), 0);
  if (!total) return { waReported: null, variableShare: 0, assumedShare: 0, ratedBalance: 0 };
  let wa = 0, varBal = 0, assumedBal = 0;
  rated.forEach(r => {
    const b = bal(r); wa += b * (r.interest_rate as number);
    const basis = loanRateBasis(r, spreadColumn);
    if (basis !== 'fija') varBal += b;
    if (basis === 'tiie_supuesto') assumedBal += b;
  });
  return { waReported: wa / total, variableShare: varBal / total, assumedShare: assumedBal / total, ratedBalance: total };
}

// Tasa efectiva ponderada con la TIIE (% anual) del mes del corte. Si hay cartera variable y no hay TIIE → null.
export function effectiveWaRate(p: Pick<RateProfile, 'waReported' | 'variableShare'>, tiiePct: number | null | undefined): number | null {
  if (p.waReported === null) return null;
  if (!p.variableShare) return p.waReported;
  if (tiiePct === null || tiiePct === undefined || !Number.isFinite(tiiePct)) return null;
  return p.waReported + (tiiePct / 100) * p.variableShare;
}
