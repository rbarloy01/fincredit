import assert from 'node:assert/strict';
import test from 'node:test';
(globalThis as any).localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };

const st = (periodDate: string, interestYtd: number, debt: number): any => ({
  id: periodDate, clientId: 'c', period: periodDate, periodDate, fileName: 'EF acumulado', documentType: 'Estados financieros (acumulado ene-mes)', extraAccounts: [], mappedData: {},
  rawLineItems: [
    { name: 'Préstamos bancarios de largo plazo', value: debt, statementType: 'balance_general' },
    { name: 'Total pasivo', value: debt * 1.5, statementType: 'balance_general' },
    { name: 'Ingresos por intereses', value: interestYtd * 3, statementType: 'estado_resultados' },
    { name: 'Gastos por intereses', value: -interestYtd, statementType: 'estado_resultados' },
  ],
});

test('costo del fondeo: gasto del mes = acumulado − acumulado anterior; saldo promedio; reparto por contrato', async () => {
  const { analyzeFundingCost } = await import('../src/lib/fundingCost');
  // Ene 1.0M acumulado, feb 2.0M, mar 3.0M → 1.0M por mes; deuda 60M constante → 1.0 × 12 / 60 = 20%.
  const a = analyzeFundingCost([st('2026-01-31', 1_000_000, 60_000_000), st('2026-02-28', 2_000_000, 60_000_000), st('2026-03-31', 3_000_000, 60_000_000)]);
  assert.equal(a.latest!.periodExpense, 1_000_000);
  assert.equal(a.latest!.months, 1);
  assert.ok(Math.abs(a.latest!.rate! - 0.2) < 1e-9);
  // Un fondeador con tasa de contrato 20% y saldo 59.6M; otro sin tasa con 0.4M: el remanente implicaría >60% → tasa combinada + gasto no explicado.
  const b = analyzeFundingCost([st('2026-02-28', 2_000_000, 60_000_000), st('2026-03-31', 3_400_000, 60_000_000)], [],
    [{ lenderName: 'Fondo A', currentBalance: 59_600_000, interestRate: 0.2 } as any, { lenderName: 'Fondo B', currentBalance: 400_000, interestRate: null } as any]);
  const fb = b.byLender.find(x => x.lender === 'Fondo B')!;
  assert.equal(fb.source, 'implícita');
  assert.ok(fb.rate! < 0.6);
  assert.ok(b.unexplained! > 0);
});
