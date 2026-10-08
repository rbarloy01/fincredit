// Business rules for loan-tape portfolio analytics — the SINGLE source of truth.
//
// Why this exists: "Cartera vigente" used to be defined in four places with four different cut-offs
// (0 días / 0-29 / 0-30 / ...), so the same client showed 96.4% in one panel and 99.8% in another.
// Every screen, export and risk rule must classify through this module; tests lock it in.

import type { StandardLoan } from './loanTapeAnalytics';

export type QualityKey = 'vigente' | 'atrasada' | 'vencida' | 'sin_dato';

// Monitoring convention (matches the operational cartera-vencida reports):
//   vigente  = 0-30 DPD   |   atrasada = 31-89 DPD   |   vencida = 90 o más DPD
// (2026-10-08: el usuario fijó vencida = 90 días o más; Red Girasol sep-26 = 196 créditos, no 193.)
export const QUALITY_RULES = {
  vigenteMaxDpd: 30,
  atrasadaMaxDpd: 89,
} as const;

export const QUALITY_LABELS: Record<QualityKey, string> = {
  vigente: `Vigente (0-${QUALITY_RULES.vigenteMaxDpd} DPD)`,
  atrasada: `Atrasada (${QUALITY_RULES.vigenteMaxDpd + 1}-${QUALITY_RULES.atrasadaMaxDpd} DPD)`,
  vencida: `Vencida (${QUALITY_RULES.atrasadaMaxDpd + 1}+ DPD)`,
  sin_dato: 'Sin dato DPD',
};

export function classifyDpd(dpd: number | null | undefined): QualityKey {
  if (dpd === null || dpd === undefined || !Number.isFinite(dpd)) return 'sin_dato';
  if (dpd <= QUALITY_RULES.vigenteMaxDpd) return 'vigente';
  if (dpd <= QUALITY_RULES.atrasadaMaxDpd) return 'atrasada';
  return 'vencida';
}

// Text status inferred from DPD when the source has no status column.
export function loanStatusFromDpd(dpd: number | null): 'Vigente' | 'Atrasado' | 'Vencido' | null {
  const key = classifyDpd(dpd);
  if (key === 'sin_dato') return null;
  return key === 'vigente' ? 'Vigente' : key === 'atrasada' ? 'Atrasado' : 'Vencido';
}

// Fixed DPD aging buckets. "0 días" is a sub-set of vigente, never a competing definition of it.
export const DPD_BUCKET_DEFS = [
  { bucket: '0 dias', label: '0 días', min: 0, max: 0 },
  { bucket: '1-30', label: '1-30', min: 1, max: 30 },
  { bucket: '31-60', label: '31-60', min: 31, max: 60 },
  { bucket: '61-89', label: '61-89', min: 61, max: 89 },
  { bucket: '90-180', label: '90-180', min: 90, max: 180 },
  { bucket: '>180', label: '>180', min: 181, max: Infinity },
] as const;

// Alert thresholds (share of outstanding balance unless noted). Used by the risk score, insights and statuses.
export const RISK_THRESHOLDS = {
  vencidaWarn: 0.05,
  vencidaAlert: 0.1,
  atrasadaWarn: 0.2,
  clientConcentrationWarn: 0.1,
  clientConcentrationAlert: 0.2,
  top10Warn: 0.5,
  top10Alert: 0.75,
  hhiModerate: 0.15,
  hhiHigh: 0.25,
  waDpdWarn: 30,
  waDpdAlert: 60,
  missingDpdWarn: 0.02,
  missingDpdAlert: 0.1,
  largestLoanWarn: 0.1,
  maturing12mWarn: 0.6,
  maturityQuarterWarn: 0.3,
  dpdContinuityJump: 30,
} as const;

// ── Where "days past due" comes from ────────────────────────────────────────────────────────────────────────────────
// Many tapes (revolving lines, factoring, administered portfolios) carry an overdue AMOUNT or a status but no DPD column.
// A bare "mora > 0" flag used to be turned into 91 days (= vencida), which overstated risk. The single rule, in priority:
//   1. reported  – the tape's own days-past-due column.
//   2. derived   – amount in mora and a due date already passed: days = cut-off date − due date.
//   3. proxy     – amount in mora (or status vencido/mora) with no usable date: DPD_PROXY_DAYS, the LOWEST overdue bucket
//                  (atrasada). It is "at least late", never "vencida", because nothing proves 90+ days.
//   4. no mora flag at all → 0 when an amount column says 0, otherwise null (sin dato).
// Every loan keeps `dpd_source` so screens can say how much of the portfolio quality is measured vs estimated.
export type DpdSource = 'reported' | 'derived' | 'proxy';
export const DPD_PROXY_DAYS = QUALITY_RULES.vigenteMaxDpd + 1;

export function resolveDpd(input: {
  reported: number | null;
  overdueFlag: boolean | null;       // true: amount in mora / status vencido; false: amount column says 0; null: no information
  cutoff?: string | null;            // ISO date of the tape
  dueDate?: string | null;           // ISO date: maturity / due date
}): { dpd: number | null; source: DpdSource | null } {
  if (input.reported !== null && input.reported !== undefined) return { dpd: input.reported, source: 'reported' };
  if (input.overdueFlag === null || input.overdueFlag === undefined) return { dpd: null, source: null };
  if (!input.overdueFlag) return { dpd: 0, source: 'derived' };
  const cut = input.cutoff ? Date.parse(input.cutoff) : NaN;
  const due = input.dueDate ? Date.parse(input.dueDate) : NaN;
  if (Number.isFinite(cut) && Number.isFinite(due) && due < cut) {
    const days = Math.round((cut - due) / 86400000);
    if (days >= 1 && days <= 3650) return { dpd: days, source: 'derived' };
  }
  return { dpd: DPD_PROXY_DAYS, source: 'proxy' };
}

export const QUALITY_DEFINITION_LINES = [
  `Vigente: 0 a ${QUALITY_RULES.vigenteMaxDpd} días de atraso (incluye los créditos al corriente con 0 días).`,
  `Atrasada: ${QUALITY_RULES.vigenteMaxDpd + 1} a ${QUALITY_RULES.atrasadaMaxDpd} días.`,
  `Vencida: ${QUALITY_RULES.atrasadaMaxDpd + 1} días o más.`,
  `Mora sin días: si el archivo solo trae un monto en mora, los días se derivan de la fecha de vencimiento; sin fecha se asigna ${DPD_PROXY_DAYS} días (atrasada, el mínimo), nunca vencida.`,
  'Sin dato: el crédito no trae días de atraso; no se clasifica como vigente, atrasado ni vencido.',
  '“0 días” (al corriente) es un bucket de antigüedad: es una parte de Vigente, no otra definición de Vigente.',
];

export interface QualityReconciliation {
  bridge: Array<{ label: string; balance: number; pct: number }>;
  checks: Array<{ rule: string; ok: boolean; detail: string }>;
}

const bal = (r: StandardLoan) => r.outstanding_balance || 0;

// Bridge + integrity checks that must hold for any portfolio. They guard against a screen reporting a
// different "vigente" than another one (the 99.8% vs 96.4% case).
export function reconcileQuality(rows: StandardLoan[]): QualityReconciliation {
  const total = rows.reduce((a, r) => a + bal(r), 0);
  const sum = (pred: (r: StandardLoan) => boolean) => rows.filter(pred).reduce((a, r) => a + bal(r), 0);
  const pct = (v: number) => (total ? v / total : 0);
  const zero = sum(r => r.days_overdue === 0);
  const oneTo30 = sum(r => r.days_overdue !== null && r.days_overdue >= 1 && r.days_overdue <= QUALITY_RULES.vigenteMaxDpd);
  const vigente = sum(r => classifyDpd(r.days_overdue) === 'vigente');
  const atrasada = sum(r => classifyDpd(r.days_overdue) === 'atrasada');
  const vencida = sum(r => classifyDpd(r.days_overdue) === 'vencida');
  const sin = sum(r => classifyDpd(r.days_overdue) === 'sin_dato');

  const tol = Math.max(1, total * 1e-9);
  const checks = [
    { rule: 'Vigente + atrasada + vencida + sin dato = saldo total', ok: Math.abs(vigente + atrasada + vencida + sin - total) <= tol, detail: `${(vigente + atrasada + vencida + sin).toFixed(2)} vs ${total.toFixed(2)}` },
    { rule: `Vigente = bucket “0 días” + bucket “1-${QUALITY_RULES.vigenteMaxDpd}”`, ok: Math.abs(vigente - zero - oneTo30) <= tol, detail: `${vigente.toFixed(2)} vs ${(zero + oneTo30).toFixed(2)}` },
  ];
  return {
    bridge: [
      { label: 'Al corriente (0 días)', balance: zero, pct: pct(zero) },
      { label: `Con atraso 1-${QUALITY_RULES.vigenteMaxDpd} días`, balance: oneTo30, pct: pct(oneTo30) },
      { label: QUALITY_LABELS.vigente, balance: vigente, pct: pct(vigente) },
      { label: QUALITY_LABELS.atrasada, balance: atrasada, pct: pct(atrasada) },
      { label: QUALITY_LABELS.vencida, balance: vencida, pct: pct(vencida) },
      { label: QUALITY_LABELS.sin_dato, balance: sin, pct: pct(sin) },
    ],
    checks,
  };
}

// ── Validación cruzada del DPD contra la clasificación que trae el propio archivo ─────────────────────────────────────
// Caso Red Girasol (2026-10-08): se tomó "No. pagos vencidos" como días de atraso, así que 193 créditos que el mismo
// archivo marcaba "90+ días" salieron vigentes y la cartera vencida quedó en 0% (real 19.9%). El archivo traía la
// evidencia (bucket / estatus de cobranza): esta regla la usa para validar — y si hace falta corregir — la columna de DPD.
//   - Cada texto de bucket/estatus se traduce a un RANGO de días (no a una clase): "1-30" → [1,30], "90+" → [90,∞),
//     "al corriente" → [0,0], "castigado" → [90,∞). Los estatus genéricos son evidencia DÉBIL porque cada cliente los
//     define distinto (en Cedida/6K/Finware "Vencido" = cualquier atraso): "vencido" → [1,∞), "vigente" → [0,89].
//   - Evidencia fuerte (buckets numéricos) que no cuadra → bloquea / corrige la columna. Débil → solo advierte.
//   - Un crédito discrepa si su DPD cae fuera del rango ± DPD_CONSISTENCY.toleranceDays.
//   - Si discrepa más de maxMismatchPct del saldo (o de los créditos), la columna de DPD no es confiable.
export const DPD_CONSISTENCY = {
  toleranceDays: 5,
  maxMismatchPct: 0.05,
  minCompared: 10,
  minCoverage: 0.7,
} as const;

export type DpdRange = [number, number];

export function dpdRangeFromText(value: unknown): DpdRange | null {
  if (value === null || value === undefined) return null;
  const n = String(value).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
  if (!n) return null;
  const plus = n.match(/(\d+)\s*(\+|o mas|y mas|or more)|(mas de|mayor a|>)\s*(\d+)/);
  if (plus) {
    const lo = Number(plus[1] ?? plus[4]);
    return [plus[1] !== undefined ? lo : lo + 1, Infinity];
  }
  const range = n.match(/(\d+)\s*(?:-|–|a|to)\s*(\d+)/);
  if (range) {
    const lo = Number(range[1]); const hi = Number(range[2]);
    if (hi >= lo && hi <= 3650) return [lo, hi];
  }
  if (/\b(al corriente|corriente|current|0 dias|sin atraso|puntual)\b/.test(n)) return [0, 0];
  if (/(castig|irrecuper|incobrable|quebrant|write.?off|charged.?off)/.test(n)) return [QUALITY_RULES.atrasadaMaxDpd + 1, Infinity];
  if (/\bvencid[oa]s?\b/.test(n) && !/(por vencer|no vencid)/.test(n)) return [1, Infinity];
  if (/^vigente$/.test(n)) return [0, QUALITY_RULES.atrasadaMaxDpd];
  return null;
}

// Bucket numérico o "al corriente": evidencia fuerte. "Vigente" / "Vencido" / "Castigado" a secas: débil.
export function isStrongDpdText(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  const n = String(value).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return /\d/.test(n) || /\b(al corriente|corriente|current|sin atraso|puntual)\b/.test(n);
}

export interface DpdConsistency {
  compared: number;
  mismatches: number;
  mismatchPct: number;          // por número de créditos
  mismatchBalancePct: number;   // por saldo
  ok: boolean;
  examples: Array<{ text: string; dpd: number | null }>;
}

export function checkDpdConsistency(pairs: Array<{ range: DpdRange | null; dpd: number | null; balance: number }>): DpdConsistency {
  const tol = DPD_CONSISTENCY.toleranceDays;
  // Sin días de atraso no hay qué comparar (eso lo reporta la cobertura de DPD, no esta regla).
  const usable = pairs.filter(p => p.range !== null && p.dpd !== null);
  let mismatches = 0, mismatchBal = 0, totalBal = 0;
  const examples: DpdConsistency['examples'] = [];
  usable.forEach(p => {
    const [lo, hi] = p.range as DpdRange;
    const b = Math.max(0, p.balance || 0);
    totalBal += b;
    const inside = p.dpd !== null && p.dpd >= lo - tol && p.dpd <= hi + tol;
    if (!inside) {
      mismatches += 1; mismatchBal += b;
      if (examples.length < 5) examples.push({ text: hi === Infinity ? `${lo}+ días` : `${lo}-${hi} días`, dpd: p.dpd });
    }
  });
  const mismatchPct = usable.length ? mismatches / usable.length : 0;
  const mismatchBalancePct = totalBal > 0 ? mismatchBal / totalBal : mismatchPct;
  return {
    compared: usable.length, mismatches, mismatchPct, mismatchBalancePct,
    ok: usable.length < DPD_CONSISTENCY.minCompared || Math.max(mismatchPct, mismatchBalancePct) <= DPD_CONSISTENCY.maxMismatchPct,
    examples,
  };
}
