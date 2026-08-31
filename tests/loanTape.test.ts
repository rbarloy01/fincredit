import assert from 'node:assert/strict';
import test from 'node:test';
import { importLoanTapeSheets, type SheetInput } from '../src/lib/loanTapeImport';
import { analyzeLoanTapesLocally, buildLoanTapeDataProfile, loanTapePeriodDate, sortLoanTapesByPeriod } from '../src/lib/loanTapeAnalytics';

// SIAC-style sheet: two title rows, header on row index 2, one vigente + one vencida loan.
const siac: SheetInput = {
  name: 'SIAC',
  rows: [
    ['ESTADO DE CLIENTES'],
    ['FECHA AL', '30/06/2026'],
    ['Clave de Cliente', 'No. de Crédito', 'Nombre (s)', 'Monto', 'Capital vigente', 'Capital Vencido', 'Tasa', 'Fecha de otorgamiento', 'Fecha de vencimiento', 'Tipo de contrato', 'Días de Atraso', 'Estado'],
    ['001', 'A/1', 'CLIENTE UNO', 1000000, 1500000, 0, '30%', '2024-01-01', '2027-01-01', 'ARRENDAMIENTO', 0, 'JALISCO'],
    ['002', 'A/2', 'CLIENTE DOS', 800000, 100000, 300000, '30%', '2023-01-01', '2026-12-01', 'ARRENDAMIENTO', 200, 'JALISCO'],
  ],
};
// CAUDEX-style sheet: header on row 0, one vigente loan.
const caudex: SheetInput = {
  name: 'CAUDEX',
  rows: [
    ['No. Cliente', 'Nombre Cliente', 'No. Cuenta', 'Importe Dispuesto', 'Capital Vigente', 'Capital Vencido', 'Tasa Final', 'Fecha Apertura', 'Fecha Vencimiento', 'Descripcion Producto', 'Días de atraso', 'Descripcion Estado'],
    [100, 'CLIENTE CAUDEX', 5001, 2000000, 1000000, 0, 30, '2025-12-01', '2028-12-01', 'ARRENDAMIENTO MXN', 0, 'NUEVO LEON'],
  ],
};

test('golden: reads BOTH sheets (SIAC + CAUDEX) and merges the portfolio', () => {
  const res = importLoanTapeSheets([siac, caudex], '260630 - LT - Test');
  // 2 SIAC + 1 CAUDEX
  assert.equal(res.standardized.length, 3);
  // outstanding = capVig + capVen: 1.5M + 0.4M (SIAC) + 1.0M (CAUDEX)
  assert.equal(res.reconciliation.totalBalance, 2900000);
  // vencida = balance of loans with dpd > 90 = only A/2 (400k)
  const vencida = res.standardized.filter(s => (s.days_overdue ?? 0) > 90).reduce((a, s) => a + (s.outstanding_balance || 0), 0);
  assert.equal(vencida, 400000);
  // both sheets recognized, nothing left unread
  const profiles = res.reconciliation.sheets.map(s => s.profile).sort();
  assert.deepEqual(profiles, ['CAUDEX', 'SIAC']);
  assert.equal(res.reconciliation.unmappedSheetsWithData.length, 0);
  assert.equal(res.reconciliation.severity, 'ok');
  // file_date parsed from filename (month-end)
  assert.equal(res.standardized[0].file_date, '2026-06-30');
  // rate normalized to decimal
  assert.equal(res.standardized[0].interest_rate, 0.3);
});

test('guardrail: a data sheet no profile can read → blocker', () => {
  const mystery: SheetInput = { name: 'Hoja2', rows: [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16]] };
  const res = importLoanTapeSheets([siac, mystery], '260630 - LT - Test');
  assert.equal(res.reconciliation.severity, 'blocker');
  assert.equal(res.reconciliation.unmappedSheetsWithData.length, 1);
  assert.deepEqual(res.reconciliation.unmappedSheetsWithData, ['Hoja2']);
});

test('MoM sanity: a big balance drop vs previous total raises a warning', () => {
  const res = importLoanTapeSheets([siac, caudex], '260630 - LT - Test', { previousTotal: 6000000 });
  // 2.9M vs 6.0M ≈ -52% → warning
  assert.equal(res.reconciliation.severity, 'warning');
});

test('generic semantic mapper understands ordered tables with non-standard headers', () => {
  const custom: SheetInput = {
    name: 'Servicer custom',
    rows: [
      ['ID Operación', 'Nombre Acreditado', 'Línea autorizada', 'Saldo actual', 'TNA %', 'Apertura', 'Vence', 'Modalidad', 'Mora', 'Entidad'],
      ['OP-1', 'ACME SA', 1500000, 1200000, '24%', '2025-01-15', '2027-01-15', 'Credito simple', 0, 'Nuevo Leon'],
      ['OP-2', 'BETA SA', 800000, 500000, '28%', '2024-06-01', '2026-06-01', 'Factoraje', 120, 'Jalisco'],
    ],
  };
  const res = importLoanTapeSheets([custom], '20260831 custom loan tape');
  assert.equal(res.standardized.length, 2);
  assert.equal(res.reconciliation.severity, 'ok');
  assert.equal(res.standardized[0].loan_id, 'OP-1');
  assert.equal(res.standardized[0].client, 'ACME SA');
  assert.equal(res.standardized[0].amount, 1500000);
  assert.equal(res.standardized[0].outstanding_balance, 1200000);
  assert.equal(res.standardized[0].interest_rate, 0.24);
  assert.equal(res.standardized[0].days_overdue, 0);
  assert.equal(res.standardized[0].state, 'Nuevo Leon');
  assert.equal(res.standardized[1].loan_type, 'Factoraje');
});

test('analysis stays available with optional fields missing and formats rates as percentages', () => {
  const partial: SheetInput = {
    name: 'COFINE partial',
    rows: [
      ['Contrato', 'Acreditado', 'Saldo insoluto', 'Mora', 'Tasa'],
      ['CF-1', 'CLIENTE UNO', 1200000, 0, '24%'],
      ['CF-2', 'CLIENTE DOS', 300000, 120, '30%'],
    ],
  };
  const res = importLoanTapeSheets([partial], '20260831 COFINE');
  const profile = buildLoanTapeDataProfile(res.standardized, res.mappingReport);
  assert.equal(profile.canAnalyze, true);
  assert.equal(profile.readinessScore, 100);
  assert.ok(profile.availableAnalyses.some(item => item.key === 'dpd_quality'));
  assert.ok(profile.blockedAnalyses.some(item => item.key === 'product_mix'));
  assert.deepEqual(profile.unmappedCriticalFields, []);

  const analysis = analyzeLoanTapesLocally([{
    id: 'lt1',
    clientId: 'c1',
    name: 'COFINE',
    fileName: '20260831 COFINE.xlsx',
    tapeType: 'credito',
    uploadDate: '2026-08-31',
    extractedData: { _standardized: res.standardized, _mappingReport: res.mappingReport },
  } as any], 'lt1');
  assert.equal(analysis.metrics.find(item => item.name === 'Tasa ponderada por saldo')?.latestValue, '25.2%');
});

test('COFINE profile maps real portfolio headers without confusing money columns for DPD', () => {
  const cofine: SheetInput = {
    name: 'PORTAFOLIO',
    rows: [
      [
        'Id cliente',
        'Número de Préstamo Intermediario ',
        'Fecha de  Otorgamiento (dd/mm/aaaa)',
        'Monto Otorgado  (pesos)',
        'Indicador Moneda Extranjera',
        'Plazo  Original (meses)',
        'Tasa base ANUAL de interés',
        'Tasa / Sobretasa Acreditado',
        'Capital Vigente (pesos)',
        'Intereses Vigentes (pesos)',
        'Capital Mosoro y vencido (pesos)',
        'Intereses Mosoros y vencidos (pesos)',
        'Saldo Total (pesos)',
        'Meses vencidos a "x" fecha',
        'Tipo de Crédito',
        'Días de Vencidos.',
        'Estatus del Crédito',
      ],
      ['3', '003 - 1', '19/03/2014', '8000000.00', '0', '180', 'TIIE', '7.50', '1911111.69', '6370.37', '.00', '.00', '1917482.06', '0', 'C SIMPLE', '0', 'VIGENTE'],
      ['24', '024 - 9', '15/01/2020', '5000000.00', '0', '60', 'TIIE', '10.00', '0.00', '0.00', '1000000.00', '0.00', '1000000.00', '4', 'C SIMPLE', '120', 'VENCIDO'],
    ],
  };

  const res = importLoanTapeSheets([cofine], '250831 - Cartera - COFINE.xlsx');
  const profile = buildLoanTapeDataProfile(res.standardized, res.mappingReport);
  const targetFor = (header: string) => res.mappingReport.find(item => item.source_header === header)?.target_term;

  assert.equal(res.reconciliation.severity, 'ok');
  assert.equal(res.standardized.length, 2);
  assert.equal(res.standardized[0].loan_id, '003 - 1');
  assert.equal(res.standardized[1].days_overdue, 120);
  assert.equal(res.standardized[1].outstanding_balance, 1000000);
  assert.equal(targetFor('Capital Mosoro y vencido (pesos)'), undefined);
  assert.equal(targetFor('Días de Vencidos.'), 'days_overdue');
  assert.equal(profile.readinessScore, 100);
  assert.equal(profile.highValidationCount, 0);

  const analysis = analyzeLoanTapesLocally([{
    id: 'lt-cofine',
    clientId: 'c1',
    name: 'COFINE',
    fileName: '250831 - Cartera - COFINE.xlsx',
    tapeType: 'credito',
    uploadDate: '2026-08-31',
    extractedData: { _standardized: res.standardized, _mappingReport: res.mappingReport },
  } as any], 'lt-cofine');

  assert.equal(analysis.metrics.find(item => item.name === 'Numero de creditos')?.latestValue, '2');
  assert.equal(analysis.metrics.find(item => item.name === 'DPD ponderado por saldo')?.latestValue, '41.2 dias');
});

test('loan tape period selection uses cutoff date instead of upload date', () => {
  const oldCutoffUploadedLater = {
    id: 'old-uploaded-later',
    fileName: '250831 - Cartera - COFINE.xlsx',
    uploadDate: '2026-08-31T21:50:09.932913+00:00',
    extractedData: { _standardized: [{ file_date: '2025-08-31' }] },
  };
  const newestCutoffUploadedEarlier = {
    id: 'newest-cutoff',
    fileName: '260630 - LT Jun 26 - COFINE.xlsx',
    uploadDate: '2026-08-31T21:48:45.761691+00:00',
    extractedData: { _standardized: [{ file_date: '2026-06-30' }] },
  };
  const textMonthCutoff = {
    id: 'dic-25',
    fileName: '253112_LT Dic 25_COFINE.xlsx',
    uploadDate: '2026-08-31T21:50:12.880182+00:00',
    extractedData: { _standardized: [] },
  };

  assert.equal(loanTapePeriodDate(textMonthCutoff as any), '2025-12-31');
  assert.equal(sortLoanTapesByPeriod([oldCutoffUploadedLater, newestCutoffUploadedEarlier] as any[])[0].id, 'newest-cutoff');
});
