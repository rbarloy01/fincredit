import assert from 'node:assert/strict';
import test from 'node:test';
(globalThis as any).localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };

test('historial de fondeo: variación por acreedor, concentración y cuadre contra el balance', async () => {
  const { analyzeLiabilityHistory, upsertSnapshot } = await import('../src/lib/liabilityHistory');
  let store = { snapshots: [] as any[] };
  store = upsertSnapshot(store, { cutoff: '2026-07-31', lines: [{ lender: 'Hexágono Capital', term: 'largo', balance: 36_400_000 }, { lender: 'Play Business', term: 'largo', balance: 673_000 }, { lender: 'Clara CF Tech', term: 'corto', balance: 44_000 }], createdAt: '' });
  store = upsertSnapshot(store, { cutoff: '2026-08-31', lines: [{ lender: 'Hexagono Capital', term: 'largo', balance: 34_667_000 }, { lender: 'Play Business', term: 'largo', balance: 290_000 }, { lender: 'Clara CF Tech', term: 'corto', balance: 81_000 }], createdAt: '' });
  // Un corte del mismo mes reemplaza (corrección), no duplica.
  store = upsertSnapshot(store, { ...store.snapshots[1], createdAt: 'x' });
  assert.equal(store.snapshots.length, 2);
  const stmt: any = { id: 's', clientId: 'rg', period: '', periodDate: '2026-08-31', fileName: '', mappedData: {}, extraAccounts: [], rawLineItems: [
    { name: 'Préstamos bancarios de corto plazo', value: 81_000, statementType: 'balance_general' },
    { name: 'Préstamos bancarios de largo plazo', value: 34_957_000, statementType: 'balance_general' },
    { name: 'Total pasivo', value: 54_486_000, statementType: 'balance_general' },
  ] };
  const a = analyzeLiabilityHistory('rg', store, [stmt]);
  assert.deepEqual(a.totals, [37_117_000, 35_038_000]);
  const hex = a.lenders.find(l => l.lender.startsWith('Hex'))!;
  assert.equal(hex.delta, -1_733_000);   // "Hexágono" y "Hexagono" son el mismo acreedor
  assert.ok(a.latest!.topShare > 0.98);
  assert.equal(a.checks.find(c => c.cutoff === '2026-08-31')!.ok, true);
  assert.ok(a.insights.some(t => /bajó/.test(t)));
});
