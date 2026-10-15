// Historial mensual del fondeo institucional (Pasivos Institucionales).
//
// Cada corte guarda el saldo por acreedor (la "segregación del pasivo" que entrega el cliente). Con dos o más cortes se
// ve la variación mes a mes por acreedor, la concentración, y se cruza contra el balance (préstamos bancarios del mismo
// mes) y contra la cartera del loan tape del mismo corte. Se guarda por cliente en client_settings (sin migración).

import { db, type FinancialStatement_DB } from '../db/index';
import { getMetric } from './financialMetrics';
import { tapePointForPeriod, isTapePointUsable } from './tapePortfolioCache';

export const LIABILITY_HISTORY_KEY = 'finmonitor_liability_history';

export type LiabilityTerm = 'corto' | 'largo' | '';

export interface LiabilityLine { lender: string; term: LiabilityTerm; balance: number }
export interface LiabilitySnapshot {
  cutoff: string;               // YYYY-MM-DD
  source?: string;              // documento de origen
  lines: LiabilityLine[];       // fondeo institucional por acreedor (en pesos)
  totalLiabilities?: number | null;   // total del pasivo del documento (contexto)
  composition?: { fondeo: number; impuestos: number; operativo: number; empleados: number; otro: number };   // del desglose (reglas)
  createdAt: string;
}
export interface LiabilityHistoryStore { snapshots: LiabilitySnapshot[] }

export async function loadLiabilityHistory(clientId: string): Promise<LiabilityHistoryStore> {
  const v = await db.getClientSetting<LiabilityHistoryStore>(clientId, LIABILITY_HISTORY_KEY, { snapshots: [] }).catch(() => ({ snapshots: [] }));
  return { snapshots: Array.isArray(v?.snapshots) ? v.snapshots : [] };
}

export async function saveLiabilityHistory(clientId: string, store: LiabilityHistoryStore): Promise<void> {
  await db.setClientSetting(clientId, LIABILITY_HISTORY_KEY, store);
}

// Un corte nuevo reemplaza al del mismo mes (corrección), nunca a otro mes.
export function upsertSnapshot(store: LiabilityHistoryStore, snap: LiabilitySnapshot): LiabilityHistoryStore {
  const month = snap.cutoff.slice(0, 7);
  return { snapshots: [...store.snapshots.filter(s => s.cutoff.slice(0, 7) !== month), snap].sort((a, b) => a.cutoff.localeCompare(b.cutoff)) };
}

const key = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

export interface LenderSeries { lender: string; term: LiabilityTerm; balances: Array<number | null>; delta: number | null; deltaPct: number | null; share: number }
export interface HistoryCheck { cutoff: string; label: string; ok: boolean | null; detail: string }
export interface LiabilityHistoryAnalysis {
  cutoffs: string[];
  totals: number[];
  lenders: LenderSeries[];
  latest: { cutoff: string; total: number; delta: number | null; deltaPct: number | null; lenders: number; topLender: string | null; topShare: number; hhi: number } | null;
  portfolio: Array<{ cutoff: string; portfolio: number | null; ratio: number | null }>;   // cartera VIGENTE del loan tape / fondeo (aforo vigente)
  checks: HistoryCheck[];
  impliedCost: Array<{ from: string; to: string; rate: number }>;   // costo de fondeo implícito (anualizado)
  insights: string[];
}

const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
const money = (v: number) => (Math.abs(v) >= 1e6 ? `$${(v / 1e6).toLocaleString('es-MX', { maximumFractionDigits: 2 })}M` : `$${Math.round(v).toLocaleString('es-MX')}`);
const sameMonth = (a: string, b: string) => a.slice(0, 7) === b.slice(0, 7);

export function analyzeLiabilityHistory(clientId: string, store: LiabilityHistoryStore, statements: FinancialStatement_DB[] = []): LiabilityHistoryAnalysis {
  const snaps = [...store.snapshots].sort((a, b) => a.cutoff.localeCompare(b.cutoff));
  const cutoffs = snaps.map(s => s.cutoff);
  const totals = snaps.map(s => s.lines.reduce((a, l) => a + (l.balance || 0), 0));

  // Un acreedor = mismo nombre normalizado en todos los cortes.
  const names = new Map<string, { lender: string; term: LiabilityTerm }>();
  snaps.forEach(s => s.lines.forEach(l => { const k = key(l.lender); if (!names.has(k)) names.set(k, { lender: l.lender, term: l.term }); }));
  const lastTotal = totals.at(-1) || 0;
  const lenders: LenderSeries[] = [...names.entries()].map(([k, meta]) => {
    const balances = snaps.map(s => { const hit = s.lines.filter(l => key(l.lender) === k); return hit.length ? hit.reduce((a, l) => a + l.balance, 0) : null; });
    const last = balances.at(-1) ?? null, prev = balances.length > 1 ? balances.at(-2) ?? null : null;
    const delta = last !== null && prev !== null ? last - prev : null;
    return { ...meta, balances, delta, deltaPct: delta !== null && prev ? delta / prev : null, share: last && lastTotal ? last / lastTotal : 0 };
  }).sort((a, b) => b.share - a.share);

  let latest: LiabilityHistoryAnalysis['latest'] = null;
  if (snaps.length) {
    const prevTotal = totals.length > 1 ? totals.at(-2)! : null;
    const live = lenders.filter(l => (l.balances.at(-1) || 0) > 0);
    latest = {
      cutoff: cutoffs.at(-1)!, total: lastTotal,
      delta: prevTotal !== null ? lastTotal - prevTotal : null, deltaPct: prevTotal ? (lastTotal - prevTotal) / prevTotal : null,
      lenders: live.length, topLender: live[0]?.lender || null, topShare: live[0]?.share || 0,
      hhi: live.reduce((a, l) => a + l.share * l.share, 0),
    };
  }

  // Fondeo vs cartera del loan tape del mismo corte (cuántas veces la cartera cubre el fondeo).
  const portfolio = snaps.map((s, i) => {
    const p = tapePointForPeriod(clientId, s.cutoff);
    // Aforo vigente = cartera vigente (0-30 días) ÷ fondeo; solo si el tape trae días de atraso.
    const bal = p && isTapePointUsable(p) ? p.vigente : null;
    return { cutoff: s.cutoff, portfolio: bal, ratio: bal && totals[i] ? bal / totals[i] : null };
  });

  // Cuadre contra el balance del mismo mes: la segregación debe coincidir con los préstamos del estado financiero.
  const checks: HistoryCheck[] = [];
  snaps.forEach((s, i) => {
    const st = statements.find(x => sameMonth(x.periodDate, s.cutoff));
    if (!st) { checks.push({ cutoff: s.cutoff, label: 'Fondeo vs balance', ok: null, detail: 'Sin estado financiero de ese mes para cruzar' }); return; }
    const debt = getMetric(st, 'totalDebt');
    if (debt === null) { checks.push({ cutoff: s.cutoff, label: 'Fondeo vs balance', ok: null, detail: 'El balance no identifica deuda con costo' }); return; }
    const gap = totals[i] - Math.abs(debt);
    const ok = Math.abs(gap) <= Math.max(1000, Math.abs(debt) * 0.005);
    checks.push({ cutoff: s.cutoff, label: 'Fondeo vs balance', ok, detail: ok ? `Cuadra con la deuda del balance (${money(Math.abs(debt))})` : `Segregación ${money(totals[i])} vs balance ${money(Math.abs(debt))} (diferencia ${money(gap)})` });
  });

  // Costo de fondeo implícito: gasto por intereses del periodo ÷ saldo promedio, anualizado. Solo entre cortes del mismo
  // año con estado de resultados acumulado en ambos (el gasto del periodo = acumulado final − acumulado inicial).
  const impliedCost: LiabilityHistoryAnalysis['impliedCost'] = [];
  for (let i = 1; i < snaps.length; i++) {
    const a = snaps[i - 1].cutoff, b = snaps[i].cutoff;
    if (a.slice(0, 4) !== b.slice(0, 4)) continue;
    const sa = statements.find(x => sameMonth(x.periodDate, a)), sb = statements.find(x => sameMonth(x.periodDate, b));
    const ia = sa ? getMetric(sa, 'interestExpense') : null, ib = sb ? getMetric(sb, 'interestExpense') : null;
    if (ia === null || ib === null || ib <= ia) continue;
    const months = (Number(b.slice(5, 7)) - Number(a.slice(5, 7))) || 1;
    const avg = (totals[i] + totals[i - 1]) / 2;
    if (avg > 0) impliedCost.push({ from: a, to: b, rate: ((ib - ia) / avg) * (12 / months) });
  }

  // Lectura en lenguaje claro (ruta: qué pasó, concentración, cobertura, qué falta).
  const insights: string[] = [];
  if (latest) {
    if (latest.delta !== null) insights.push(`El fondeo institucional ${latest.delta < 0 ? 'bajó' : latest.delta > 0 ? 'subió' : 'no cambió'} ${money(Math.abs(latest.delta))} (${pct(Math.abs(latest.deltaPct || 0))}) vs el corte anterior: ${money(lastTotal)} al ${latest.cutoff}.`);
    const movers = lenders.filter(l => l.delta !== null && Math.abs(l.delta) > 0).sort((x, y) => Math.abs(y.delta!) - Math.abs(x.delta!)).slice(0, 3);
    if (movers.length) insights.push(`Movimientos: ${movers.map(l => `${l.lender} ${l.delta! < 0 ? '−' : '+'}${money(Math.abs(l.delta!))}${l.deltaPct !== null ? ` (${l.deltaPct < 0 ? '−' : '+'}${pct(Math.abs(l.deltaPct))})` : ''}`).join(' · ')}.`);
    if (latest.topLender) insights.push(`${latest.topLender} concentra ${pct(latest.topShare)} del fondeo${latest.topShare >= 0.6 ? ' — dependencia alta de un solo fondeador' : latest.topShare >= 0.35 ? ' — concentración moderada' : ''}.`);
    const newL = lenders.filter(l => l.balances.at(-1) && l.balances.length > 1 && l.balances.at(-2) === null);
    const gone = lenders.filter(l => l.balances.length > 1 && l.balances.at(-1) === null && l.balances.at(-2));
    if (newL.length) insights.push(`Fondeador nuevo: ${newL.map(l => l.lender).join(', ')}.`);
    if (gone.length) insights.push(`Ya no aparece: ${gone.map(l => l.lender).join(', ')} (liquidado o no reportado).`);
    const lastP = portfolio.at(-1);
    if (lastP?.ratio) insights.push(`Aforo vigente ${lastP.ratio.toFixed(2)}x: la cartera vigente (0-30 días) del loan tape, ${money(lastP.portfolio!)}, cubre ${lastP.ratio.toFixed(2)} veces el fondeo institucional.`);
    else insights.push('Falta el loan tape de ese corte (con días de atraso) para medir el aforo vigente.');
    const lastCheck = checks.at(-1);
    if (lastCheck?.ok === false) insights.push(`⚠ ${lastCheck.detail}.`);
    const comp = snaps.at(-1)?.composition; const totalL = snaps.at(-1)?.totalLiabilities;
    if (comp && totalL) insights.push(`Del pasivo total (${money(totalL)}), el fondeo con costo es ${pct(comp.fondeo / totalL)}; el resto no es fondeo: impuestos ${money(comp.impuestos)}, operativo ${money(comp.operativo)}, empleados ${money(comp.empleados)}${comp.otro ? `, sin clasificar ${money(comp.otro)}` : ''}.`);
    if (snaps.length === 1) insights.push('Con el siguiente corte se calcula la variación mes a mes por acreedor.');
  }
  return { cutoffs, totals, lenders, latest, portfolio, checks, impliedCost, insights };
}

// ── Excel (mismo estilo Axcess que el resto de reportes) ─────────────────────────────────────────────────────────────
import type { SheetDef } from './export';
import { F, FMT, SheetBuilder, type ColFmt } from './loanTapeReport';
import { AXC } from './xlsxCharts';

const TERM_LABEL: Record<LiabilityTerm, string> = { corto: 'Corto plazo', largo: 'Largo plazo', '': '' };

export function buildLiabilityHistorySheets(clientName: string, a: LiabilityHistoryAnalysis): SheetDef[] {
  const s = new SheetBuilder('Historial fondeo', [34, 14, ...a.cutoffs.map(() => 16), 16, 12, 12]);
  s.title(`HISTORIAL DEL FONDEO INSTITUCIONAL — ${clientName.toUpperCase()}`);
  s.text(`Cortes: ${a.cutoffs.join(' · ')} · Generado por FinMonitor`);
  s.blank();
  const fmts: ColFmt[] = [undefined, undefined, ...a.cutoffs.map(() => 'money' as ColFmt), 'money', 'pct', 'pct'];
  const t = s.table('SALDO POR ACREEDOR Y CORTE', ['Acreedor', 'Plazo', ...a.cutoffs, 'Variación último mes', 'Variación %', '% del fondeo'],
    a.lenders.map(l => [l.lender, TERM_LABEL[l.term], ...l.balances.map(v => v ?? 0), l.delta ?? 0, l.deltaPct ?? 'N/D', l.share]), fmts,
    ['TOTAL', '', ...a.totals, a.latest?.delta ?? 0, a.latest?.deltaPct ?? 'N/D', 1], { sum: a.cutoffs.map((_, i) => i + 2) });
  if (a.cutoffs.length > 1) s.chart(t, { title: 'Saldo por acreedor y corte', kind: 'column', series: a.cutoffs.map((c, i) => ({ col: 2 + i, name: c, color: [AXC.sky, AXC.blue, AXC.deep, AXC.cyan, AXC.ink][i % 5] })), yFmt: '$#,##0' });
  s.blank();
  s.table('AFORO VIGENTE (CARTERA VIGENTE DEL LOAN TAPE / FONDEO)', ['Corte', 'Fondeo institucional', 'Cartera vigente (0-30 días)', 'Aforo vigente (x)'],
    a.portfolio.map((p, i) => [p.cutoff, a.totals[i], p.portfolio ?? 'N/D', p.ratio === null ? 'N/D' : F(p.ratio, FMT.dec2)]), [undefined, 'money', 'money', 'dec2']);
  s.blank();
  s.table('CUADRE CONTRA EL BALANCE', ['Corte', 'Revisión', 'Resultado', 'Detalle'], a.checks.map(c => [c.cutoff, c.label, c.ok === null ? 'Sin dato' : c.ok ? 'Cuadra' : 'No cuadra', c.detail]), [undefined, undefined, undefined, undefined]);
  if (a.impliedCost.length) {
    s.blank();
    s.table('COSTO DE FONDEO IMPLÍCITO (ANUALIZADO)', ['Desde', 'Hasta', 'Tasa'], a.impliedCost.map(c => [c.from, c.to, F(c.rate, FMT.pct2)]), [undefined, undefined, 'pct2']);
  }
  s.blank();
  s.sub('LECTURA');
  a.insights.forEach(i => s.text(`• ${i}`));
  return [s.done()];
}
