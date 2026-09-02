import assert from 'node:assert/strict';
import test from 'node:test';
import { importLoanTapeSheets, type SheetInput } from '../src/lib/loanTapeImport';

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

const cofinePortfolio: SheetInput = {
  name: 'PORTAFOLIO',
  rows: [
    ['Id cliente', 'Número de Préstamo Intermediario ', 'Fecha de  Otorgamiento (dd/mm/aaaa)', 'Monto Otorgado  (pesos)', 'Indicador Moneda Extranjera', 'Plazo  Original (meses)', 'Tasa base ANUAL de interés', 'Tasa / Sobretasa Acreditado', 'Capital Vigente (pesos)', 'Intereses Vigentes (pesos)', 'Capital Moroso y vencido (pesos)', 'Intereses Morosos y vencidos (pesos)', 'Saldo Total (pesos)', 'Meses vencidos a "x" fecha', 'Tipo de Crédito', 'Días de Vencidos.', 'Estatus del Crédito', 'Sector'],
    [20, '020-01-01-002-36', '07/01/2026', 1000000, '', 6, 'TIIE', 6, 677388.6, 2625.64, 0, 0, 680014.24, 0, 'C SIMPLE', 0, 'VIGENTE', 'Comercio'],
    [24, '024-01-02-002-01', '08/08/2025', 6000000, '', 37, 'F', 13, 5000000, 49833.33, 100000, 1000, 5150833.33, 2, 'C CUENTA CORRIENTE', 45, 'MOROSO', 'Servicios'],
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

test('cofine: reads PORTAFOLIO granular tape and uses Saldo Total', () => {
  const res = importLoanTapeSheets([cofinePortfolio], '260630 - LT Jun 26 - COFINE.xlsx');
  assert.equal(res.standardized.length, 2);
  assert.equal(res.reconciliation.totalBalance, 5830847.57);
  assert.equal(res.reconciliation.sheets[0].profile, 'COFINE_PORTAFOLIO');
  assert.notEqual(res.reconciliation.severity, 'blocker');
  assert.equal(res.standardized[0].loan_id, '020-01-01-002-36');
  assert.equal(res.standardized[0].loan_type, 'C SIMPLE');
  assert.equal(res.standardized[0].file_date, '2026-06-30');
  assert.equal(res.standardized[1].loan_status, 'MOROSO');
});

test('cofine: repairs YYDDMM filename dates such as 253112', () => {
  const res = importLoanTapeSheets([cofinePortfolio], '253112_LT Dic 25_COFINE.xlsx');
  assert.equal(res.standardized[0].file_date, '2025-12-31');
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
