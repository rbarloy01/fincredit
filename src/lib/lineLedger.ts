import { parseFinancialNumber } from './numberParsing';

export type LineMovementType = 'disposicion' | 'amortizacion';

export interface LineMovement {
  id: string;
  fecha: string; // ISO yyyy-mm-dd, o '' si no se conoce
  tipo: LineMovementType;
  monto: number;
  nota?: string;
}

export interface LineBalance {
  dispuesto: number;
  amortizado: number;
  saldo: number;
  utilizacion: number | null; // fracción 0..1+ (saldo / monto de la línea)
  hasMovements: boolean;
}

export const newMovementId = () => `mv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

// Dispuesto = suma de disposiciones; si no hay ninguna se asume línea dispuesta al 100% del monto
// (caso crédito simple, donde solo se capturan amortizaciones).
export function computeLineBalance(
  line: { monto: number | null; saldoActual: number | null; pctUtilizacion: number | null; movimientos?: LineMovement[] },
): LineBalance {
  const movs = line.movimientos || [];
  const monto = line.monto || 0;
  if (movs.length === 0) {
    const saldo = line.saldoActual ?? 0;
    return {
      dispuesto: saldo,
      amortizado: 0,
      saldo,
      utilizacion: monto > 0 ? saldo / monto : line.pctUtilizacion,
      hasMovements: false,
    };
  }
  const disposiciones = movs.filter(m => m.tipo === 'disposicion').reduce((s, m) => s + m.monto, 0);
  const amortizado = movs.filter(m => m.tipo === 'amortizacion').reduce((s, m) => s + m.monto, 0);
  const dispuesto = disposiciones > 0 ? disposiciones : monto;
  const saldo = Math.max(0, dispuesto - amortizado);
  return { dispuesto, amortizado, saldo, utilizacion: monto > 0 ? saldo / monto : null, hasMovements: true };
}

const norm = (v: unknown) => String(v ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

function parseDate(value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value === 'number' && value > 20000 && value < 80000) {
    // serial de Excel (1900 date system)
    return new Date(Math.round((value - 25569) * 86400 * 1000)).toISOString().slice(0, 10);
  }
  const s = String(value).trim();
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  const dmy = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (dmy) {
    const year = dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3];
    return `${year}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  }
  const t = new Date(s);
  return Number.isFinite(t.getTime()) ? t.toISOString().slice(0, 10) : '';
}

function parseTipo(value: unknown): LineMovementType | null {
  const s = norm(value);
  if (!s) return null;
  if (s.startsWith('disp') || s.includes('fondeo') || s.includes('draw')) return 'disposicion';
  if (s.startsWith('amort') || s.includes('pago') || s.includes('abono') || s.includes('capital') || s.includes('repay')) return 'amortizacion';
  return null;
}

// Acepta filas de Excel/CSV/texto pegado. Detecta encabezados (Fecha / Tipo / Monto) si existen;
// si no, asume columnas Fecha, Monto [, Tipo]. Sin tipo = amortización; el signo del monto se ignora.
export function parseMovementRows(rows: unknown[][]): { movements: LineMovement[]; skipped: number } {
  const clean = rows.filter(r => Array.isArray(r) && r.some(c => c !== null && c !== undefined && String(c).trim() !== ''));
  if (clean.length === 0) return { movements: [], skipped: 0 };

  let fechaCol = -1, tipoCol = -1, montoCol = -1, notaCol = -1;
  const header = clean[0].map(norm);
  const looksLikeHeader = header.some(h => /fecha|date|monto|importe|amount|tipo|concepto/.test(h));
  let dataRows = clean;
  if (looksLikeHeader) {
    fechaCol = header.findIndex(h => /fecha|date/.test(h));
    tipoCol = header.findIndex(h => /tipo|movimiento|concepto|type/.test(h));
    montoCol = header.findIndex(h => /monto|importe|amount|capital|pago|amortiz|dispos/.test(h));
    notaCol = header.findIndex(h => /nota|comentario|descripcion|referencia/.test(h));
    dataRows = clean.slice(1);
  }
  if (fechaCol < 0 && montoCol < 0) {
    // sin encabezados: fecha = 1a columna; tipo = la columna con texto de tipo; monto = la primera numérica restante
    const first = clean[0];
    fechaCol = 0;
    tipoCol = first.findIndex((c, i) => i > 0 && parseTipo(c) !== null);
    montoCol = first.findIndex((c, i) => i > 0 && i !== tipoCol && Number.isFinite(parseFinancialNumber(c, NaN)));
  }
  if (montoCol < 0) montoCol = fechaCol === 0 ? 1 : 0;

  const movements: LineMovement[] = [];
  let skipped = 0;
  for (const row of dataRows) {
    const raw = parseFinancialNumber(row[montoCol], NaN);
    if (!Number.isFinite(raw) || raw === 0) { skipped += 1; continue; }
    const tipo = parseTipo(tipoCol >= 0 ? row[tipoCol] : null) || 'amortizacion';
    movements.push({
      id: newMovementId(),
      fecha: fechaCol >= 0 ? parseDate(row[fechaCol]) : '',
      tipo,
      monto: Math.abs(raw),
      nota: notaCol >= 0 && row[notaCol] ? String(row[notaCol]) : undefined,
    });
  }
  return { movements, skipped };
}

export function parsePastedMovements(text: string) {
  const rows = text.split(/\r?\n/).map(line => line.split(/\t|;|\s{2,}/));
  return parseMovementRows(rows);
}
