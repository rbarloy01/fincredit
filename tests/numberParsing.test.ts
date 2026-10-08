import assert from 'node:assert/strict';
import test from 'node:test';
import { parseFinancialNumber } from '../src/lib/numberParsing';

test('parseFinancialNumber keeps decimals and thousands apart', () => {
  assert.equal(parseFinancialNumber('30.00000'), 30);
  assert.equal(parseFinancialNumber('0.125'), 0.125);
  assert.equal(parseFinancialNumber('12.5'), 12.5);
  assert.equal(parseFinancialNumber('1,234.56'), 1234.56);
  assert.equal(parseFinancialNumber('1,234,567'), 1234567);
  assert.equal(parseFinancialNumber('1.234.567,89'), 1234567.89);
  assert.equal(parseFinancialNumber('30,00000'), 30);
  assert.equal(parseFinancialNumber('1.234'), 1234);
  assert.equal(parseFinancialNumber('(2,500.00)'), -2500);
});
