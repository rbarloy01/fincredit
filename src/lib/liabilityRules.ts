// Reglas de negocio para entender CUALQUIER desglose de pasivos (segregación del pasivo, relación de fondeadores,
// balance con detalle), venga de un PDF, de un Excel o de la salida de cualquier IA. Determinístico: no depende de IA.
//
//   1. Renglones "cuenta + importe(s)". Varias columnas de importe = varios cortes.
//   2. Unidad: "miles de pesos" ×1,000 · "millones" ×1,000,000 · si no, pesos.
//   3. Corte: del texto ("Al 31 de agosto de 2026"), del encabezado de columna ("31-ago-26") o del archivo (260831, Agosto2026).
//   4. Jerarquía POR SUMAS: un renglón es grupo si los renglones siguientes suman exactamente su importe (no depende de
//      sangrías ni del formato). "Total pasivo" es el total, nunca un grupo.
//   5. Clasificación por concepto: FONDEO con costo (préstamos, bancos, otros organismos, líneas, bursátiles, certificados,
//      obligaciones, pagarés, mutuos, inversionistas) · IMPUESTOS · OPERATIVO (proveedores, acreedores diversos,
//      provisiones) · EMPLEADOS · OTRO. El grupo hereda su clase a sus detalles.
//   6. Fondeadores = detalles de un grupo de FONDEO que no son "De corto/largo plazo" (esos fijan el plazo). Si el grupo
//      no trae nombres, el fondeador es el propio renglón.
//   7. Cuadres: cada grupo = suma de su detalle (por construcción) y Total pasivo = suma de los grupos de primer nivel.
// Solo el FONDEO entra a Pasivos Institucionales; lo demás se reporta como composición del pasivo.

export type LiabilityKind = 'fondeo' | 'impuestos' | 'operativo' | 'empleados' | 'otro' | 'total';
export type Term = 'corto' | 'largo' | '';

export interface RawLine { label: string; values: Array<number | null> }
export interface ParsedLine { label: string; value: number; kind: LiabilityKind; term: Term; level: number; parent: string | null; isGroup: boolean; isLender: boolean }
export interface ParsedPeriod {
  cutoff: string | null;
  lines: ParsedLine[];
  funding: Array<{ lender: string; term: Term; balance: number }>;
  composition: Record<Exclude<LiabilityKind, 'total'>, number>;
  totalLiabilities: number | null;
  checks: Array<{ ok: boolean; detail: string }>;
}
export interface LiabilityParseResult { recognized: boolean; unit: number; unitLabel: string; periods: ParsedPeriod[]; reasons: string[] }

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

export const LIABILITY_KIND_RULES: Array<{ kind: LiabilityKind; re: RegExp }> = [
  { kind: 'total', re: /^(total|suma)( del| de)? pasivo(s)?( total(es)?)?$|^pasivo total$|^total de pasivos$/ },
  { kind: 'impuestos', re: /impuesto|contribucion|isr|iva|retenid|retencion|imss|infonavit|sar|seguridad social|ptu|participacion de los trabajadores/ },
  { kind: 'empleados', re: /beneficios? (a|de) (los )?empleados|beneficios directos|beneficios por terminacion|fondo de ahorro|prima de antiguedad|obligaciones laborales|sueldos por pagar|nomina por pagar/ },
  { kind: 'fondeo', re: /prestamo|bancari|banco|otros organismos|organismos|linea de credito|credito simple|credito revolvente|pasivos bursatiles|certificados bursatiles|bursatil|obligaciones (subordinadas|emitidas|en circulacion)|pagare|mutuo|inversionista|fondeo|fondeador|financiamiento|emision de deuda|deuda/ },
  { kind: 'operativo', re: /proveedor|acreedores diversos|otras cuentas por pagar|cuentas por pagar|provision|acreedor|deposito(s)? en garantia|cobros anticipados|creditos diferidos|pasivo por arrendamiento|dividendos por pagar|anticipo/ },
];

export function classifyLiability(label: string): LiabilityKind | null {
  const n = norm(label);
  const hit = LIABILITY_KIND_RULES.find(r => r.re.test(n));
  return hit ? hit.kind : null;
}

const termOf = (label: string): Term => {
  const n = norm(label);
  if (/corto plazo|^de corto|circulante|corriente/.test(n)) return 'corto';
  if (/largo plazo|^de largo|no circulante/.test(n)) return 'largo';
  return '';
};
const isTermBucket = (label: string) => /^(de )?(corto|largo) plazo$|^(pasivo )?(a )?(corto|largo) plazo$/.test(norm(label));

// ── Números, unidad y corte ─────────────────────────────────────────────────────────────────────────────────────────
const NUM_RE = /\(?-?\$?\s?\d{1,3}(?:,\d{3})+(?:\.\d+)?\)?|\(?-?\$?\s?\d+(?:\.\d+)?\)?/g;
export function parseAmount(token: string): number | null {
  const t = token.trim();
  if (!t || t === '-' || t === '—') return 0;
  const neg = /^\(.*\)$/.test(t) || t.startsWith('-');
  const n = Number(t.replace(/[()$,\s-]/g, ''));
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}

export function detectUnit(text: string): { unit: number; label: string } {
  const n = norm(text);
  if (/millones de pesos|en millones|mdp\b/.test(n)) return { unit: 1e6, label: 'millones de pesos' };
  if (/miles de pesos|en miles|cifras en miles|\bmiles\b/.test(n)) return { unit: 1000, label: 'miles de pesos' };
  return { unit: 1, label: 'pesos' };
}

const MONTHS: Record<string, number> = { ene: 1, enero: 1, feb: 2, febrero: 2, mar: 3, marzo: 3, abr: 4, abril: 4, may: 5, mayo: 5, jun: 6, junio: 6, jul: 7, julio: 7, ago: 8, agosto: 8, sep: 9, sept: 9, septiembre: 9, oct: 10, octubre: 10, nov: 11, noviembre: 11, dic: 12, diciembre: 12, jan: 1, apr: 4, aug: 8, dec: 12 };
const endOfMonth = (y: number, m: number) => `${y}-${String(m).padStart(2, '0')}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;

export function detectCutoffs(text: string, fileName = ''): string[] {
  const n = norm(text);
  const out: string[] = [];
  // "31-ago-26" / "31 ago 2026" (encabezados de columna, pueden ser varios)
  for (const m of n.matchAll(/\b(\d{1,2}) (ene|feb|mar|abr|may|jun|jul|ago|sep|sept|oct|nov|dic|jan|apr|aug|dec)[a-z]* (\d{2,4})\b/g)) {
    const y = Number(m[3].length === 2 ? `20${m[3]}` : m[3]); const mo = MONTHS[m[2]];
    if (mo) out.push(endOfMonth(y, mo));
  }
  if (!out.length) {
    const m = n.match(/al (\d{1,2}) de ([a-z]+) de (\d{4})/);
    if (m && MONTHS[m[2]]) out.push(endOfMonth(Number(m[3]), MONTHS[m[2]]));
  }
  if (!out.length) {
    const f = norm(fileName);
    const m1 = f.match(/\b(\d{2})(\d{2})(\d{2})\b/);
    const m2 = f.match(/(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre) ?(\d{4})/);
    if (m2) out.push(endOfMonth(Number(m2[2]), MONTHS[m2[1]]));
    else if (m1 && Number(m1[2]) >= 1 && Number(m1[2]) <= 12) out.push(endOfMonth(2000 + Number(m1[1]), Number(m1[2])));
  }
  return [...new Set(out)];
}

// Texto (PDF o salida de IA) → renglones "cuenta + importes".
export function linesFromText(text: string): RawLine[] {
  const DATE_LINE = /\b\d{1,2}[-/ ](ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic|jan|apr|aug|dec)[a-z]*[-/ ]\d{2,4}\b|\bde (enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre) de\b|cifras en|moneda:|p[aá]gina \d/i;
  return text.split(/\r?\n/).map(l => l.replace(/\s+$/, '')).filter(Boolean).flatMap(line => {
    if (DATE_LINE.test(line)) return [];   // encabezados ("CUENTA 31-ago-26", "Al 31 de julio de 2026 | Cifras en miles")
    const tokens = [...line.matchAll(NUM_RE)].map(m => ({ t: m[0], i: m.index! }));
    if (!tokens.length) return [];
    // Importes = números al final del renglón (todo lo que sigue a la etiqueta).
    const firstNum = tokens.findIndex(t => /\d{1,3}(,\d{3})|\d{4,}|^\(|^0$|^\d+$/.test(t.t.trim()) && line.slice(0, t.i).replace(/[\s$]/g, '').length > 0);
    if (firstNum < 0) return [];
    const label = line.slice(0, tokens[firstNum].i).replace(/[$:\s]+$/, '').trim();
    if (!label || !/[a-zA-ZáéíóúñÁÉÍÓÚÑ]/.test(label)) return [];
    if (/\b(19|20)\d{2}\b/.test(label) && /(al |cifras|periodo|ejercicio)/i.test(label)) return [];   // títulos con fecha
    const values = tokens.slice(firstNum).map(t => parseAmount(t.t));
    return [{ label, values }];
  });
}

// Excel → renglones (primera celda de texto = cuenta; celdas numéricas = importes).
export function linesFromRows(rows: any[][]): RawLine[] {
  return rows.flatMap(r => {
    const cells = (r || []).filter(c => c !== null && c !== undefined && String(c).trim() !== '');
    const label = cells.find(c => typeof c === 'string' && /[a-zA-Z]/.test(c));
    const values = cells.filter(c => typeof c === 'number' || (typeof c === 'string' && /^\(?-?[\d,.$\s]+\)?$/.test(c.trim()))).map(c => (typeof c === 'number' ? c : parseAmount(String(c))));
    return label && values.length ? [{ label: String(label).trim(), values }] : [];
  });
}

// ── Jerarquía por sumas ─────────────────────────────────────────────────────────────────────────────────────────────
// Tolerancia de redondeo: documentos en miles redondean cada renglón (hasta 2 unidades de la cifra mostrada).
let ROUND_UNIT = 1;
const tol = (v: number) => Math.max(1.5, ROUND_UNIT * 2, Math.abs(v) * 0.0005);

interface Node { idx: number; label: string; value: number; children: Node[]; end: number }

function buildTree(items: Array<{ label: string; value: number }>): Node[] {
  // Intenta formar el grupo con sub-grupos; si no cuadra, reintenta tomando el detalle como renglones simples (dos
  // renglones hermanos con el mismo importe, p. ej. "Fondo de ahorro empresa / empleados", no son padre e hijo).
  const parse = (i: number, limit: number, allowGroup = true): Node => {
    const node: Node = { idx: i, label: items[i].label, value: items[i].value, children: [], end: i + 1 };
    if (!allowGroup || !items[i].value || classifyLiability(items[i].label) === 'total') return node;
    for (const nested of [true, false]) {
      let k = i + 1; let acc = 0; const kids: Node[] = [];
      while (k < limit && Math.abs(acc) < Math.abs(node.value) - tol(node.value)) {
        if (classifyLiability(items[k].label) === 'total') break;
        const child = parse(k, limit, nested);
        kids.push(child); acc += child.value; k = child.end;
      }
      if (kids.length >= 1 && Math.abs(acc - node.value) <= tol(node.value) && !(kids.length === 1 && norm(kids[0].label) === norm(node.label))) {
        node.children = kids; node.end = k;
        return node;
      }
    }
    return node;
  };
  const roots: Node[] = []; let i = 0;
  while (i < items.length) { const n = parse(i, items.length); roots.push(n); i = n.end; }
  return roots;
}

function flatten(roots: Node[]): ParsedLine[] {
  const out: ParsedLine[] = [];
  const walk = (n: Node, level: number, parent: Node | null, inherited: LiabilityKind | null, term: Term, inFunding: boolean) => {
    const own = classifyLiability(n.label);
    const kind: LiabilityKind = own === 'total' ? 'total' : (inherited && inherited !== 'otro' ? inherited : own) || inherited || 'otro';
    const t = termOf(n.label) || term;
    const isGroup = n.children.length > 0;
    const isLender = inFunding && !isGroup && !isTermBucket(n.label);
    out.push({ label: n.label, value: n.value, kind, term: t, level, parent: parent?.label ?? null, isGroup, isLender });
    n.children.forEach(c => walk(c, level + 1, n, kind, t, kind === 'fondeo'));
  };
  roots.forEach(r => walk(r, 0, null, null, '', false));
  return out;
}

export function parseLiabilityBreakdown(raw: RawLine[], context: { text?: string; fileName?: string } = {}): LiabilityParseResult {
  const { unit, label: unitLabel } = detectUnit(context.text || '');
  const cols = Math.max(1, ...raw.map(r => r.values.length));
  const cutoffs = detectCutoffs(context.text || '', context.fileName || '');
  const reasons: string[] = [];
  const periods: ParsedPeriod[] = [];
  for (let c = 0; c < cols; c++) {
    ROUND_UNIT = unit;
    const items = raw.map(r => ({ label: r.label, value: (r.values[c] ?? 0) * unit })).filter(x => Number.isFinite(x.value));
    const lines = flatten(buildTree(items));
    const total = lines.find(l => l.kind === 'total' && l.level === 0)?.value ?? null;
    const top = lines.filter(l => l.level === 0 && l.kind !== 'total');
    const composition = { fondeo: 0, impuestos: 0, operativo: 0, empleados: 0, otro: 0 } as ParsedPeriod['composition'];
    top.forEach(l => { composition[l.kind as Exclude<LiabilityKind, 'total'>] += l.value; });
    // Fondeadores: detalles de grupos de fondeo; si un renglón de fondeo no tiene detalle, él mismo es el fondeador.
    const funding = lines.filter(l => l.kind === 'fondeo' && (l.isLender || (l.level === 0 && !l.isGroup))).map(l => ({ lender: l.label, term: l.term, balance: l.value }));
    const checks: ParsedPeriod['checks'] = [];
    const sumTop = top.reduce((a, l) => a + l.value, 0);
    if (total !== null) checks.push({ ok: Math.abs(sumTop - total) <= tol(total), detail: `Total pasivo ${total.toLocaleString('es-MX')} vs suma de rubros ${sumTop.toLocaleString('es-MX')}` });
    const unclassified = top.filter(l => l.kind === 'otro');
    if (unclassified.length) checks.push({ ok: false, detail: `Sin clasificar (revisar): ${unclassified.map(l => l.label).join(', ')}` });
    periods.push({ cutoff: cutoffs[c] ?? (cols === 1 ? cutoffs[0] ?? null : null), lines, funding, composition, totalLiabilities: total, checks });
  }
  const p = periods[0];
  const recognized = !!p && p.funding.length > 0 && (p.totalLiabilities !== null || p.lines.some(l => l.isGroup));
  if (!p?.funding.length) reasons.push('No se encontró ningún renglón de fondeo (préstamos, bancos, otros organismos, inversionistas…).');
  if (p && p.totalLiabilities === null) reasons.push('No trae "Total pasivo": no se puede validar que el desglose cuadre.');
  if (!cutoffs.length) reasons.push('No se encontró la fecha de corte en el documento ni en el nombre del archivo.');
  return { recognized, unit, unitLabel, periods, reasons };
}

// Salida de CUALQUIER IA (filas de pasivos ya extraídas): se aplican las mismas reglas para que solo el fondeo con costo
// llegue a Pasivos Institucionales (impuestos, proveedores, beneficios a empleados se descartan con motivo).
export function screenAiLiabilityRows<T extends { lenderName: string }>(rows: T[]): { keep: T[]; dropped: Array<{ row: T; kind: LiabilityKind }> } {
  const keep: T[] = []; const dropped: Array<{ row: T; kind: LiabilityKind }> = [];
  rows.forEach(r => {
    const kind = classifyLiability(r.lenderName);
    if (kind && kind !== 'fondeo' && kind !== 'otro') dropped.push({ row: r, kind }); else keep.push(r);
  });
  return { keep, dropped };
}
