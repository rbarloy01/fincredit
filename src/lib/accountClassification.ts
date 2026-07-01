export function normalizeAccountName(value?: string): string {
  return (value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
}

export function classifyAccount(statementType: string, name: string, sectionPath?: string | null): string {
  const path = normalizeAccountName(sectionPath || '');
  const n = normalizeAccountName(name);
  const isCapitalName = /(capitalsocial|capitalcontable|patrimonio|resultadoacumulado|utilidadretenida|resultadodelejercicio)/.test(n);
  const isPasivoName = /(pasivo|proveedor|acreedor|deuda|obligacion|prestamo|impuesto|seguro|social|imss|isr|iva|ptu|provision|cuentaporpagar|cxp)/.test(n);
  if (path.includes('estadoresultado')) return 'Estado de Resultados';
  if (path.includes('flujoefectivo')) return 'Flujo de Efectivo';
  if (path.includes('manual') || path.includes('auditoria')) {
    if (path.includes('activo')) return 'ACTIVO';
    if (path.includes('pasivo') && !isCapitalName) return 'PASIVO';
    if (path.includes('capital') || path.includes('patrimonio')) return isPasivoName && !isCapitalName ? 'PASIVO' : 'CAPITAL';
    if (path.includes('estadoresultado')) return 'Estado de Resultados';
    if (path.includes('flujoefectivo')) return 'Flujo de Efectivo';
    if (path.includes('otros')) return 'Otros';
  }
  if (statementType === 'estado_resultados') return 'Estado de Resultados';
  if (statementType === 'flujo_efectivo') return 'Flujo de Efectivo';
  if (statementType !== 'balance_general') return 'Otros';
  if (isPasivoName && !isCapitalName) return 'PASIVO';
  if (isCapitalName || n.includes('capital')) return 'CAPITAL';
  if (/(activo|caja|banco|efectivo|cliente|cuentaporcobrar|inventario|propiedad|equipo|intangible)/.test(n)) return 'ACTIVO';
  if (path.includes('pasivo')) return 'PASIVO';
  if (path.includes('capital') || path.includes('patrimonio')) return 'CAPITAL';
  if (path.includes('activo')) return 'ACTIVO';
  if (/(capital|patrimonio|resultadoacumulado|utilidadretenida)/.test(n)) return 'CAPITAL';
  if (/(pasivo|proveedor|acreedor|deuda|obligacion|prestamo)/.test(n)) return 'PASIVO';
  if (/(activo|caja|banco|efectivo|cliente|cuentaporcobrar|inventario|propiedad|equipo|intangible)/.test(n)) return 'ACTIVO';
  return 'Balance General sin clasificar';
}
