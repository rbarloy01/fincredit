// Balance-sheet hierarchy classifier.
//
// Extracted financial statements arrive as a FLAT list of line items, but a
// balance sheet is really a tree: leaves roll up into subtotals, subtotals into
// section grand totals. To render subtotals and the grand total as REAL =SUM()
// formulas (auditable, and with the vertical analysis dividing by the true
// grand total), we have to recover that tree from the flat list. Two shapes
// appear in practice:
//
//   • Nested — the source's sectionPath encodes the tree, e.g.
//     "Balance General > ACTIVO > Activos circulantes". The grand total is the
//     sum of each immediate sub-group's own subtotal line.
//   • Flat — every line sits directly under the section (typical of CNBV
//     statements), with subtotals ("TOTAL CARTERA DE CREDITO") and net-of-contra
//     lines ("CARTERA (NETO)") interleaved among the leaves. Here we recover the
//     structure arithmetically: a line is a subtotal when a run of the preceding
//     un-consumed lines sums to it.
//
// The classifier is per-period (values differ each period), returning, for one
// period's values, which line is the grand total, and for the grand total and
// every subtotal, the child line keys that sum into it. The caller emits a
// cell as =SUM(children) only when those children numerically tie to the
// source's own figure (see childrenTie), so a formula never shows a wrong
// number — where the data can't be reconciled, the source literal is kept.

export interface BalanceLine {
  key: string;
  name: string;
  /** sectionPath segments BELOW the section, e.g. ["Activos circulantes"]. */
  rel: string[];
}

export interface SectionClassification {
  grandKey: string | null;
  /** line key -> child line keys that sum into it (grand total and subtotals). */
  childrenByKey: Map<string, string[]>;
}

function nkey(v: string): string {
  return v.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
}

// Name with a leading "total"/"suma"/"subtotal"/"de" stripped, so a group
// subtotal like "Total de activos circulantes" reduces to the group segment
// "activoscirculantes".
function strippedName(name: string): string {
  return nkey(name).replace(/^(total|suma|subtotal)/, '').replace(/^de/, '');
}

function isSectionGrandTotal(name: string, section: string): boolean {
  const n = nkey(name);
  if (/(totalpasivoycapital|totalpasivomascapital|sumapasivoycapital)/.test(n)) return false;
  if (section === 'ACTIVO') return /^(totalactivo|activostotales|sumadelactivo|totaldelactivo)/.test(n);
  if (section === 'PASIVO') return /^(totalpasivo|pasivototal|sumadelpasivo|totaldelpasivo)/.test(n) && !/capital|patrimonio/.test(n);
  if (section === 'CAPITAL') return /(totalcapitalcontable|totalcapital|sumadelcapital|totalpatrimonio|totaldelcapital)/.test(n) && !/pasivo/.test(n);
  return false;
}

const TOL = (v: number) => Math.max(1000, Math.abs(v) * 0.005);

/** Do the children's values sum to `target` within rounding tolerance? */
export function childrenTie(childValues: Array<number | null>, target: number | null): boolean {
  if (target === null) return false;
  const present = childValues.filter((v): v is number => v !== null && Number.isFinite(v));
  if (present.length < 2) return false;
  const sum = present.reduce((a, b) => a + b, 0);
  return Math.abs(sum - target) <= TOL(target);
}

// FLAT: recover subtotals arithmetically. Walk the lines in source order; a
// line is a subtotal when a run of >= 2 preceding un-consumed lines sums to it.
// Those preceding lines become its children (consumed, so they don't also feed
// the grand total). Whatever is never consumed are the grand total's children.
function classifyFlat(section: string, lines: BalanceLine[], valueOf: (key: string) => number | null): SectionClassification {
  const childrenByKey = new Map<string, string[]>();
  let grandKey: string | null = null;
  const detail = lines.filter(l => {
    if (isSectionGrandTotal(l.name, section)) { grandKey = l.key; return false; }
    return true;
  });

  const n = detail.length;
  const consumed = new Array(n).fill(false);
  const isSubtotal = new Array(n).fill(false);

  for (let i = 0; i < n; i++) {
    const vi = valueOf(detail[i].key);
    if (vi === null || !Number.isFinite(vi)) continue;
    let run = 0;
    let start = -1;
    for (let j = i - 1; j >= 0; j--) {
      if (consumed[j]) continue;
      const vj = valueOf(detail[j].key);
      if (vj === null || !Number.isFinite(vj)) break;
      run += vj;
      if (Math.abs(run - vi) <= TOL(vi)) { start = j; break; }
    }
    if (start >= 0 && i - start >= 2) {
      isSubtotal[i] = true;
      const children: string[] = [];
      for (let k = start; k < i; k++) { consumed[k] = true; children.push(detail[k].key); }
      childrenByKey.set(detail[i].key, children);
    }
  }

  // Grand-total children = everything not consumed by a subtotal — i.e. the
  // top-level leaves plus the top-level subtotals (which are themselves
  // unconsumed and stand in for their own children).
  const grandChildren = detail.filter((_, i) => !consumed[i]).map(l => l.key);
  if (grandKey && grandChildren.length >= 2) childrenByKey.set(grandKey, grandChildren);
  return { grandKey, childrenByKey };
}

// NESTED: use the sectionPath tree. Each node (a rel-path prefix) has one
// subtotal line — the line whose stripped name matches the node's last segment —
// and its children are the node's other lines. The grand total's children are
// the immediate sub-groups' subtotal lines.
function classifyNested(section: string, lines: BalanceLine[], _valueOf: (key: string) => number | null): SectionClassification {
  const childrenByKey = new Map<string, string[]>();
  const grand = lines.find(l => l.rel.length === 0 && isSectionGrandTotal(l.name, section));
  const grandKey = grand ? grand.key : null;

  // Bucket lines by their node path (rel joined).
  const nodes = new Map<string, BalanceLine[]>();
  for (const l of lines) {
    if (l === grand) continue;
    const path = l.rel.join(' > ');
    if (!nodes.has(path)) nodes.set(path, []);
    nodes.get(path)!.push(l);
  }

  const immediateGroupSubtotals: string[] = [];
  for (const [path, nodeLines] of nodes) {
    const segs = path ? path.split(' > ') : [];
    const lastSeg = segs.length ? nkey(segs[segs.length - 1]) : '';
    // The node's own subtotal: the line naming the node itself.
    const subtotal = nodeLines.find(l => strippedName(l.name) === lastSeg) || null;
    const children = nodeLines.filter(l => l !== subtotal).map(l => l.key);
    if (subtotal && children.length) childrenByKey.set(subtotal.key, children);
    // Depth-1 nodes contribute their subtotal to the grand total.
    if (segs.length === 1) {
      immediateGroupSubtotals.push(subtotal ? subtotal.key : (nodeLines[0]?.key ?? ''));
    }
  }

  const grandChildren = immediateGroupSubtotals.filter(Boolean);
  if (grandKey && grandChildren.length >= 1) childrenByKey.set(grandKey, grandChildren);
  return { grandKey, childrenByKey };
}

export function classifyBalanceSection(
  section: string,
  lines: BalanceLine[],
  valueOf: (key: string) => number | null,
): SectionClassification {
  const nested = lines.some(l => l.rel.length >= 1);
  return nested ? classifyNested(section, lines, valueOf) : classifyFlat(section, lines, valueOf);
}
