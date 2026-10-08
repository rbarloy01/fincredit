// Economic-group concentration for loan tapes.
// A "client" in a tape is a legal entity, but credit risk concentrates in the GROUP behind it (same family, same holding,
// same brand). Without a group/RFC column in the tape, groups are inferred from the names; an analyst can split any
// inferred member out (override) and the override always wins.

import type { StandardLoan } from './loanTapeAnalytics';

export interface GroupMember { name: string; balance: number; loans: number }
export interface EconomicGroup {
  name: string;
  members: GroupMember[];
  balance: number;
  pct: number;
  loans: number;
  inferred: boolean;          // true when it merges more than one name by inference
  confidence: 'alta' | 'media';
  reason: string;
}

const LEGAL = /\b(s\.? ?a\.? ?p\.? ?i\.?( de c\.? ?v\.?)?|s\.? ?a\.? ?b\.?( de c\.? ?v\.?)?|s\.? ?a\.? de c\.? ?v\.?|s\.? de r\.? ?l\.?( de c\.? ?v\.?)?|s\.? ?a\.?|s\.? ?c\.?|a\.? ?c\.?|sofom|e\.? ?n\.? ?r\.?|enr|s\.? ?r\.? ?l\.?|sapi|spr|de c\.? ?v\.?)\b/g;
const STOP = new Set(['de', 'del', 'la', 'las', 'el', 'los', 'y', 'e', 'en', 'para', 'por', 'al', 'sa', 'cv', 'sapi', 'sofom', 'rl', 'sc', 'ac', 'sab']);
// Words that describe a line of business, not a family/holding: sharing them says nothing.
const GENERIC = new Set([
  'grupo', 'comercializadora', 'comercial', 'servicio', 'servicios', 'construcciones', 'construccion', 'constructora', 'transportes', 'transporte',
  'inmobiliaria', 'industrial', 'industrias', 'mexico', 'mexicana', 'mexicano', 'nacional', 'internacional', 'agricola', 'agroindustrial', 'distribuidora',
  'distribuciones', 'logistica', 'consultoria', 'tecnologia', 'soluciones', 'importadora', 'exportadora', 'refacciones', 'materiales', 'maquinaria',
  'equipos', 'equipo', 'proyectos', 'desarrollos', 'desarrolladora', 'operadora', 'administradora', 'promotora', 'corporativo', 'empresa', 'compania',
  'ganadera', 'transportista', 'alimentos', 'productos', 'sistemas', 'energia', 'medica', 'medico', 'hospital', 'clinica', 'restaurante', 'hotel',
]);

// Places and saints' names appear in unrelated companies ("… de San Luis"): they never prove a common owner.
const GEO = new Set(['san', 'santa', 'luis', 'jose', 'maria', 'juan', 'pedro', 'nuevo', 'nueva', 'leon', 'norte', 'sur', 'centro', 'occidente', 'oriente', 'bajio', 'pacifico', 'golfo', 'potosi', 'queretaro', 'jalisco', 'monterrey', 'guadalajara', 'puebla', 'veracruz', 'yucatan', 'chihuahua', 'sonora', 'sinaloa', 'coahuila', 'tamaulipas', 'durango', 'zacatecas', 'guanajuato', 'morelos', 'hidalgo', 'oaxaca', 'chiapas', 'tabasco', 'campeche', 'colima', 'nayarit', 'tlaxcala', 'aguascalientes', 'cancun', 'tijuana', 'mexicali', 'toluca', 'cdmx', 'cuernavaca', 'saltillo', 'torreon', 'merida', 'mazatlan', 'culiacan', 'hermosillo', 'obregon', 'laredo', 'reynosa', 'matamoros', 'celaya', 'irapuato', 'leon', 'silao', 'morelia', 'michoacan', 'baja', 'california', 'quintana', 'roo', 'estado']);

const strip = (v: string) => v.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

export function significantTokens(name: string): string[] {
  const cleaned = strip(name).replace(LEGAL, ' ').replace(/[^a-z0-9ñ ]+/g, ' ');
  const all = cleaned.split(/\s+/)
    .filter(t => t.length >= 3 && !STOP.has(t))
    .map(t => (t.endsWith('es') && t.length > 5 ? t.slice(0, -2) : t.endsWith('s') && t.length > 4 ? t.slice(0, -1) : t));
  const withoutGeo = all.filter(t => !GEO.has(t));
  return withoutGeo.length ? withoutGeo : all;
}

class UnionFind {
  parent: number[];
  constructor(n: number) { this.parent = Array.from({ length: n }, (_, i) => i); }
  find(x: number): number { while (this.parent[x] !== x) { this.parent[x] = this.parent[this.parent[x]]; x = this.parent[x]; } return x; }
  union(a: number, b: number) { const ra = this.find(a); const rb = this.find(b); if (ra !== rb) this.parent[rb] = ra; }
}

export type GroupOverrides = Record<string, string>; // clientName -> group name ('' or its own name = stand-alone)

export function buildEconomicGroups(rows: StandardLoan[], overrides: GroupOverrides = {}): EconomicGroup[] {
  const total = rows.reduce((a, r) => a + (r.outstanding_balance || 0), 0);
  const byClient = new Map<string, { balance: number; loans: number }>();
  for (const r of rows) {
    const name = (r.client || '').trim();
    if (!name) continue;
    const cur = byClient.get(name) || { balance: 0, loans: 0 };
    cur.balance += r.outstanding_balance || 0; cur.loans += 1;
    byClient.set(name, cur);
  }
  const names = [...byClient.keys()];
  const tokens = names.map(n => significantTokens(n));
  const freq = new Map<string, number>();
  tokens.forEach(ts => new Set(ts).forEach(t => freq.set(t, (freq.get(t) || 0) + 1)));
  const rareLimit = Math.max(2, Math.ceil(names.length * 0.04));
  const distinctive = (t: string) => !GENERIC.has(t) && !/^\d+$/.test(t) && (freq.get(t) || 0) <= rareLimit;

  const uf = new UnionFind(names.length);
  const reason = new Map<number, string>();
  const isPersonLike = (ts: string[]) => ts.length >= 3 && ts.every(t => !GENERIC.has(t));
  for (let i = 0; i < names.length; i++) {
    if (overrides[names[i]] !== undefined) continue;
    for (let j = i + 1; j < names.length; j++) {
      if (overrides[names[j]] !== undefined) continue;
      const a = tokens[i]; const b = tokens[j];
      if (!a.length || !b.length) continue;
      const setA = new Set(a); const setB = new Set(b);
      const shared = [...setA].filter(t => setB.has(t));
      if (!shared.length) continue;
      const sameSet = setA.size === setB.size && shared.length === setA.size;
      const sharedDistinctive = shared.filter(distinctive);
      const firstSame = a[0] === b[0] && distinctive(a[0]);
      // (1) same words in any order (typical for individuals: "TREVIÑO DELGADO PATRICIA")
      if (sameSet) { uf.union(i, j); reason.set(uf.find(i), 'mismo nombre con distinto orden o forma legal'); continue; }
      // (2) share a brand/family token that is the lead word of both, plus another shared word or a person-like name
      if (firstSame && shared.length >= 2) { uf.union(i, j); reason.set(uf.find(i), `comparten "${a[0]}" y otras palabras`); continue; }
      // (3) person names sharing two surnames
      if (isPersonLike(a) && isPersonLike(b) && shared.length >= 2) { uf.union(i, j); reason.set(uf.find(i), 'comparten apellidos'); continue; }
      // (4) a rare distinctive token shared as the lead word of both names ("ROYAL MEXICANO …" / "ROYAL …")
      if (firstSame && sharedDistinctive.length >= 1 && (a.length === 1 || b.length === 1 || sharedDistinctive.length >= 2)) { uf.union(i, j); reason.set(uf.find(i), `comparten la marca "${a[0]}"`); }
    }
  }

  const groups = new Map<string, { names: string[]; reason?: string }>();
  names.forEach((n, i) => {
    const forced = overrides[n];
    const key = forced !== undefined && forced !== '' ? `manual:${forced}` : forced === '' ? `solo:${n}` : `auto:${uf.find(i)}`;
    const g = groups.get(key) || { names: [], reason: undefined };
    g.names.push(n);
    if (key.startsWith('auto:') && reason.get(uf.find(i))) g.reason = reason.get(uf.find(i));
    groups.set(key, g);
  });

  return [...groups.entries()].map(([key, g]) => {
    const members = g.names.map(n => ({ name: n, ...byClient.get(n)! })).sort((a, b) => b.balance - a.balance);
    const balance = members.reduce((a, m) => a + m.balance, 0);
    const manual = key.startsWith('manual:');
    return {
      name: manual ? key.slice(7) : members[0].name,
      members, balance, pct: total ? balance / total : 0,
      loans: members.reduce((a, m) => a + m.loans, 0),
      inferred: members.length > 1,
      confidence: manual || g.reason?.startsWith('mismo') || g.reason === 'comparten apellidos' ? 'alta' as const : 'media' as const,
      reason: manual ? 'asignado manualmente' : g.reason || '',
    };
  }).sort((a, b) => b.balance - a.balance);
}
