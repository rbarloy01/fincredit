// Loan identity when the tape has no loan ID column.
//
// Cross-cut analysis (migration matrix, vintages, exits/new loans, duplicates) needs the same key for the same loan in two
// tapes. Without an ID we build a FINGERPRINT from attributes that do not change during the life of a loan: borrower,
// original amount, origination and maturity dates, rate, product and installment (renta). Balance and DPD are never used —
// they move every month. The key is stable across cuts and carries a confidence so screens can say "matched by fingerprint".

import type { StandardLoan } from './loanTapeAnalytics';

export type IdentityConfidence = 'alta' | 'media' | 'baja' | 'ninguna';

export interface IdentityReport {
  method: 'reported' | 'inferred' | 'none';
  confidence: IdentityConfidence;
  coveragePct: number;       // share of loans that end up with a key
  uniquePct: number;         // share of keyed loans whose fingerprint is unique in the tape
  fields: string[];          // attributes the fingerprint used
  note: string;
}

export const INFERRED_ID_PREFIX = '~';
const MIN_UNIQUE_PCT = 0.8;

const clean = (v: unknown) => String(v ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const money = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) || v === 0 ? '' : String(Math.round(v * 100)));

function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}

interface Print { key: string; anchors: number; fields: string[] }

function printOf(r: StandardLoan): Print | null {
  const parts: Array<[string, string]> = [
    ['cliente', clean(r.client)],
    ['monto', money(r.amount)],
    ['otorgamiento', r.start_date || ''],
    ['vencimiento', r.end_date || ''],
    ['renta', money(r.installment)],
    ['tasa', typeof r.interest_rate === 'number' ? String(Math.round(r.interest_rate * 10000)) : ''],
    ['producto', clean(r.loan_type)],
  ];
  const present = parts.filter(([, v]) => v);
  const anchors = ['monto', 'otorgamiento', 'vencimiento', 'renta'].filter(f => present.some(([k]) => k === f)).length;
  const hasClient = present.some(([k]) => k === 'cliente');
  if (anchors < 2 && !(hasClient && anchors >= 1)) return null; // too little to tell loans apart
  return { key: present.map(([k, v]) => `${k}=${v}`).join('|'), anchors, fields: present.map(([k]) => k) };
}

export function inferLoanIds(rows: StandardLoan[]): { rows: StandardLoan[]; report: IdentityReport } {
  const loanRows = rows.filter(r => !r.source_granularity || r.source_granularity === 'loan');
  const isInferred = (r: StandardLoan) => r.id_source === 'inferred' || String(r.loan_id || '').startsWith(INFERRED_ID_PREFIX);
  const alreadyInferred = loanRows.filter(r => r.loan_id && isInferred(r)).length;
  if (alreadyInferred / loanRows.length >= 0.5) {
    return { rows, report: { method: 'inferred', confidence: 'media', coveragePct: loanRows.filter(r => r.loan_id).length / loanRows.length, uniquePct: new Set(loanRows.map(r => r.loan_id)).size / loanRows.length, fields: [], note: 'ID de crédito inferido en la carga (huella de cliente, monto, fechas y renta).' } };
  }
  const withId = loanRows.filter(r => r.loan_id && String(r.loan_id).trim()).length;
  if (!loanRows.length) return { rows, report: { method: 'none', confidence: 'ninguna', coveragePct: 0, uniquePct: 0, fields: [], note: 'Sin créditos a nivel préstamo.' } };
  if (withId / loanRows.length >= 0.9) {
    return { rows, report: { method: 'reported', confidence: 'alta', coveragePct: withId / loanRows.length, uniquePct: 1, fields: ['ID del crédito'], note: 'El archivo trae ID de crédito.' } };
  }

  const missing = loanRows.filter(r => !(r.loan_id && String(r.loan_id).trim()));
  const prints = new Map<StandardLoan, Print | null>(missing.map(r => [r, printOf(r)]));
  const counts = new Map<string, number>();
  for (const p of prints.values()) if (p) counts.set(p.key, (counts.get(p.key) || 0) + 1);

  // Client-level tapes (one row per acreditado): the borrower itself is the key.
  const clientCounts = new Map<string, number>();
  for (const r of missing) { const c = clean(r.client); if (c) clientCounts.set(c, (clientCounts.get(c) || 0) + 1); }
  const clientLevel = missing.length > 0 && [...clientCounts.values()].filter(v => v === 1).length / missing.length >= 0.95;

  const keyed = [...prints.values()].filter(Boolean) as Print[];
  const uniqueShare = keyed.length ? keyed.filter(p => counts.get(p.key) === 1).length / keyed.length : 0;
  const attrCoverage = keyed.length / missing.length;

  const useFingerprint = attrCoverage >= 0.6 && uniqueShare >= MIN_UNIQUE_PCT;
  if (!useFingerprint && !clientLevel) {
    return { rows, report: { method: 'none', confidence: 'ninguna', coveragePct: withId / loanRows.length, uniquePct: uniqueShare, fields: [], note: 'No hay atributos estables suficientes (monto, fechas, cliente) para identificar cada crédito entre cortes.' } };
  }

  const seen = new Map<string, number>();
  const assigned = new Map<StandardLoan, string>();
  for (const r of missing) {
    let base: string | null = null;
    if (useFingerprint) { const p = prints.get(r); if (p) base = p.key; }
    if (!base && clientLevel) { const c = clean(r.client); if (c) base = `cliente=${c}`; }
    if (!base) continue;
    const n = (seen.get(base) || 0) + 1; seen.set(base, n);
    assigned.set(r, INFERRED_ID_PREFIX + hash(n === 1 ? base : `${base}#${n}`));
  }
  const out = rows.map(r => {
    const id = assigned.get(r);
    return id ? { ...r, loan_id: id, id_source: 'inferred' as const } : r;
  });
  const fields = useFingerprint ? [...new Set(keyed.flatMap(p => p.fields))] : ['cliente'];
  const uniquePct = useFingerprint ? uniqueShare : 1;
  const confidence: IdentityConfidence = uniquePct >= 0.95 && (clientLevel || keyed.every(p => p.anchors >= 2)) ? 'alta' : 'media';
  return {
    rows: out,
    report: {
      method: 'inferred', confidence, coveragePct: (withId + assigned.size) / loanRows.length, uniquePct, fields,
      note: `Sin ID en el archivo: cada crédito se identifica por ${fields.join(' + ')}. ${Math.round(uniquePct * 100)}% de las huellas son únicas.`,
    },
  };
}

// Share of a loan set whose key was inferred rather than read from the file.
export function idBasis(rows: StandardLoan[]): 'reported' | 'inferred' | 'mixed' | 'none' {
  const keyed = rows.filter(r => r.loan_id);
  if (!keyed.length) return 'none';
  const inferred = keyed.filter(r => r.id_source === 'inferred' || String(r.loan_id).startsWith(INFERRED_ID_PREFIX)).length;
  return inferred === 0 ? 'reported' : inferred === keyed.length ? 'inferred' : 'mixed';
}

export const isRealLoanId = (r: StandardLoan) => !!(r.loan_id && String(r.loan_id).trim()) && r.id_source !== 'inferred' && !String(r.loan_id).startsWith(INFERRED_ID_PREFIX);

type FieldGetter = (r: StandardLoan) => string;
const FIELD_GETTERS: Record<string, FieldGetter> = {
  cliente: r => clean(r.client),
  monto: r => money(r.amount),
  otorgamiento: r => r.start_date || '',
  vencimiento: r => r.end_date || '',
  renta: r => money(r.installment),
  tasa: r => (typeof r.interest_rate === 'number' ? String(Math.round(r.interest_rate * 10000)) : ''),
  producto: r => clean(r.loan_type),
};
const CORE_FIELDS = ['cliente', 'monto', 'otorgamiento', 'vencimiento'];

// A field can be used to pair two cuts only if BOTH tapes carry it for most loans.
function commonFields(a: StandardLoan[], b: StandardLoan[]): string[] {
  const share = (rows: StandardLoan[], f: string) => (rows.length ? rows.filter(r => FIELD_GETTERS[f](r)).length / rows.length : 0);
  return Object.keys(FIELD_GETTERS).filter(f => share(a, f) >= 0.7 && share(b, f) >= 0.7);
}

function pairPass(prev: StandardLoan[], cur: StandardLoan[], fields: string[], pairs: Map<StandardLoan, StandardLoan>) {
  const keyOf = (r: StandardLoan) => fields.map(f => FIELD_GETTERS[f](r)).join('|');
  const group = (rows: StandardLoan[]) => { const m = new Map<string, StandardLoan[]>(); for (const r of rows) { const k = keyOf(r); const g = m.get(k); if (g) g.push(r); else m.set(k, [r]); } return m; };
  const gp = group(prev), gc = group(cur);
  for (const [k, ps] of gp) {
    const cs = gc.get(k);
    if (!cs || ps.length !== cs.length || ps.length > 3) continue; // ambiguous groups are not guessed
    ps.forEach((p, i) => pairs.set(p, cs[i]));
  }
}

export interface LoanPairing {
  pairs: Map<StandardLoan, StandardLoan>;   // previous row → current row
  byId: number;
  byFingerprint: number;
  fields: string[];                         // attributes the fingerprint pass used
}

// Pairs the same loan across two cuts. Real IDs first; the rest by fingerprint over the fields both tapes share
// (all of them, then the stable core), accepting only 1:1 pairs.
export function pairLoans(prev: StandardLoan[], cur: StandardLoan[]): LoanPairing {
  const pairs = new Map<StandardLoan, StandardLoan>();
  const curById = new Map<string, StandardLoan>();
  cur.forEach(r => { if (isRealLoanId(r)) curById.set(String(r.loan_id).trim(), r); });
  const usedCur = new Set<StandardLoan>();
  for (const p of prev) {
    if (!isRealLoanId(p)) continue;
    const c = curById.get(String(p.loan_id).trim());
    if (c && !usedCur.has(c)) { pairs.set(p, c); usedCur.add(c); }
  }
  const byId = pairs.size;
  const restPrev = () => prev.filter(r => !pairs.has(r) && !isRealLoanId(r));
  const restCur = () => cur.filter(r => !usedCur.has(r) && !isRealLoanId(r));
  let fields: string[] = [];
  if (restPrev().length && restCur().length) {
    const common = commonFields(restPrev(), restCur());
    const anchors = (fs: string[]) => fs.filter(f => ['monto', 'otorgamiento', 'vencimiento', 'renta'].includes(f)).length;
    const passes = [common, common.filter(f => CORE_FIELDS.includes(f))].filter(fs => anchors(fs) >= 2 || (fs.includes('cliente') && anchors(fs) >= 1));
    for (const fs of passes) {
      const before = pairs.size;
      const rp = restPrev(), rc = restCur();
      const local = new Map<StandardLoan, StandardLoan>();
      pairPass(rp, rc, fs, local);
      for (const [p, c] of local) { pairs.set(p, c); usedCur.add(c); }
      if (pairs.size > before && !fields.length) fields = fs;
    }
  }
  return { pairs, byId, byFingerprint: pairs.size - byId, fields };
}
