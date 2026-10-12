// Reconoce el estado de México de un texto libre del loan tape ("CDMX", "Edo. de México", "Veracruz de Ignacio de la
// Llave", "JAL", "Guadalajara, Jalisco") y agrega la cartera por estado para el mapa de calor.

import type { StandardLoan } from './loanTapeAnalytics';
import { classifyDpd } from './portfolioRules';

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

// id ISO 3166-2 → nombres y abreviaturas usuales (normalizados).
const ALIASES: Record<string, string[]> = {
  'MX-AGU': ['aguascalientes', 'ags', 'agu'],
  'MX-BCN': ['baja california', 'baja california norte', 'bc', 'bcn'],
  'MX-BCS': ['baja california sur', 'bcs'],
  'MX-CAM': ['campeche', 'camp', 'cam'],
  'MX-CHP': ['chiapas', 'chis', 'chp'],
  'MX-CHH': ['chihuahua', 'chih', 'chh'],
  'MX-CMX': ['ciudad de mexico', 'cdmx', 'cd de mexico', 'cd mexico', 'distrito federal', 'df', 'mexico df', 'mexico d f', 'cmx'],
  'MX-COA': ['coahuila', 'coahuila de zaragoza', 'coah', 'coa'],
  'MX-COL': ['colima', 'col'],
  'MX-DUR': ['durango', 'dgo', 'dur'],
  'MX-GUA': ['guanajuato', 'gto', 'gua'],
  'MX-GRO': ['guerrero', 'gro'],
  'MX-HID': ['hidalgo', 'hgo', 'hid'],
  'MX-JAL': ['jalisco', 'jal'],
  'MX-MEX': ['estado de mexico', 'edo de mexico', 'edo mexico', 'edomex', 'edo mex', 'mexico', 'mex', 'em'],
  'MX-MIC': ['michoacan', 'michoacan de ocampo', 'mich', 'mic'],
  'MX-MOR': ['morelos', 'mor'],
  'MX-NAY': ['nayarit', 'nay'],
  'MX-NLE': ['nuevo leon', 'nl', 'nle', 'n l'],
  'MX-OAX': ['oaxaca', 'oax'],
  'MX-PUE': ['puebla', 'pue'],
  'MX-QUE': ['queretaro', 'queretaro de arteaga', 'qro', 'que'],
  'MX-ROO': ['quintana roo', 'q roo', 'qroo', 'roo'],
  'MX-SLP': ['san luis potosi', 'slp'],
  'MX-SIN': ['sinaloa', 'sin'],
  'MX-SON': ['sonora', 'son'],
  'MX-TAB': ['tabasco', 'tab'],
  'MX-TAM': ['tamaulipas', 'tamps', 'tam'],
  'MX-TLA': ['tlaxcala', 'tlax', 'tla'],
  'MX-VER': ['veracruz', 'veracruz de ignacio de la llave', 'veracruz llave', 'ver'],
  'MX-YUC': ['yucatan', 'yuc'],
  'MX-ZAC': ['zacatecas', 'zac'],
};

const EXACT = new Map<string, string>();
Object.entries(ALIASES).forEach(([id, list]) => list.forEach(a => EXACT.set(a, id)));
// Para textos compuestos ("Guadalajara, Jalisco"): nombres completos, del más largo al más corto (así "baja california
// sur" gana a "baja california", y "estado de mexico" / "ciudad de mexico" ganan a "mexico").
const LONG_NAMES = Object.entries(ALIASES).flatMap(([id, list]) => list.filter(a => a.length >= 5).map(a => ({ id, a }))).sort((x, y) => y.a.length - x.a.length);

export function mexicanStateId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const n = norm(String(value));
  if (!n) return null;
  if (EXACT.has(n)) return EXACT.get(n)!;
  const stripped = n.replace(/^(estado de |edo de |edo )/, '');
  if (EXACT.has(stripped)) return EXACT.get(stripped)!;
  const padded = ` ${n} `;
  const hit = LONG_NAMES.find(({ a }) => padded.includes(` ${a} `));
  return hit ? hit.id : null;
}

export interface StateAggregate { id: string; balance: number; count: number; vencida: number; pct: number; venPct: number }

export function aggregateByState(rows: StandardLoan[]) {
  const by = new Map<string, StateAggregate>();
  const unmatched = new Map<string, { balance: number; count: number }>();
  let total = 0, withState = 0;
  rows.forEach(r => {
    const bal = typeof r.outstanding_balance === 'number' && Number.isFinite(r.outstanding_balance) ? r.outstanding_balance : 0;
    total += bal;
    const id = mexicanStateId(r.state);
    if (!id) {
      const key = r.state ? String(r.state).trim() : 'Sin estado';
      const u = unmatched.get(key) || { balance: 0, count: 0 };
      unmatched.set(key, { balance: u.balance + bal, count: u.count + 1 });
      return;
    }
    withState += bal;
    const a = by.get(id) || { id, balance: 0, count: 0, vencida: 0, pct: 0, venPct: 0 };
    a.balance += bal; a.count += 1;
    if (classifyDpd(r.days_overdue) === 'vencida') a.vencida += bal;
    by.set(id, a);
  });
  by.forEach(a => { a.pct = total ? a.balance / total : 0; a.venPct = a.balance ? a.vencida / a.balance : 0; });
  return {
    states: by,
    total,
    coverage: total ? withState / total : 0,
    unmatched: [...unmatched.entries()].map(([name, v]) => ({ name, ...v })).sort((x, y) => y.balance - x.balance),
  };
}
