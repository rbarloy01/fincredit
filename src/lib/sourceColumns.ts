// Columnas TAL COMO las reporta el cliente en su loan tape. El estandarizador solo conserva ~15 campos; todo lo demás
// (intereses vencidos, condonaciones, gastos de cobranza, pagos anticipados…) se perdía, incluso cuando el cliente lo
// reporta en 0. Regla de negocio (2026-10-08, Tim Leasing): lo que el cliente reporta se conserva y se muestra; una
// columna que viene completa en 0 o vacía se marca, no se esconde.

export interface SourceTable {
  sheet: string;
  headers: string[];
  rows: Array<Array<string | number | boolean | null>>;
}

export type SourceColumnFlag = 'todo_cero' | 'vacia' | 'mayoria_cero' | null;

export interface SourceColumnProfile {
  header: string;
  mappedTo: string | null;
  filled: number;
  zeros: number;
  numeric: number;
  total: number | null;
  flag: SourceColumnFlag;
  flagText: string;
}

// Límite para no inflar extracted_data (los tapes grandes de 37k créditos × 60 columnas pesan decenas de MB).
export const MAX_SOURCE_CELLS = 1_500_000;

const isBlank = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

function asNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const t = v.trim().replace(/[$,\s]/g, '');
  if (!t || !/^-?\d+(\.\d+)?%?$/.test(t)) return null;
  const n = Number(t.replace('%', ''));
  return Number.isFinite(n) ? (t.endsWith('%') ? n / 100 : n) : null;
}

export function buildSourceTable(sheet: string, headers: string[], rows: any[][]): SourceTable | null {
  if (!headers.length || !rows.length || headers.length * rows.length > MAX_SOURCE_CELLS) return null;
  const portable = (v: any) => (v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === 'object' && v !== null ? String(v) : v ?? null);
  return { sheet, headers, rows: rows.map(r => headers.map((_, i) => portable(r[i]))) };
}

export function profileSourceColumns(table: SourceTable, mapping: Array<{ source_header: string; target_term: string }> = []): SourceColumnProfile[] {
  const mappedBy = new Map<string, string>();
  mapping.forEach(m => String(m.source_header).split(' + ').forEach(h => mappedBy.set(h.trim(), m.target_term)));
  return table.headers.map((header, i) => {
    let filled = 0, zeros = 0, numeric = 0, sum = 0;
    table.rows.forEach(r => {
      const v = r[i];
      if (isBlank(v)) return;
      filled += 1;
      const n = asNumber(v);
      if (n !== null) { numeric += 1; sum += n; if (n === 0) zeros += 1; }
    });
    const n = table.rows.length;
    let flag: SourceColumnFlag = null;
    let flagText = '';
    if (filled === 0) { flag = 'vacia'; flagText = 'Columna reportada sin ningún dato'; }
    else if (numeric > 0 && zeros === filled) { flag = 'todo_cero'; flagText = `Reportada en 0 en los ${n} créditos`; }
    else if (numeric > 0 && zeros / filled >= 0.95) { flag = 'mayoria_cero'; flagText = `${zeros} de ${filled} en 0`; }
    return {
      header, mappedTo: mappedBy.get(header) || null, filled, zeros, numeric,
      total: numeric > 0 && numeric / filled >= 0.8 ? sum : null, flag, flagText,
    };
  });
}
