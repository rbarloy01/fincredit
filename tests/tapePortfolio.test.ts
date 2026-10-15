import assert from 'node:assert/strict';
import test from 'node:test';
(globalThis as any).localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };

const loan = (dpd: number | null, bal: number, file_date = '2026-06-30') => ({ loan_id: String(Math.random()), outstanding_balance: bal, days_overdue: dpd, file_date, loan_status: 'Vigente' }) as any;

test('loan tape: vigente 0-30, atrasada 31-89, vencida 90+ por corte', async () => {
  const { tapePortfolioPoints } = await import('../src/lib/tapePortfolio');
  const [p] = tapePortfolioPoints([loan(0, 100), loan(30, 100), loan(31, 50), loan(90, 25), loan(200, 25)], 'lt.xlsx');
  assert.equal(p.balance, 300);
  assert.equal(p.vigente, 200);
  assert.equal(p.atrasada, 50);
  assert.equal(p.vencida, 50);
  assert.equal(p.pastDue30, 100);
});

test('indicadores: la cartera vencida sale del loan tape del mismo mes; sin DPD se queda la del estado', async () => {
  const { tapePortfolioPoints } = await import('../src/lib/tapePortfolio');
  const { setTapePortfolioCache } = await import('../src/lib/tapePortfolioCache');
  const { getMetric, standardRatios } = await import('../src/lib/financialMetrics');
  const items = [
    { name: 'Total cartera de crédito', value: 1000, statementType: 'balance_general' },
    { name: 'Cartera de crédito vencida', value: 10, statementType: 'balance_general' },
    { name: 'Total activo', value: 2000, statementType: 'balance_general' },
  ];
  const stmt: any = { id: 's', clientId: 'cli', period: 'jun 26', periodDate: '2026-06-30', fileName: '', rawLineItems: items, mappedData: {}, extraAccounts: [] };
  const withDpd = tapePortfolioPoints([loan(0, 800), loan(95, 200)], 'lt.xlsx');
  setTapePortfolioCache('cli', Object.fromEntries(withDpd.map(p => [p.cutoff, p])));
  assert.equal(getMetric(stmt, 'pastDuePortfolio'), 200);
  assert.equal(getMetric(stmt, 'managedPortfolio'), 1000);
  const imor = standardRatios(stmt).find(r => r.key === 'past_due_portfolio')!;
  assert.equal(imor.value, 0.2);
  assert.match(imor.formula, /loan tape \(corte 2026-06-30/);

  const noDpd = tapePortfolioPoints([loan(null, 800), loan(null, 200)], 'lt.xlsx');
  setTapePortfolioCache('cli', Object.fromEntries(noDpd.map(p => [p.cutoff, p])));
  assert.equal(getMetric(stmt, 'pastDuePortfolio'), 10);
  assert.match(standardRatios(stmt).find(r => r.key === 'past_due_portfolio')!.formula, /estado financiero/);
});

test('el loan tape solo manda si su saldo cuadra con la cartera del balance (±15%)', async () => {
  const { tapePortfolioPoints } = await import('../src/lib/tapePortfolio');
  const { setTapePortfolioCache } = await import('../src/lib/tapePortfolioCache');
  const { getMetric, standardRatios } = await import('../src/lib/financialMetrics');
  const items = [
    { name: 'Total cartera de crédito', value: 1000, statementType: 'balance_general' },
    { name: 'Cartera de crédito vencida', value: 30, statementType: 'balance_general' },
    { name: 'Total activo', value: 2000, statementType: 'balance_general' },
  ];
  const stmt: any = { id: 's2', clientId: 'cli2', period: 'jun 26', periodDate: '2026-06-30', fileName: '', rawLineItems: items, mappedData: {}, extraAccounts: [] };
  // Tape incompleto: 600 vs 1,000 del balance (−40%) → manda el balance.
  setTapePortfolioCache('cli2', Object.fromEntries(tapePortfolioPoints([loan(0, 500), loan(120, 100)], 'lt.xlsx').map(p => [p.cutoff, p])));
  assert.equal(getMetric(stmt, 'pastDuePortfolio'), 30);
  assert.match(standardRatios(stmt).find(r => r.key === 'past_due_portfolio')!.formula, /no cuadra con el balance/);
  // Tape que cuadra (950 vs 1,000) → manda el tape.
  setTapePortfolioCache('cli2', Object.fromEntries(tapePortfolioPoints([loan(0, 850), loan(120, 100)], 'lt.xlsx').map(p => [p.cutoff, p])));
  assert.equal(getMetric(stmt, 'pastDuePortfolio'), 100);
});

test('loan tape 3x el balance = cartera administrada fuera de balance (plataforma): manda el tape', async () => {
  const { tapePortfolioPoints } = await import('../src/lib/tapePortfolio');
  const { setTapePortfolioCache } = await import('../src/lib/tapePortfolioCache');
  const { getMetric, standardRatios } = await import('../src/lib/financialMetrics');
  const stmt: any = { id: 's3', clientId: 'cli3', period: '', periodDate: '2026-06-30', fileName: '', mappedData: {}, extraAccounts: [], rawLineItems: [
    { name: 'Total cartera de crédito', value: 1000, statementType: 'balance_general' }, { name: 'Total activo', value: 2000, statementType: 'balance_general' }] };
  setTapePortfolioCache('cli3', Object.fromEntries(tapePortfolioPoints([loan(0, 2400), loan(120, 600)], 'lt.xlsx').map(p => [p.cutoff, p])));
  assert.equal(getMetric(stmt, 'managedPortfolio'), 3000);
  assert.match(standardRatios(stmt).find(r => r.key === 'past_due_portfolio')!.formula, /fuera de balance/);
});
