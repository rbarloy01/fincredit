export function normalizeAccountName(value?: string): string {
  return (value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
}

const nkey = normalizeAccountName;

// THE single account classifier (ACTIVO / PASIVO / CAPITAL / Estado de Resultados / …). Estados Financieros, Auditoría,
// the reconciliation and every Excel export call this one function, so an account can never sit in two sections.
export function classifyAccount(statementType: string, accountName: string, sectionPath?: string | null): string {
  const type = statementType || 'otro';
  const path = nkey(sectionPath || '');
  const name = nkey(accountName || '');
  const isCapitalName = /(capitalsocial|capitalcontable|patrimonio|resultadoacumulado|utilidadretenida|resultadodelejercicio|resultadoneto|resultadodeejercicios|resultadosdeejercicios|reservasdecapital|aportacionesparafuturos|utilidaddelejercicio|perdidadelejercicio|superavit)/.test(name);
  const isPasivoName = /(pasivo|proveedor|acreedor|deuda|obligacion|prestamo|impuesto|seguro|social|imss|isr|iva|ptu|provision|cuentas?porpagar|cxp)/.test(name);
  if (type === 'estado_resultados' || path.includes('estadoresultado')) return 'Estado de Resultados';
  if (type === 'flujo_efectivo' || path.includes('flujoefectivo')) return 'Flujo de Efectivo';
  if (path.includes('manual') || path.includes('auditoria')) {
    if (path.includes('activo')) return 'ACTIVO';
    if (path.includes('pasivo') && !isCapitalName) return 'PASIVO';
    if (path.includes('capital') || path.includes('patrimonio')) return isPasivoName && !isCapitalName ? 'PASIVO' : 'CAPITAL';
    if (path.includes('estadoresultado')) return 'Estado de Resultados';
    if (path.includes('flujoefectivo')) return 'Flujo de Efectivo';
    if (path.includes('otros')) return 'Otros';
  }
  // The source's own explicit ACTIVO / PASIVO / CAPITAL section heading is
  // authoritative — honor it before falling back to the name heuristics below,
  // which otherwise misfile lines by wording alone: "ISR/IVA acreditable" (an
  // asset) lands in PASIVO because the regex catches "isr"/"iva", and "Cuentas
  // por cobrar capital" (a receivable) lands in CAPITAL because the name
  // contains "capital" — inflating equity and breaking the balance check. A
  // combined "Pasivo y Capital" heading names two segments at once, so it stays
  // ambiguous and drops through to the heuristics instead of guessing.
  // Business rule: the DEEPEST heading that names a single section decides. "Pasivo y capital > Capital contable" is
  // equity: the sub-heading is more specific than the combined parent (it used to drop to name heuristics and send
  // "Resultado neto" / "Resultado de ejercicios anteriores" to PASIVO, so Pasivo and Capital never tied to their totals).
  const headings = (sectionPath || '').split('>').map(h => nkey(h));
  for (let i = headings.length - 1; i >= 0; i--) {
    const h = headings[i];
    const a = h.includes('activo'); const p = h.includes('pasivo'); const c = h.includes('capital') || h.includes('patrimonio');
    if (a && !p && !c) return 'ACTIVO';
    if (p && !a && !c) return 'PASIVO';
    if (c && !a && !p) return 'CAPITAL';
  }
  const pathActivo = path.includes('activo');
  const pathPasivo = path.includes('pasivo');
  const pathCapital = path.includes('capital') || path.includes('patrimonio');
  const explicitSegments = (pathActivo ? 1 : 0) + (pathPasivo ? 1 : 0) + (pathCapital ? 1 : 0);
  if (explicitSegments === 1) {
    if (pathActivo) return 'ACTIVO';
    if (pathPasivo) return 'PASIVO';
    return 'CAPITAL';
  }

  // Liability wording takes precedence over a generic "capital" mention, as in
  // "Pasivo y capital". Only explicit equity account names belong in CAPITAL.
  if (isPasivoName && !isCapitalName) return 'PASIVO';
  if (isCapitalName || name.includes('capital')) return 'CAPITAL';
  if (/(activo|caja|banco|efectivo|disponibilidad|cliente|cuentas?porcobrar|inventario|propiedad|equipo|intangible)/.test(name)) return 'ACTIVO';
  if (path.includes('pasivo')) return 'PASIVO';
  if (path.includes('capital') || path.includes('patrimonio')) return 'CAPITAL';
  if (path.includes('activo')) return 'ACTIVO';
  if (type === 'balance_general') return 'Balance General sin clasificar';
  return 'Otros';
}

export type AccountSegment = 'ACTIVO' | 'PASIVO' | 'CAPITAL' | 'Estado de Resultados' | 'Flujo de Efectivo' | 'Otros';

export const segmentToStatementType = (segment: AccountSegment): 'balance_general' | 'estado_resultados' | 'flujo_efectivo' | 'otro' => {
  if (segment === 'Estado de Resultados') return 'estado_resultados';
  if (segment === 'Flujo de Efectivo') return 'flujo_efectivo';
  if (segment === 'Otros') return 'otro';
  return 'balance_general';
};

export const MANUAL_PATH_PREFIX = 'Manual Auditoría';
export const manualSegmentPath = (segment: AccountSegment) => `${MANUAL_PATH_PREFIX} > ${segment}`;

// Moves every line of an account (same statementType + name) to another section. This changes the DATA (rawLineItems), so
// ratios, Excel, reconciliation and the pivot all see the same classification.
export function reassignAccountItems<T extends { name: string; statementType?: string | null; sectionPath?: string | null }>(
  items: T[], statementType: string, name: string, segment: AccountSegment,
): T[] {
  return items.map(item => ((item.statementType || 'otro') === statementType && item.name === name
    ? { ...item, statementType: segmentToStatementType(segment), sectionPath: manualSegmentPath(segment) }
    : item));
}
