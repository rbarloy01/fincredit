import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSyntageUrl, resolveSyntageBaseUrl, sanitizeSyntagePath, SYNTAGE_SANDBOX_URL } from '../server/syntage';

test('defaults to sandbox and gates production behind an explicit flag', () => {
  assert.deepEqual(resolveSyntageBaseUrl({}), { ok: true, baseUrl: SYNTAGE_SANDBOX_URL, environment: 'sandbox' });
  assert.equal(resolveSyntageBaseUrl({ SYNTAGE_BASE_URL: 'https://api.syntage.com' }).ok, false);
  assert.equal(resolveSyntageBaseUrl({ SYNTAGE_BASE_URL: 'https://api.syntage.com', SYNTAGE_ALLOW_PRODUCTION: '1' }).ok, true);
  assert.equal(resolveSyntageBaseUrl({ SYNTAGE_BASE_URL: 'https://evil.example.com' }).ok, false);
});

test('only accepts relative Syntage paths', () => {
  assert.equal(sanitizeSyntagePath('/entities'), '/entities');
  assert.equal(sanitizeSyntagePath('/entities/abc/invoices?cursor=xyz'), '/entities/abc/invoices?cursor=xyz');
  for (const bad of ['entities', '//evil.com/x', 'https://evil.com', '/a/../b', '/..', '/a\\b', '/a b', 42, null]) {
    assert.equal(sanitizeSyntagePath(bad), null, String(bad));
  }
});

test('builds URLs on the Syntage host and keeps hydra:next query strings', () => {
  assert.equal(
    buildSyntageUrl(SYNTAGE_SANDBOX_URL, '/entities', { 'taxpayer.id': 'PEIC211118IS0', empty: '' }),
    'https://api.sandbox.syntage.com/entities?taxpayer.id=PEIC211118IS0',
  );
  assert.equal(
    buildSyntageUrl(SYNTAGE_SANDBOX_URL, '/entities/x/invoices?cursor=abc'),
    'https://api.sandbox.syntage.com/entities/x/invoices?cursor=abc',
  );
  assert.equal(buildSyntageUrl(SYNTAGE_SANDBOX_URL, '@evil.com/x'), null);
});
