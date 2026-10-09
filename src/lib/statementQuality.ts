// Quality gate for extracted financial statements: runs BEFORE a statement is saved and again on every saved one.
// It answers "can I trust these numbers?" with explicit checks (cuadre, escala, signos, periodo, coherencia entre
// periodos, cobertura), a 0-100 confidence score, and a quarantine decision (blocking issues keep the statement out of
// ratios and dashboards until a person approves it).

import type { FinancialStatement_DB } from '../db/index';
import type { StatementReconciliation } from './export';
import { classifyAccount } from './accountClassification';
import { getMetric } from './financialMetrics';
import { checkHierarchy } from './statementRules';

export type CheckSeverity = 'ok' | 'info' | 'warn' | 'block';
export interface QualityCheck { id: string; label: string; severity: CheckSeverity; detail: string }
export type QualityLevel = 'alta' | 'media' | 'baja' | 'bloqueada';

export interface StatementQuality {
  score: number;
  level: QualityLevel;
  blocking: boolean;
  checks: QualityCheck[];
}

export type QualityStatus = 'ok' | 'en_revision' | 'aprobado';
export interface StatementQualityRecord extends StatementQuality {
  status: QualityStatus;
  items: number;
  evaluatedAt: string;
  extractionMs?: number;
  model?: string;
  fileName?: string;
  approvedAt?: string;
}

export const QUALITY_SETTING_KEY = 'finmonitor_statement_quality';

type StatementLike = Pick<FinancialStatement_DB, 'period' | 'periodDate' | 'rawLineItems' | 'mappedData'> & { id?: string };

const money = (v: number) => `$${Math.round(v).toLocaleString('es-MX')}`;
const ratioText = (r: number) => (r >= 1 ? `${r.toFixed(1)}x` : `1/${(1 / r).toFixed(1)}x`);

function assetsOf(stmt: StatementLike): number | null {
  const v = getMetric(stmt as FinancialStatement_DB, 'totalAssets');
  return v !== null && Number.isFinite(v) ? v : null;
}

function nearestPrevious(stmt: StatementLike, history: StatementLike[]): StatementLike | null {
  const before = history.filter(h => h.periodDate && h.periodDate < stmt.periodDate && h.id !== stmt.id).sort((a, b) => a.periodDate.localeCompare(b.periodDate));
  return before.length ? before[before.length - 1] : null;
}

export function assessStatementQuality(stmt: StatementLike, history: StatementLike[], recon?: StatementReconciliation | null): StatementQuality {
  const checks: QualityCheck[] = [];
  const add = (id: string, label: string, severity: CheckSeverity, detail: string) => checks.push({ id, label, severity, detail });
  const items = (stmt.rawLineItems || []).filter(i => typeof i.value === 'number');
  const assets = assetsOf(stmt);
  // A document may carry only the income statement (or only the balance): checks that need the missing half are skipped, not failed.
  const hasBalance = items.some(i => (i.statementType || 'balance_general') === 'balance_general');
  const hasIncome = items.some(i => i.statementType === 'estado_resultados');

  // 0. Regla de negocio: cada subtotal / total del estado de resultados = suma de sus componentes (todos los niveles).
  if (hasIncome) {
    const er = checkHierarchy(stmt.rawLineItems || [], 'estado_resultados');
    if (er?.top) {
      if (er.ok) add('cuadre_er', 'Estado de resultados cuadra por niveles', 'ok', `${er.top.name} = suma de sus ${er.leaves} componentes; ${er.nodesChecked} subtotales cuadran.`);
      else {
        const worst = [...er.failures].sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap))[0];
        const base = Math.abs(er.top.reported) || 1;
        const severity: CheckSeverity = worst && Math.abs(worst.gap) > base * 0.05 ? 'block' : 'warn';
        add('cuadre_er', 'Estado de resultados cuadra por niveles', severity, er.failures.length
          ? `No cuadran: ${er.failures.slice(0, 3).map(f => `${f.name} (reportado ${money(f.reported)} vs. componentes ${money(f.childrenSum)})`).join(' · ')}`
          : `${er.top.name}: reportado ${money(er.top.reported)} vs. suma de componentes ${money(er.top.leafSum)}.`);
      }
    }
  }

  if (hasBalance) {
    const bg = checkHierarchy(stmt.rawLineItems || [], 'balance_general');
    if (bg && bg.failures.length) {
      add('cuadre_bg_niveles', 'Subtotales del balance cuadran', 'warn', `No cuadran: ${bg.failures.slice(0, 3).map(f => `${f.name} (reportado ${money(f.reported)} vs. componentes ${money(f.childrenSum)})`).join(' · ')}`);
    } else if (bg) {
      add('cuadre_bg_niveles', 'Subtotales del balance cuadran', 'ok', `${bg.nodesChecked} subtotales y totales del balance igualan la suma de sus componentes.`);
    }
  }

  // 1. Cuadre contable
  if (!hasBalance) {
    add('cuadre', 'Cuadre Activo = Pasivo + Capital', 'info', 'El documento no trae balance general (solo estado de resultados).');
  } else if (recon) {
    const dif = recon.balanceCheck.diferencia;
    const base = Math.abs(recon.balanceCheck.totalActivo || 0);
    if (dif === null) add('cuadre', 'Cuadre Activo = Pasivo + Capital', 'warn', 'No se encontraron los totales para cuadrar el balance.');
    else if (Math.abs(dif) <= Math.max(1000, base * 0.0005)) add('cuadre', 'Cuadre Activo = Pasivo + Capital', 'ok', 'El balance cuadra.');
    else if (base && Math.abs(dif) <= base * 0.01) add('cuadre', 'Cuadre Activo = Pasivo + Capital', 'warn', `Descuadre de ${money(dif)} (${((Math.abs(dif) / base) * 100).toFixed(2)}% del activo).`);
    else add('cuadre', 'Cuadre Activo = Pasivo + Capital', 'block', `Descuadre de ${money(dif)}: el balance extraído no cierra. Revisa totales y cuentas faltantes.`);

    const off = recon.sections.filter(s => s.section !== 'Estado de Resultados' && s.computedSum !== null && s.status !== 'ok');
    if (!off.length) add('detalle', 'Detalle suma a sus totales', 'ok', 'Activo, Pasivo y Capital suman a su total.');
    else add('detalle', 'Detalle suma a sus totales', off.some(s => s.status === 'divergence' || Math.abs(s.gap || 0) > Math.abs(s.extractedTotal || 1) * 0.05) ? 'warn' : 'info',
      off.map(s => `${s.section}: ${(s.gap || 0) > 0 ? 'faltan' : 'sobran'} ${money(Math.abs(s.gap || 0))}`).join(' · '));
  }

  // 2. Escala (miles vs pesos) contra el periodo previo
  const prev = nearestPrevious(stmt, history);
  const prevAssets = prev ? assetsOf(prev) : null;
  if (hasBalance && assets && prevAssets) {
    const r = assets / prevAssets;
    if (r > 50 || r < 1 / 50) add('escala', 'Escala consistente', 'block', `El activo total es ${ratioText(r)} el del periodo previo: probable error de escala (miles vs pesos).`);
    else if (r > 8 || r < 1 / 8) add('escala', 'Escala consistente', 'warn', `El activo total cambió ${ratioText(r)} contra el periodo previo.`);
    else add('escala', 'Escala consistente', 'ok', `Activo total ${ratioText(r)} vs. periodo previo.`);
  } else add('escala', 'Escala consistente', 'info', 'Sin periodo previo para comparar escala.');
  const nonZero = items.filter(i => Math.abs(i.value as number) >= 1);
  const roundedThousands = nonZero.length >= 10 && nonZero.filter(i => Math.abs((i.value as number) % 1000) < 0.5).length / nonZero.length >= 0.9;
  if (roundedThousands && prev && (prev.rawLineItems || []).filter(i => typeof i.value === 'number' && Math.abs(i.value as number) >= 1).some(i => Math.abs((i.value as number) % 1000) >= 0.5)) {
    add('miles', 'Cifras en miles', 'warn', 'Casi todas las cifras son múltiplos de 1,000 y el periodo previo trae centavos: puede venir en miles.');
  }

  // 3. Signos
  if (!hasBalance) add('signos', 'Signos y totales', 'info', 'Sin balance general: no se valida el total de activo.');
  else if (assets === null || assets === 0) add('signos', 'Signos y totales', 'warn', 'No se encontró el total de activo: el balance no se puede validar.');
  else if (assets < 0) add('signos', 'Signos y totales', 'block', 'Total de activo negativo: signo invertido.');
  else {
    const revenue = getMetric(stmt as FinancialStatement_DB, 'revenue');
    const contra = /(depreciacion|amortizacion|estimacion|reserva|deterioro|perdida|deficit|resultadodeejercicios|resultadosacumulados)/;
    const bs = items.filter(i => (i.statementType || 'balance_general') === 'balance_general' && /activo|pasivo/i.test(classifyAccount(i.statementType || 'balance_general', i.name, i.sectionPath)));
    const negatives = bs.filter(i => (i.value as number) < 0 && !contra.test(i.name.toLowerCase().normalize('NFD').replace(/[^a-z]/g, '')));
    if (revenue !== null && revenue < 0) add('signos', 'Signos y totales', 'warn', 'Ingresos negativos: revisa el signo del estado de resultados.');
    else if (bs.length >= 8 && negatives.length / bs.length > 0.25) add('signos', 'Signos y totales', 'warn', `${negatives.length} cuentas de balance negativas sin ser cuentas de contra-saldo.`);
    else add('signos', 'Signos y totales', 'ok', 'Signos consistentes.');
  }

  // 4. Periodo
  const labelMonth = (() => {
    const t = (stmt.period || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const names = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
    const idx = names.findIndex(n => t.includes(n));
    return idx >= 0 ? idx + 1 : null;
  })();
  const dateMonth = parseInt((stmt.periodDate || '').slice(5, 7), 10) || null;
  const date = stmt.periodDate ? new Date(stmt.periodDate).getTime() : NaN;
  if (!Number.isFinite(date) || date < new Date('2000-01-01').getTime()) add('periodo', 'Periodo', 'block', 'La fecha del periodo no es válida.');
  else if (date > Date.now() + 40 * 86400000) add('periodo', 'Periodo', 'warn', 'La fecha del periodo está en el futuro.');
  else if (labelMonth && dateMonth && labelMonth !== dateMonth) add('periodo', 'Periodo', 'warn', `La etiqueta dice mes ${labelMonth} pero la fecha corresponde al mes ${dateMonth}.`);
  else add('periodo', 'Periodo', 'ok', 'Etiqueta y fecha coinciden.');
  if (history.some(h => h.periodDate === stmt.periodDate && h.id !== stmt.id)) add('duplicado', 'Periodo repetido', 'info', 'Ya existe este periodo: las cuentas se combinarán con las guardadas.');

  // 5. Coherencia entre periodos
  if (prev) {
    const sameYear = prev.periodDate.slice(0, 4) === stmt.periodDate.slice(0, 4);
    const rev = getMetric(stmt as FinancialStatement_DB, 'revenue');
    const prevRev = getMetric(prev as FinancialStatement_DB, 'revenue');
    const issues: string[] = [];
    if (hasBalance && assets && prevAssets && (assets / prevAssets > 3 || assets / prevAssets < 1 / 3) && assets / prevAssets <= 50 && assets / prevAssets >= 1 / 50) issues.push(`activo ${ratioText(assets / prevAssets)} vs. periodo previo`);
    if (sameYear && rev !== null && prevRev !== null && prevRev > 0 && rev < prevRev * 0.9) issues.push('ingresos del año bajan contra el periodo previo (si es acumulado debería subir)');
    if (sameYear) {
      const eq = getMetric(stmt as FinancialStatement_DB, 'equity'); const prevEq = getMetric(prev as FinancialStatement_DB, 'equity');
      const ni = getMetric(stmt as FinancialStatement_DB, 'netIncome'); const prevNi = getMetric(prev as FinancialStatement_DB, 'netIncome');
      if (eq !== null && prevEq !== null && ni !== null && prevNi !== null && assets) {
        const expected = prevEq + (ni - prevNi);
        if (Math.abs(eq - expected) > Math.max(Math.abs(prevEq) * 0.05, assets * 0.02)) issues.push(`capital ${money(eq)} no se explica por el capital previo + resultado del periodo (esperado ≈ ${money(expected)}; pueden ser aportaciones o dividendos)`);
      }
    }
    add('coherencia', 'Coherencia con el periodo previo', issues.length ? 'warn' : 'ok', issues.length ? issues.join('; ') + '.' : `Consistente con ${prev.period}.`);
  } else add('coherencia', 'Coherencia con el periodo previo', 'info', 'Primer periodo cargado: sin comparación.');

  // 6. Cobertura de datos
  const missing: string[] = [];
  (['totalAssets', 'equity', 'revenue', 'netIncome'] as const).filter(k => (k === 'totalAssets' || k === 'equity') ? hasBalance : hasIncome).forEach(k => { const v = getMetric(stmt as FinancialStatement_DB, k); if (v === null || v === 0) missing.push({ totalAssets: 'activo total', equity: 'capital', revenue: 'ingresos', netIncome: 'utilidad neta' }[k]); });
  const unclassified = items.filter(i => classifyAccount(i.statementType || 'otro', i.name, i.sectionPath) === 'Balance General sin clasificar').length;
  const zeros = items.filter(i => Math.abs(i.value as number) < 0.5).length;
  const coverageIssues: string[] = [];
  if (items.length < 15) coverageIssues.push(`solo ${items.length} cuentas extraídas`);
  if (missing.length) coverageIssues.push(`faltan ${missing.join(', ')}`);
  if (items.length && unclassified / items.length > 0.1) coverageIssues.push(`${unclassified} cuentas sin clasificar`);
  if (items.length >= 10 && zeros / items.length > 0.25) coverageIssues.push(`${Math.round((zeros / items.length) * 100)}% de las cuentas en cero`);
  add('cobertura', 'Cobertura de datos', coverageIssues.length ? 'warn' : 'ok', coverageIssues.length ? coverageIssues.join('; ') + '.' : `${items.length} cuentas con los datos clave presentes.`);

  const blocking = checks.some(c => c.severity === 'block');
  const penalty = checks.reduce((sum, c) => sum + (c.severity === 'block' ? 40 : c.severity === 'warn' ? 9 : 0), 0);
  const score = Math.max(0, 100 - penalty);
  const level: QualityLevel = blocking ? 'bloqueada' : score >= 85 ? 'alta' : score >= 65 ? 'media' : 'baja';
  return { score, level, blocking, checks };
}

export const isQuarantined = (record?: Pick<StatementQualityRecord, 'status'> | null) => record?.status === 'en_revision';

export function usableStatements<T extends { id: string }>(statements: T[], records: Record<string, StatementQualityRecord | undefined>): T[] {
  return statements.filter(s => !isQuarantined(records[s.id]));
}

export const QUALITY_LABEL: Record<QualityLevel, string> = { alta: 'Confianza alta', media: 'Confianza media', baja: 'Confianza baja', bloqueada: 'Bloqueada' };

export function formatDuration(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  return s < 90 ? `${s.toFixed(s < 10 ? 1 : 0)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

// Loan-tape import confidence: how sure are we that the columns were understood and the data is usable.
export interface LoanTapeQuality { score: number; level: 'alta' | 'media' | 'baja'; extractionMs?: number; rows: number; notes: string[] }
export function assessLoanTapeImport(input: {
  mappingReport: Array<{ confidence: 'high' | 'medium' | 'low' }>;
  readinessScore: number;
  rows: number;
  missingCritical: string[];
  blocker: boolean;
  extractionMs?: number;
}): LoanTapeQuality {
  const notes: string[] = [];
  const conf = input.mappingReport.length
    ? input.mappingReport.reduce((s, m) => s + (m.confidence === 'high' ? 1 : m.confidence === 'medium' ? 0.65 : 0.3), 0) / input.mappingReport.length
    : 0;
  let score = Math.round(conf * 55 + (input.readinessScore / 100) * 45);
  if (input.missingCritical.length) { score -= 12 * input.missingCritical.length; notes.push(`Faltan campos críticos: ${input.missingCritical.join(', ')}.`); }
  if (input.blocker) { score -= 25; notes.push('La conciliación del archivo marcó un bloqueo (hojas con datos sin leer o saldo inconsistente).'); }
  if (input.mappingReport.some(m => m.confidence === 'low')) notes.push('Hay columnas mapeadas con baja confianza: revísalas.');
  score = Math.max(0, Math.min(100, score));
  return { score, level: score >= 80 ? 'alta' : score >= 55 ? 'media' : 'baja', extractionMs: input.extractionMs, rows: input.rows, notes };
}
