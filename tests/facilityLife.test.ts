import test from 'node:test';
import assert from 'node:assert/strict';
import { dispositionStatus, facilityUsage, facilityLife, statementsDuringLife, type FacilityDisposition } from '../src/lib/facilityLife';

const d = (date: string, amount: number, extra: Partial<FacilityDisposition> = {}): FacilityDisposition =>
  ({ id: date + amount, date, amount: String(amount), currency: 'MXN', notes: '', ...extra });

test('estatus de disposición: capturado o inferido de la nota', () => {
  assert.equal(dispositionStatus({ notes: 'Pagado' }), 'pagada');
  assert.equal(dispositionStatus({ notes: 'cancelada por el cliente' }), 'terminada');
  assert.equal(dispositionStatus({ notes: '' }), 'vigente');
  assert.equal(dispositionStatus({ notes: 'Pagado', status: 'vigente' }), 'vigente');
});

test('revolvente (Red Girasol 5M): lo pagado libera la línea, no es exceso', () => {
  const items = [d('2024-09-18', 3e6, { notes: 'Pagado' }), d('2024-09-25', 2e6, { notes: 'Pagado' }), d('2025-03-03', 3e6), d('2025-03-03', 2e6, { status: 'pagada' })];
  const u = facilityUsage({ creditType: 'Revolvente', originalAmount: 5e6 }, items);
  assert.equal(u.revolving, true);
  assert.equal(u.disbursedTotal, 10e6);
  assert.equal(u.outstanding, 3e6);
  assert.equal(u.available, 2e6);
  assert.equal(u.overAuthorized, false);
  assert.equal(u.closedCount, 3);
});

test('simple: cada disposición consume la línea aunque se pague', () => {
  const u = facilityUsage({ creditType: 'Simple', originalAmount: 10e6 }, [d('2025-01-10', 6e6, { status: 'pagada' }), d('2025-05-10', 3e6)]);
  assert.equal(u.available, 1e6);
  assert.equal(u.outstanding, 3e6);
  const over = facilityUsage({ creditType: 'Simple', originalAmount: 5e6 }, [d('2025-01-10', 6e6, { status: 'pagada' })]);
  assert.equal(over.overAuthorized, true);
});

test('vigencia y estados durante la vida de una facility terminada', () => {
  const items = [d('2024-09-18', 3e6, { maturityDate: '2024-12-17' }), d('2025-03-03', 2e6, { maturityDate: '2025-03-28', closedAt: '2025-03-20' })];
  const life = facilityLife({ signedAt: '2024-09-17', maturityAt: '2025-03-28' }, items, 'Terminado', '2026-10-15');
  assert.deepEqual(life, { start: '2024-09-17', end: '2025-03-28', status: 'terminada', terminated: true });
  const st = ['2024-06-30', '2024-09-30', '2024-12-31', '2025-03-31', '2025-06-30'].map(periodDate => ({ periodDate }));
  assert.deepEqual(statementsDuringLife(st, life).map(s => s.periodDate), ['2024-09-30', '2024-12-31', '2025-03-31']);
  const open = facilityLife({ signedAt: '2025-01-01', maturityAt: '2027-01-01' }, [], 'Monitoring', '2026-10-15');
  assert.equal(open.status, 'vigente');
  assert.equal(statementsDuringLife(st, open).length, 2);
  assert.equal(facilityLife({ signedAt: '2023-01-01', maturityAt: '2024-01-01' }, [], 'Monitoring', '2026-10-15').status, 'vencida');
});
