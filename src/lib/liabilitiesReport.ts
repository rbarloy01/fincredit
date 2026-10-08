// Reporte de pasivos institucionales: workbook estilo Axcess con gráficas nativas,
// mismo formato que el reporte de cartera (loanTapeReport.ts) para que ambos se lean igual.

import type { SheetDef } from './export';
import type { InstitutionalLiability_DB } from '../db/index';
import { AXC } from './xlsxCharts';
import { F, FMT, SheetBuilder, type ColFmt } from './loanTapeReport';
import { analyzeLiabilities, buildLiabilitiesInsights, type LiabilityInsight } from './institutionalLiabilitiesAnalytics';
import type { AssetLiabilityAnalysis } from './assetLiabilityAnalysis';

const SERIES = [AXC.deep, AXC.cyan, AXC.blue, AXC.sky, AXC.ink, AXC.muted, '7A5CFF', '00A3A3'];
const STATUS_LABEL = { vigente: 'Vigente', vence_12m: 'Vence ≤12m', vencida: 'Vencida', sin_fecha: 'Sin fecha' } as const;
const LEVEL = { critical: 'ALERTA', warning: 'ATENCIÓN', info: 'INFO' } as const;
const PILL = {
  critical: { fill: 'FDECEB', font: AXC.red }, warning: { fill: 'FFF4DB', font: '9A6B00' }, info: { fill: 'EAF0FF', font: AXC.deep },
};

export function buildLiabilitiesReportSheets(
  clientName: string,
  liabilities: InstitutionalLiability_DB[],
  assetLiability: AssetLiabilityAnalysis | null = null,
): SheetDef[] {
  if (!liabilities.length) return [{ name: 'Resumen', rows: [['Sin pasivos institucionales para reportar.']] }];
  const a = analyzeLiabilities(liabilities);
  const k = a.kpi;
  const sheets: SheetDef[] = [];

  // 1 — Portada ---------------------------------------------------------------
  {
    const s = new SheetBuilder('Portada', [36, 20, 16]);
    s.title(`REPORTE DE PASIVOS INSTITUCIONALES — ${clientName.toUpperCase()}`);
    s.text(`Fecha de análisis: ${a.asOf} · ${k.facilities} facilities con ${k.lenders} fondeadores · Generado por FinMonitor`);
    s.blank();
    const kp: Array<[string, number | null, ColFmt]> = [
      ['Saldo total de pasivos', k.totalBalance, 'money'],
      ['Monto original / líneas autorizadas', k.totalOriginal, 'money'],
      ['Disponible en líneas de crédito', k.available, 'money'],
      ['Utilización (saldo / monto original)', k.utilization, 'pct'],
      ['Tasa pasiva ponderada', k.waRate, 'pct2'],
      ['Costo financiero anual estimado', k.annualInterest, 'money'],
      ['Plazo remanente ponderado (meses)', k.waRemainingMonths, 'dec1'],
      ['Vence en ≤ 12 meses', k.due12mBalance, 'money'],
      ['   % del saldo', k.due12mPct, 'pct'],
      ['Saldo con vencimiento pasado', k.overdueBalance, 'money'],
      ['Top 1 fondeador %', k.top1Pct, 'pct'],
      ['Top 3 fondeadores %', k.top3Pct, 'pct'],
      ['HHI (fondeadores)', k.hhi, 'dec2'],
      ['% en moneda extranjera', k.fxPct, 'pct'],
    ];
    if (assetLiability) {
      kp.push(
        ['Tasa activa ponderada (cartera vigente)', assetLiability.asset.waRate, 'pct2'],
        ['Spread activa − pasiva', assetLiability.spread, 'pct2'],
        ['Aforo: cartera vigente / pasivos (x)', assetLiability.aforoVigente, 'dec2'],
        ['Cobranza / servicio de deuda (x)', assetLiability.serviceCoverage, 'dec2'],
      );
    }
    s.table('INDICADORES CLAVE', ['Indicador', 'Valor'], kp.map(([n, v, f]) => [n, v === null ? 'N/D' : F(v, FMT[f || 'int'])]), []);
    s.blank();
    const tt = s.table('MEZCLA POR TIPO DE PASIVO', ['Tipo', 'Facilities', 'Saldo', '% saldo'], a.byType.map(b => [b.label, b.count, b.currentBalance, b.pctOfTotal]), [undefined, 'int', 'money', 'pct'],
      ['TOTAL', k.facilities, k.totalBalance, 1]);
    s.chart(tt, { title: 'Mezcla por tipo (% del saldo)', kind: 'doughnut', series: [{ col: 3, labels: true, pointColors: SERIES, fmt: '0.0%' }] });
    s.blank();
    const yt = s.table('VENCIMIENTOS POR AÑO', ['Año', 'Facilities', 'Saldo', '% saldo'], a.maturityByYear.map(b => [b.label, b.count, b.currentBalance, b.pctOfTotal]), [undefined, 'int', 'money', 'pct']);
    s.chart(yt, { title: 'Saldo por año de vencimiento', kind: 'column', series: [{ col: 2, labels: true, color: AXC.deep, fmt: '$#,##0' }], yFmt: '$#,##0' });
    sheets.push(s.done());
  }

  // 2 — Insights ---------------------------------------------------------------
  {
    const all: LiabilityInsight[] = [...(assetLiability?.insights || []), ...buildLiabilitiesInsights(liabilities)];
    const s = new SheetBuilder('Insights', [34, 12, 90, 70], AXC.cyan);
    s.title('INSIGHTS DE PASIVOS');
    s.text('Lectura automática y descriptiva (hechos, variaciones y umbrales). No sustituye el juicio crediticio.');
    s.blank();
    const ht = s.table('HALLAZGOS', ['Tema', 'Nivel', 'Detalle', 'Recomendación'], all.map(i => [i.title, LEVEL[i.severity], i.detail, i.recommendation]), []);
    sheets.push(s.done({ wrapColumns: [3, 4], freezeRows: 4, cellStyles: all.map((i, idx) => ({ row: ht.first + idx, col: 2, ...PILL[i.severity] })) }));
  }

  // 3 — Activo vs. pasivo --------------------------------------------------------
  if (assetLiability) {
    const al = assetLiability;
    const s = new SheetBuilder('Activo vs pasivo', [40, 18, 18, 18, 18, 18, 18], AXC.green);
    s.title(`ACTIVO vs. PASIVO — cartera ${al.portfolioLabel} contra fondeo institucional`);
    s.text('Cartera que cobra = vigente (0-30 DPD). Cobranza = cuota reportada o, si falta, capital lineal a vencimiento + interés. Servicio de deuda = calendario proyectado de pasivos + interés.');
    s.blank();
    s.table('COMPARATIVO', ['Concepto', 'Cartera (activo)', 'Pasivos', 'Diferencia / razón'], [
      ['Saldo', F(al.asset.saldo, FMT.money), F(al.liability.saldo, FMT.money), al.aforoTotal === null ? '' : F(al.aforoTotal, '0.00"x"')],
      ['Saldo vigente / aforo', F(al.asset.vigente, FMT.money), F(al.liability.saldo, FMT.money), al.aforoVigente === null ? '' : F(al.aforoVigente, '0.00"x"')],
      ['Tasa ponderada', al.asset.waRate === null ? 'N/D' : F(al.asset.waRate, FMT.pct2), al.liability.waRate === null ? 'N/D' : F(al.liability.waRate, FMT.pct2), al.spread === null ? '' : F(al.spread, '+0.00%;-0.00%')],
      ['Intereses anuales (ingreso vs. costo)', F(al.asset.annualInterestIncome, FMT.money), F(al.liability.annualInterest, FMT.money), F(al.annualMargin, FMT.money)],
      ['Cobertura de intereses', '', '', al.interestCoverage === null ? '' : F(al.interestCoverage, '0.00"x"')],
      [`Flujo mensual (cobranza ${al.asset.collectionsSource} vs. servicio deuda 12m)`, F(al.asset.monthlyCollections, FMT.money), F(al.liability.monthlyDebtService, FMT.money), al.serviceCoverage === null ? '' : F(al.serviceCoverage, '0.00"x"')],
      ['Plazo remanente ponderado (meses)', al.asset.waRemainingMonths === null ? 'N/D' : F(al.asset.waRemainingMonths, FMT.dec1), al.liability.waRemainingMonths === null ? 'N/D' : F(al.liability.waRemainingMonths, FMT.dec1), al.termGapMonths === null ? '' : F(al.termGapMonths, '+0.0;-0.0')],
    ], []);
    s.blank();
    const qt = s.table('GAP DE LIQUIDEZ POR TRIMESTRE', ['Trimestre', 'Capital cartera', 'Interés cartera', 'Capital pasivos', 'Interés pasivos', 'Flujo neto', 'Acumulado'],
      al.quarters.map(q => [q.label, q.assetPrincipal, q.assetInterest, q.liabilityPrincipal, q.liabilityInterest, q.net, q.cumulative]), [undefined, 'money', 'money', 'money', 'money', 'money', 'money']);
    s.chart(qt, {
      title: 'Cobranza vs. servicio de deuda', kind: 'column', grouping: 'stacked', yFmt: '$#,##0',
      series: [{ col: 1, color: AXC.green }, { col: 2, color: '7BC043' }, { col: 6, as: 'line', color: AXC.deep }],
    });
    s.chart(qt, { title: 'Pagos a fondeadores por trimestre', kind: 'column', grouping: 'stacked', yFmt: '$#,##0', slot: 1, series: [{ col: 3, color: AXC.red }, { col: 4, color: AXC.amber }] });
    s.blank();
    const lt = s.table('SPREAD POR FONDEADOR (tasa activa − tasa del fondeador)', ['Fondeador', 'Saldo', 'Tasa fondeador', 'Spread'],
      al.lenderSpreads.map(l => [l.lender, l.currentBalance, l.rate, l.spread]), [undefined, 'money', 'pct2', 'pct2']);
    s.chart(lt, { title: 'Spread por fondeador', kind: 'bar', series: [{ col: 3, labels: true, color: AXC.deep, fmt: '0.0%', pointColors: al.lenderSpreads.map(l => (l.spread ?? 0) < 0 ? AXC.red : AXC.deep) }], yFmt: '0%', rows: Math.max(15, al.lenderSpreads.length + 4) });
    sheets.push(s.done({ colorScales: [{ ref: `G${qt.first}:G${qt.last}`, color: AXC.green }] }));
  }

  // 4 — Concentraciones ---------------------------------------------------------
  {
    const s = new SheetBuilder('Concentraciones', [34, 12, 18, 18, 12, 12, 12, 14]);
    s.title('CONCENTRACIONES DE FONDEO');
    s.blank();
    const lt = s.table('POR FONDEADOR', ['Fondeador', 'Facilities', 'Monto original', 'Saldo', '% saldo', '% acumulado', 'Tasa pond.', 'Próx. vencimiento'],
      a.lenders.map(l => [l.lender, l.facilities, l.originalAmount, l.currentBalance, l.pctOfTotal, l.cumPct, l.waRate, l.nextMaturity || 'Sin fecha']),
      [undefined, 'int', 'money', 'money', 'pct', 'pct', 'pct2']);
    s.chart(lt, { title: 'Saldo por fondeador', kind: 'bar', series: [{ col: 3, color: AXC.deep, fmt: '$#,##0' }], yFmt: '$#,##0', rows: Math.max(17, a.lenders.length + 4) });
    s.blank();
    const tn = s.table('ACUMULADO TOP-N FONDEADORES', ['Grupo', 'Saldo', '% saldo'], a.topN.map(t => [t.label, t.currentBalance, t.pctOfTotal]), [undefined, 'money', 'pct']);
    s.chart(tn, { title: 'Concentración acumulada Top-N', kind: 'column', series: [{ col: 2, labels: true, color: AXC.blue, fmt: '0.0%' }], yFmt: '0%' });
    s.blank();
    const grp = (title: string, rows: typeof a.byType, chartTitle: string, color: string) => {
      if (!rows.length) return;
      const t = s.table(title, ['Concepto', 'Facilities', 'Saldo', '% saldo', 'Tasa pond.'], rows.map(b => [b.label, b.count, b.currentBalance, b.pctOfTotal, b.waRate]), [undefined, 'int', 'money', 'pct', 'pct2']);
      s.chart(t, { title: chartTitle, kind: 'bar', series: [{ col: 2, color, fmt: '$#,##0' }], yFmt: '$#,##0', rows: Math.max(15, rows.length + 4) });
      s.blank();
    };
    grp('POR TIPO DE PASIVO', a.byType, 'Saldo por tipo', AXC.deep);
    grp('POR MONEDA', a.byCurrency, 'Saldo por moneda', AXC.sky);
    grp('POR GARANTÍA', a.byGuarantee, 'Saldo por garantía', AXC.cyan);
    grp('POR ESQUEMA DE AMORTIZACIÓN', a.byScheme, 'Saldo por esquema de amortización', AXC.blue);
    sheets.push(s.done());
  }

  // 5 — Tasas y costo -------------------------------------------------------------
  {
    const s = new SheetBuilder('Tasas y costo', [34, 12, 18, 12, 14, 18]);
    s.title('TASAS Y COSTO DE FONDEO');
    s.blank();
    const rt = s.table('SALDO POR RANGO DE TASA', ['Rango', 'Facilities', 'Saldo', '% saldo', 'Tasa pond.'], a.rateBuckets.map(b => [b.label, b.count, b.currentBalance, b.pctOfTotal, b.waRate]), [undefined, 'int', 'money', 'pct', 'pct2'],
      ['TOTAL', k.facilities, k.totalBalance, 1, k.waRate]);
    s.chart(rt, { title: 'Saldo por rango de tasa', kind: 'column', series: [{ col: 2, color: AXC.deep, fmt: '$#,##0' }, { col: 3, as: 'line', secondary: true, color: AXC.cyan, fmt: '0.0%' }], yFmt: '$#,##0', y2Fmt: '0%' });
    s.blank();
    const ct = s.table('COSTO POR FONDEADOR', ['Fondeador', 'Facilities', 'Saldo', '% saldo', 'Tasa pond.', 'Costo anual estimado'],
      a.lenders.map(l => [l.lender, l.facilities, l.currentBalance, l.pctOfTotal, l.waRate, l.annualInterest]), [undefined, 'int', 'money', 'pct', 'pct2', 'money'],
      ['TOTAL', k.facilities, k.totalBalance, 1, k.waRate, k.annualInterest]);
    s.chart(ct, { title: 'Tasa ponderada por fondeador', kind: 'column', series: [{ col: 4, labels: true, color: AXC.deep, fmt: '0.0%' }], yFmt: '0%' });
    s.chart(ct, { title: 'Costo financiero anual por fondeador', kind: 'bar', series: [{ col: 5, color: AXC.cyan, fmt: '$#,##0' }], yFmt: '$#,##0', slot: 1 });
    sheets.push(s.done());
  }

  // 6 — Plazos y vencimientos ------------------------------------------------------
  {
    const s = new SheetBuilder('Plazos y vencimientos', [30, 12, 18, 12, 14]);
    s.title('PLAZOS Y VENCIMIENTOS');
    s.blank();
    const tb = s.table('PLAZO REMANENTE', ['Rango', 'Facilities', 'Saldo', '% saldo', 'Tasa pond.'], a.termBuckets.map(b => [b.label, b.count, b.currentBalance, b.pctOfTotal, b.waRate]), [undefined, 'int', 'money', 'pct', 'pct2'],
      ['TOTAL', k.facilities, k.totalBalance, 1, k.waRate]);
    s.chart(tb, { title: 'Saldo por plazo remanente', kind: 'column', series: [{ col: 2, color: AXC.deep, fmt: '$#,##0' }, { col: 3, as: 'line', secondary: true, color: AXC.cyan, fmt: '0.0%' }], yFmt: '$#,##0', y2Fmt: '0%' });
    s.blank();
    const qt = s.table('PAGOS DE CAPITAL PROYECTADOS POR TRIMESTRE', ['Trimestre', 'Capital', '% saldo', 'Saldo al cierre'], a.maturityByQuarter.map(q => [q.label, q.principal, q.pctOfTotal, q.endingBalance]), [undefined, 'money', 'pct', 'money']);
    s.chart(qt, { title: 'Capital a pagar por trimestre (próximos 8)', kind: 'column', series: [{ col: 1, color: AXC.deep, fmt: '$#,##0' }, { col: 3, as: 'line', secondary: true, color: AXC.red, fmt: '$#,##0' }], yFmt: '$#,##0', y2Fmt: '$#,##0' });
    s.blank();
    const yt = s.table('VENCIMIENTOS POR AÑO', ['Año', 'Facilities', 'Saldo', '% saldo'], a.maturityByYear.map(b => [b.label, b.count, b.currentBalance, b.pctOfTotal]), [undefined, 'int', 'money', 'pct']);
    s.chart(yt, { title: 'Saldo por año de vencimiento', kind: 'column', series: [{ col: 2, labels: true, color: AXC.blue, fmt: '$#,##0' }], yFmt: '$#,##0' });
    sheets.push(s.done());
  }

  // 7 — Calendario proyectado -------------------------------------------------------
  {
    const s = new SheetBuilder('Calendario proyectado', [22, 18, 12, 18]);
    s.title('CALENDARIO PROYECTADO DE AMORTIZACIÓN (36 meses)');
    s.text('Supuesto: capital lineal hasta el vencimiento según el esquema de amortización; sin esquema o línea revolvente = bullet al vencimiento.');
    if (a.unscheduledBalance > 0) s.text(`Saldo sin fecha de vencimiento (fuera del calendario): $${Math.round(a.unscheduledBalance).toLocaleString('es-MX')}`);
    s.blank();
    const mt = s.table('POR MES', ['Mes', 'Capital', '% saldo', 'Saldo al cierre'], a.monthlySchedule.map(m => [m.label, m.principal, m.pctOfTotal, m.endingBalance]), [undefined, 'money', 'pct', 'money']);
    s.chart(mt, { title: 'Amortización mensual y saldo remanente', kind: 'column', series: [{ col: 1, color: AXC.deep, fmt: '$#,##0' }, { col: 3, as: 'line', secondary: true, color: AXC.cyan, fmt: '$#,##0' }], yFmt: '$#,##0', y2Fmt: '$#,##0', rows: 24 });
    sheets.push(s.done({ freezeRows: 5 }));
  }

  // 8 — Detalle -----------------------------------------------------------------------
  {
    const s = new SheetBuilder('Detalle', [30, 20, 18, 18, 10, 12, 18, 14, 14, 14, 12, 16, 14, 24, 30]);
    s.title('DETALLE DE FACILITIES');
    s.blank();
    s.table('FACILITIES', ['Fondeador', 'Tipo', 'Monto original', 'Saldo', 'Moneda', 'Utilización', 'Disponible', 'Tasa', 'Referencia', 'Originación', 'Vencimiento', 'Meses remanentes', 'Estatus', 'Amortización / garantía', 'Notas'],
      a.facilities.map(f => {
        const l = f.liability;
        return [l.lenderName, f.typeLabel, l.originalAmount, l.currentBalance, l.currency || 'MXN', f.utilization, f.available, l.interestRate, l.rateDescription || '', l.originationDate || '', l.maturityDate || '', f.remainingMonths, STATUS_LABEL[f.status], [l.amortization, l.guarantee].filter(Boolean).join(' / '), l.notes || ''];
      }), [undefined, undefined, 'money', 'money', undefined, 'pct', 'money', 'pct2', undefined, undefined, undefined, 'dec1'],
      ['TOTAL', '', k.totalOriginal, k.totalBalance, '', k.utilization, k.available, k.waRate]);
    sheets.push(s.done({ freezeRows: 3, wrapColumns: [15] }));
  }

  // 9 — Calidad de datos ----------------------------------------------------------------
  {
    const s = new SheetBuilder('Calidad de datos', [34, 70], AXC.muted);
    s.title('CALIDAD DE DATOS');
    s.text('Campos faltantes por facility: completar mejora el calendario, el costo de fondeo y el cruce activo-pasivo.');
    s.blank();
    s.table('FALTANTES', ['Fondeador', 'Campos sin dato'], a.dataGaps.length ? a.dataGaps.map(g => [g.lender, g.missing.join(', ')]) : [['—', 'Sin faltantes']], []);
    sheets.push(s.done({ wrapColumns: [2] }));
  }

  return sheets;
}
