import assert from 'node:assert/strict';
import test from 'node:test';
import { computeClientSignal } from '../src/lib/portfolioAnalytics';
import { isClientMonitored } from '../src/lib/clientStatus';

const stmt = (period: string, date: string, equity: number): any => ({ id: period, clientId: 'c', period, periodDate: date, uploadDate: date, fileName: 'x', rawLineItems: [], extraAccounts: [], mappedData: { revenue: 0, cogs: 0, operatingExpenses: 0, ebitda: 0, interestExpense: 0, netIncome: 0, currentAssets: 0, currentLiabilities: 0, totalDebt: 0, totalAssets: 100, equity } });
const cov: any = { id: 'k', clientId: 'c', name: 'ICAP mínimo', type: 'financial', formula: 'ratio:equity/totalAssets', threshold: '50', operator: 'gte', description: '', isCustom: true, createdAt: '2026-01-01' };
const client = (status?: string): any => ({ id: 'c', name: 'C', status, currency: 'MXN', frequency: 'mensual', documentation: [{ isCompliant: false }], totalCreditValue: 1000, currentDue: 500 });

test('dormant and closed clients are never flagged (no breaches, overdue EEFF, docs or severity)', () => {
  const statements = [stmt('ene 24', '2024-01-31', 10)]; // ICAP 10% < 50% → incumple si estuviera activo; EEFF muy vencidos
  const now = new Date('2026-10-01');
  const grace = { monthly: 40, quarterly: 75 };
  const active = computeClientSignal(client('activo'), statements, [cov], [], [], now, 90, grace);
  assert.equal(active.breachCount, 1);
  assert.equal(active.reporting.isOverdue, true);
  for (const status of ['dormant', 'cerrado']) {
    const s = computeClientSignal(client(status), statements, [cov], [], [], now, 90, grace);
    assert.equal(s.breachCount, 0);
    assert.equal(s.warningCount, 0);
    assert.equal(s.reporting.isOverdue, false);
    assert.equal(s.docsOutstanding, 0);
    assert.equal(s.severity, 0);
    assert.equal(isClientMonitored(client(status)), false);
  }
});

test('portfolio context for the assistant lists clients with status and flags paused ones', async () => {
  const { buildPortfolioContext } = await import('../src/lib/clientContext');
  const mk = (name: string, status: any, line: number) => ({ id: name, name, status, totalCreditValue: line, currentDue: line / 2, industry: 'Leasing', analystName: 'Ana', frequency: 'mensual' }) as any;
  const pack = buildPortfolioContext([mk('ALFA', 'activo', 5e7), mk('BETA', 'dormido', 9e7), mk('GAMMA', 'cerrado', 1e7)]);
  assert.match(pack.text, /Clientes: 3/);
  assert.match(pack.text, /BETA \| dormido/);
  assert.ok(pack.text.indexOf('BETA') < pack.text.indexOf('ALFA'), 'sorted by line');
  assert.match(pack.text, /En monitoreo: 1/);
});
