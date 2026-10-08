import assert from 'node:assert/strict';
import test from 'node:test';
import { dropMissingClientColumns } from '../src/db/index';

test('a missing optional clients column is dropped from the write instead of failing the whole create', () => {
  const payload: Record<string, any> = { name: 'ACME', status: 'activo', eligibility_criteria: [], fiscal_buro_status: {}, operations_notes: '' };
  const error = { message: "Could not find the 'eligibility_criteria' column of 'clients' in the schema cache" };
  assert.deepEqual(dropMissingClientColumns(payload, error), ['eligibility_criteria']);
  assert.ok(!('eligibility_criteria' in payload));
  assert.equal(payload.name, 'ACME');
  // the next missing column is found on the next round trip
  assert.deepEqual(dropMissingClientColumns(payload, { message: 'column clients.fiscal_buro_status does not exist' }), ['fiscal_buro_status']);
  assert.equal(payload.status, 'activo'); // status is a different column and must survive
});

test('unrelated errors never drop anything, and required columns are never dropped', () => {
  const payload: Record<string, any> = { name: 'ACME', status: 'activo' };
  assert.deepEqual(dropMissingClientColumns(payload, { message: 'duplicate key value violates unique constraint' }), []);
  assert.deepEqual(dropMissingClientColumns(payload, { message: "Could not find the 'name' column of 'clients' in the schema cache" }), []);
  assert.deepEqual(Object.keys(payload), ['name', 'status']);
});
