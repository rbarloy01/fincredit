// Bitácora mensual de cumplimiento de obligaciones de hacer / no hacer.
// Una entrada por obligación × mes (YYYY-MM): cumple / incumple / N.A., con motivo
// obligatorio cuando incumple y la fuente (revisión manual o certificado de cumplimiento).
// Se guarda como un solo JSON en client_settings (sin migración).

import { db, type Covenant_DB } from '../db/index';

export type MonthlyStatus = 'cumple' | 'incumple' | 'na';

export interface MonthlyEntry {
  status: MonthlyStatus;
  reason?: string;
  source: 'manual' | 'certificado';
  certificate?: string;
  userName: string;
  updatedAt: string;
}

export type ComplianceLog = Record<string, Record<string, MonthlyEntry>>;

export const COMPLIANCE_LOG_KEY = 'covenant_compliance_monthly';

const MONTHS_ES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

export function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function monthLabel(key: string): string {
  const [y, m] = key.split('-').map(Number);
  return `${MONTHS_ES[m - 1]}-${String(y).slice(2)}`;
}

// El certificado de cumplimiento normalmente llega por el mes anterior.
export function defaultMonth(today = new Date()): string {
  return monthKey(new Date(today.getFullYear(), today.getMonth() - 1, 1));
}

// Últimos `n` meses terminando en `anchor` (inclusive), del más viejo al más reciente.
export function monthsEndingAt(anchor: string, n = 12): string[] {
  const [y, m] = anchor.split('-').map(Number);
  return Array.from({ length: n }, (_, i) => monthKey(new Date(y, m - 1 - (n - 1 - i), 1)));
}

export interface MonthSummary { cumple: number; incumple: number; na: number; pendiente: number }

export function summarizeMonth(log: ComplianceLog, covenants: Covenant_DB[], month: string): MonthSummary {
  const out: MonthSummary = { cumple: 0, incumple: 0, na: 0, pendiente: 0 };
  covenants.forEach(c => {
    const e = log[c.id]?.[month];
    if (!e) out.pendiente += 1;
    else out[e.status] += 1;
  });
  return out;
}

// Meses consecutivos en incumplimiento terminando en `month`.
export function breachStreak(log: ComplianceLog, covenantId: string, month: string): number {
  let streak = 0;
  for (const m of [...monthsEndingAt(month, 36)].reverse()) {
    if (log[covenantId]?.[m]?.status === 'incumple') streak += 1;
    else break;
  }
  return streak;
}

export async function loadComplianceLog(clientId: string): Promise<ComplianceLog> {
  return db.getClientSetting<ComplianceLog>(clientId, COMPLIANCE_LOG_KEY, {});
}

// Re-lee lo guardado antes de escribir y solo sobreescribe las celdas que cambiaron,
// para no pisar lo que otro analista haya marcado mientras tanto.
export async function saveComplianceEntries(
  clientId: string,
  updates: Array<{ covenantId: string; month: string; entry: MonthlyEntry | null }>,
): Promise<ComplianceLog> {
  const current = await loadComplianceLog(clientId);
  const next: ComplianceLog = { ...current };
  updates.forEach(({ covenantId, month, entry }) => {
    const row = { ...(next[covenantId] || {}) };
    if (entry) row[month] = entry;
    else delete row[month];
    next[covenantId] = row;
  });
  await db.setClientSetting(clientId, COMPLIANCE_LOG_KEY, next);
  return next;
}

// Estatus "vigente" del covenant (campo complianceStatus que usan reporte y dashboard):
// el del mes más reciente registrado. N.A. no cambia el estatus.
export function latestStatus(log: ComplianceLog, covenantId: string): 'cumple' | 'incumple' | null {
  const months = Object.keys(log[covenantId] || {}).sort().reverse();
  for (const m of months) {
    const s = log[covenantId][m].status;
    if (s !== 'na') return s;
  }
  return null;
}
