import { resolveDpd, DPD_PROXY_DAYS } from '../src/lib/portfolioRules';
import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyDpd, loanStatusFromDpd, reconcileQuality, DPD_BUCKET_DEFS } from '../src/lib/portfolioRules';
import { quality, dpdDistribution, storedAnalysisFor, type StandardLoan } from '../src/lib/loanTapeAnalytics';
import { buildCockpitData, periodQuality } from '../src/lib/loanTapeCockpit';
import { analyzePortfolio } from '../src/lib/loanTapeReport';

const loan = (id: number, dpd: number | null, balance: number): StandardLoan => ({
  loan_id: String(id), client: `C${id}`, amount: balance * 2, outstanding_balance: balance, interest_rate: 0.2, loan_status: null,
  start_date: '2025-01-01', end_date: '2027-01-01', loan_type: 'Arrendamiento', days_overdue: dpd, currency: 'MXN', industry: null, state: null, file_date: '2026-05-31',
});

// 0 días 600k · 1-30 360k · 31-90 30k · >90 10k  → vigente 96% al corriente 60% (el caso 99.8% vs 96.4%)
const rows: StandardLoan[] = [loan(1, 0, 600_000), loan(2, 12, 200_000), loan(3, 30, 160_000), loan(4, 45, 20_000), loan(5, 90, 10_000), loan(6, 120, 10_000)];

test('classification boundaries: 0-30 vigente, 31-89 atrasada, 90+ vencida, null = sin dato', () => {
  assert.equal(classifyDpd(0), 'vigente');
  assert.equal(classifyDpd(30), 'vigente');
  assert.equal(classifyDpd(31), 'atrasada');
  assert.equal(classifyDpd(89), 'atrasada');
  assert.equal(classifyDpd(90), 'vencida');
  assert.equal(classifyDpd(null), 'sin_dato');
  assert.equal(loanStatusFromDpd(30), 'Vigente');
  assert.equal(loanStatusFromDpd(31), 'Atrasado');
  assert.equal(loanStatusFromDpd(91), 'Vencido');
});

test('every screen reports the SAME vigente/atrasada/vencida (no 99.8% vs 96.4%)', () => {
  const analysis: any = quality(rows);
  const tapes: any[] = [{ id: 't', clientId: 'c', name: 't', uploadDate: '2026-06-01', fileName: '260531 - LT - Test.xlsx', tapeType: 'credito', extractedData: { _standardized: rows } }];
  const data = buildCockpitData(tapes);
  const cockpit = periodQuality(data, data.periods[0]);
  const report = analyzePortfolio(data, data.periods[0])!;
  for (const key of ['vigente', 'atrasada', 'vencida'] as const) {
    const fromReport = report.quality.find(q => q.key === key)!;
    assert.equal(analysis[key].count, cockpit[key].count, `${key} count analysis vs cockpit`);
    assert.ok(Math.abs(analysis[key].pct - cockpit[key].pct) < 1e-12, `${key} % analysis vs cockpit`);
    assert.ok(Math.abs(fromReport.pct - cockpit[key].pct) < 1e-12, `${key} % report vs cockpit`);
  }
  assert.ok(Math.abs(analysis.vigente.pct - 0.96) < 1e-9);
});

test('"0 días" is a bucket inside vigente, and the reconciliation checks hold', () => {
  const dist = dpdDistribution(rows);
  const zero = dist.find(d => d.bucket === '0 dias')!;
  assert.ok(Math.abs(zero.pct - 0.6) < 1e-9);
  assert.equal(DPD_BUCKET_DEFS[0].min, 0);
  const rec = reconcileQuality(rows);
  assert.equal(rec.checks.every(c => c.ok), true);
  const bridge = Object.fromEntries(rec.bridge.map(b => [b.label, b.pct]));
  assert.ok(Math.abs(bridge['Al corriente (0 días)'] + bridge['Con atraso 1-30 días'] - bridge['Vigente (0-30 DPD)']) < 1e-12);
});

test('a saved analysis made with the old definition is refreshed with the current rules when read', () => {
  const stale = { overallStatus: 'good', riskScore: 5, executiveSummary: 'texto IA', trendDirection: 'stable', portfolioQuality: { vigente: { count: 1, balance: 600_000, pct: 0.6 }, atrasada: { count: 4, balance: 390_000, pct: 0.39 }, vencida: { count: 1, balance: 10_000, pct: 0.01 } }, metrics: [], findings: [], congruencyChecks: [] };
  const tape: any = { id: 't', clientId: 'c', name: 't', uploadDate: '2026-06-01', fileName: '260531 - LT - Test.xlsx', tapeType: 'credito', extractedData: { _standardized: rows, _analysis: stale } };
  const fresh: any = storedAnalysisFor(tape);
  assert.ok(Math.abs(fresh.portfolioQuality.vigente.pct - 0.96) < 1e-9);
  assert.notEqual(fresh.executiveSummary, 'texto IA'); // el texto también se regenera con las reglas vigentes
});

test('executive summary uses the same vigente % as the quality table and names Top-10 clients vs credits', () => {
  const tape: any = { id: 't', clientId: 'c', name: 't', uploadDate: '2026-06-01', fileName: '260531 - LT - Test.xlsx', tapeType: 'credito', extractedData: { _standardized: rows, _analysis: { executiveSummary: 'vigente 60.0%, atrasada 39.0%' } } };
  const fresh: any = storedAnalysisFor(tape);
  assert.match(fresh.executiveSummary, /vigente 96\.0% \(0-30 DPD; 60\.0% al corriente\)/);
  assert.match(fresh.executiveSummary, /10 clientes más grandes/);
  assert.match(fresh.executiveSummary, /10 créditos más grandes/);
  assert.doesNotMatch(fresh.executiveSummary, /39\.0%/);
});

test('DPD source hierarchy: reported > derived from due date > proxy (never vencida by default) > sin dato', () => {
  assert.deepEqual(resolveDpd({ reported: 12, overdueFlag: true }), { dpd: 12, source: 'reported' });
  assert.deepEqual(resolveDpd({ reported: null, overdueFlag: true, cutoff: '2026-06-30', dueDate: '2026-05-31' }), { dpd: 30, source: 'derived' });
  assert.deepEqual(resolveDpd({ reported: null, overdueFlag: true, cutoff: '2026-06-30', dueDate: '2026-07-31' }), { dpd: DPD_PROXY_DAYS, source: 'proxy' });
  assert.deepEqual(resolveDpd({ reported: null, overdueFlag: true }), { dpd: DPD_PROXY_DAYS, source: 'proxy' });
  assert.equal(classifyDpd(DPD_PROXY_DAYS), 'atrasada');
  assert.deepEqual(resolveDpd({ reported: null, overdueFlag: false }), { dpd: 0, source: 'derived' });
  assert.deepEqual(resolveDpd({ reported: null, overdueFlag: null }), { dpd: null, source: null });
});

// ── Validación cruzada DPD vs bucket del archivo (caso Red Girasol 2026-10-08) ──────────────────────────────────────
import { dpdRangeFromText, checkDpdConsistency } from '../src/lib/portfolioRules';
import { standardizeLoanTape } from '../src/lib/loanTapeAnalytics';

test('dpdRangeFromText traduce buckets y estatus de cobranza a rangos de días', () => {
  assert.deepEqual(dpdRangeFromText('Al corriente'), [0, 0]);
  assert.deepEqual(dpdRangeFromText('1-30 días'), [1, 30]);
  assert.deepEqual(dpdRangeFromText('Retrasado (31 a 60 días)'), [31, 60]);
  assert.deepEqual(dpdRangeFromText('90+ días'), [90, Infinity]);
  assert.deepEqual(dpdRangeFromText('Vencido'), [1, Infinity]);
  assert.deepEqual(dpdRangeFromText('Castigado'), [90, Infinity]);
  assert.equal(dpdRangeFromText('collecting'), null);
  assert.equal(dpdRangeFromText('SONORA'), null);
});

test('checkDpdConsistency detecta un DPD que no cuadra con el bucket', () => {
  const pairs = Array.from({ length: 20 }, (_, i) => ({ range: [90, Infinity] as [number, number], dpd: i < 10 ? 3 : 120, balance: 100 }));
  const r = checkDpdConsistency(pairs);
  assert.equal(r.ok, false);
  assert.equal(r.mismatches, 10);
  assert.ok(checkDpdConsistency(pairs.map(p => ({ ...p, dpd: 120 }))).ok);
});

test('"No. pagos vencidos" no se toma como días de atraso; se valida contra el bucket del archivo', () => {
  const rows = Array.from({ length: 40 }, (_, i) => {
    const late = i % 4 === 0;
    return {
      ID: i + 1, 'Client ID': 1000 + i, 'Saldo insoluto (CM)': 10_000 + i,
      'No. pagos vencidos (CM)': late ? 4 : 0,
      'Bucket Mora (CM)': late ? '90+ días' : 'Al corriente',
      'Días de mora (CM)': late ? 120 + i : 0,
      'Fecha de corte': 46265,
    };
  });
  const res = standardizeLoanTape(rows, '260931 -  RG loan tape.xlsx');
  const late = res.standardized.filter(r => (r.days_overdue || 0) > 90);
  assert.equal(late.length, 10);
  assert.equal(res.standardized[0].file_date, '2026-08-31');
  assert.ok(res.dpdValidation?.ok);
});

test('la regla corrige la columna de DPD cuando la elegida no cuadra con el bucket', () => {
  // Encabezados que el mapeador por nombre NO reconoce como días: la regla tiene que encontrar la columna buena.
  const rows = Array.from({ length: 40 }, (_, i) => {
    const late = i % 4 === 0;
    return { ID: i + 1, Saldo: 5_000, 'Atraso (cuenta)': late ? 2 : 0, 'Bucket': late ? '90+' : 'Al corriente', 'Antigüedad X': late ? 150 : 0 };
  });
  const res = standardizeLoanTape(rows, 'tape 260831.xlsx');
  assert.ok(res.dpdValidation);
  assert.ok(res.standardized.filter(r => (r.days_overdue || 0) > 90).length === 10, JSON.stringify(res.dpdValidation));
});

import { statusDpdConflicts } from '../src/lib/portfolioRules';

test('estatus de castigo/incobrable con menos de 90 días se reporta, no se reclasifica', () => {
  const rows: StandardLoan[] = [
    { ...loan(1, 0, 1_000), loan_status: 'irrecoverable' },
    { ...loan(2, 120, 2_000), loan_status: 'irrecoverable' },
    { ...loan(3, 0, 3_000), loan_status: 'collecting' },
  ];
  const c = statusDpdConflicts(rows);
  assert.equal(c.count, 1);
  assert.equal(c.balance, 1_000);
  assert.equal(classifyDpd(rows[0].days_overdue), 'vigente');
});

import { importLoanTapeSheets, reimportFromSource } from '../src/lib/loanTapeImport';

test('el mapeo corregido por el analista se respeta, y una corrección de mora errónea queda bloqueada por la validación', () => {
  const header = ['ID', 'Client ID', 'Saldo insoluto', 'Saldo alterno', 'No. pagos vencidos', 'Días de mora', 'Bucket Mora'];
  const body = Array.from({ length: 40 }, (_, i) => {
    const late = i % 4 === 0;
    return [i + 1, 1000 + i, 10_000, 7_000, late ? 4 : 0, late ? 120 : 0, late ? '90+ días' : 'Al corriente'];
  });
  const first = importLoanTapeSheets([{ name: 'Hoja1', rows: [header, ...body] }], '260831 - tape.xlsx');
  const tape = { fileName: '260831 - tape.xlsx', extractedData: { _source: first.sourceTables } };
  assert.ok(first.sourceTables?.length);

  const alt = reimportFromSource(tape, { 'saldo alterno': 'outstanding_balance', 'saldo insoluto': 'ignore' })!;
  assert.equal(alt.standardized[0].outstanding_balance, 7_000);
  assert.ok(alt.mappingReport.some(m => m.reasoning === 'Mapeo corregido por el analista'));

  const wrong = reimportFromSource(tape, { 'no pagos vencidos': 'days_overdue' })!;
  assert.equal(wrong.reconciliation.severity, 'blocker');
  assert.ok(wrong.reconciliation.messages.some(m => m.startsWith('⛔')));
});
