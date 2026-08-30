import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

function loadDotEnv(path = '.env') {
  if (!fs.existsSync(path)) return;
  const lines = fs.readFileSync(path, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}

loadDotEnv();

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_KEY;
const anonKey = process.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !serviceKey || !anonKey) {
  console.error('Missing SUPABASE_URL/VITE_SUPABASE_URL, SUPABASE_SERVICE_KEY, or VITE_SUPABASE_ANON_KEY.');
  process.exit(1);
}

const runId = randomUUID().slice(0, 8);
const emailDomain = process.env.RLS_TEST_EMAIL_DOMAIN || 'example.invalid';
const password = `FinMonitor-RLS-${runId}!Aa1`;
const createdUserIds = [];
const createdOrgIds = [];
const createdClientIds = [];
const results = [];

function headers(key, bearer = key) {
  return {
    apikey: key,
    Authorization: `Bearer ${bearer}`,
    'Content-Type': 'application/json',
  };
}

async function readJson(response, fallback = null) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
}

async function rest(path, { key = serviceKey, bearer = key, method = 'GET', body, prefer = 'return=representation' } = {}) {
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    method,
    headers: { ...headers(key, bearer), Prefer: prefer },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, data: await readJson(response, null) };
}

async function adminAuth(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${supabaseUrl}/auth/v1/admin/${path}`, {
    method,
    headers: headers(serviceKey),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, data: await readJson(response, null) };
}

async function createAuthUser(role) {
  const email = `finmonitor-rls-${role}-${runId}@${emailDomain}`;
  const { response, data } = await adminAuth('users', {
    method: 'POST',
    body: {
      email,
      password,
      email_confirm: true,
      user_metadata: { purpose: 'finmonitor-rls-smoke', runId, role },
    },
  });
  if (!response.ok || !data?.id) {
    throw new Error(`Could not create ${role} auth user: HTTP ${response.status} ${JSON.stringify(data)}`);
  }
  createdUserIds.push(data.id);
  return { id: data.id, email, role };
}

async function signIn(user) {
  const response = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: headers(anonKey, anonKey),
    body: JSON.stringify({ email: user.email, password }),
  });
  const data = await readJson(response, null);
  if (!response.ok || !data?.access_token) {
    throw new Error(`Could not sign in ${user.role}: HTTP ${response.status} ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

async function insertOne(table, row) {
  const { response, data } = await rest(table, { method: 'POST', body: row });
  if (!response.ok || !Array.isArray(data) || !data[0]?.id) {
    throw new Error(`Could not insert ${table}: HTTP ${response.status} ${JSON.stringify(data)}`);
  }
  return data[0];
}

async function deleteWhere(table, filter) {
  await rest(`${table}?${filter}`, { method: 'DELETE', prefer: 'return=minimal' });
}

function record(name, pass, detail) {
  results.push({ name, pass, detail });
}

async function expectVisible(actor, table, id) {
  const { response, data } = await rest(`${table}?select=id&id=eq.${encodeURIComponent(id)}&limit=1`, {
    key: anonKey,
    bearer: actor.token,
  });
  const count = Array.isArray(data) ? data.length : 0;
  record(`${actor.role} can read same-org ${table}`, response.ok && count === 1, `HTTP ${response.status}, rows ${count}`);
}

async function expectHidden(actor, table, id, label = 'cross-org') {
  const { response, data } = await rest(`${table}?select=id&id=eq.${encodeURIComponent(id)}&limit=1`, {
    key: anonKey,
    bearer: actor.token,
  });
  const count = Array.isArray(data) ? data.length : 0;
  record(`${actor.role} cannot read ${label} ${table}`, response.ok && count === 0, `HTTP ${response.status}, rows ${count}`);
}

async function expectInsert(actor, table, row, shouldPass, label) {
  const { response, data } = await rest(table, {
    method: 'POST',
    key: anonKey,
    bearer: actor.token,
    body: row,
  });
  const insertedId = Array.isArray(data) ? data[0]?.id : null;
  if (insertedId && table === 'clients') createdClientIds.push(insertedId);
  record(label, shouldPass ? response.ok && Boolean(insertedId) : !response.ok, `HTTP ${response.status} ${JSON.stringify(data)?.slice(0, 180)}`);
}

async function setup() {
  const orgA = await insertOne('organizations', { name: `RLS Smoke A ${runId}`, slug: `rls-smoke-a-${runId}` });
  const orgB = await insertOne('organizations', { name: `RLS Smoke B ${runId}`, slug: `rls-smoke-b-${runId}` });
  createdOrgIds.push(orgA.id, orgB.id);

  const manager = await createAuthUser('manager');
  const analyst = await createAuthUser('analyst');
  const pending = await createAuthUser('pending');

  await insertOne('profiles', { id: manager.id, name: 'RLS Manager', email: manager.email, role: 'manager', org_id: orgA.id });
  await insertOne('profiles', { id: analyst.id, name: 'RLS Analyst', email: analyst.email, role: 'analyst', org_id: orgA.id });
  await insertOne('profiles', { id: pending.id, name: 'RLS Pending', email: pending.email, role: 'pending', org_id: orgA.id });

  const clientA = await insertOne('clients', { org_id: orgA.id, name: `RLS Client A ${runId}`, currency: 'MXN' });
  const clientB = await insertOne('clients', { org_id: orgB.id, name: `RLS Client B ${runId}`, currency: 'MXN' });
  createdClientIds.push(clientA.id, clientB.id);

  const documentA = await insertOne('documents', {
    org_id: orgA.id,
    client_id: clientA.id,
    file_name: `rls-${runId}.pdf`,
    document_type: 'financial_statement',
  });
  const statementA = await insertOne('financial_statements', {
    client_id: clientA.id,
    source_document_id: documentA.id,
    period: '2026-06',
    period_date: '2026-06-30',
    file_name: `rls-${runId}.xlsx`,
    mapped_data: { revenue: 1000, ebitda: 200 },
  });
  const reviewA = await insertOne('extraction_review_items', {
    org_id: orgA.id,
    client_id: clientA.id,
    document_id: documentA.id,
    item_type: 'financial_line_item',
    source_key: `rls-smoke-${runId}`,
    raw_value: { runId },
    suggested_value: { metric: 'revenue', period: '2026-06', periodDate: '2026-06-30', value: 1000 },
    status: 'pending',
  });

  return {
    orgA,
    orgB,
    clientA,
    clientB,
    documentA,
    statementA,
    reviewA,
    manager: { ...manager, token: await signIn(manager) },
    analyst: { ...analyst, token: await signIn(analyst) },
    pending: { ...pending, token: await signIn(pending) },
  };
}

async function cleanup() {
  for (const id of createdClientIds) {
    await deleteWhere('clients', `id=eq.${encodeURIComponent(id)}`);
  }
  for (const id of createdUserIds) {
    await adminAuth(`users/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }
  for (const id of createdOrgIds) {
    await deleteWhere('organizations', `id=eq.${encodeURIComponent(id)}`);
  }
}

try {
  const state = await setup();
  const actors = [state.manager, state.analyst];

  for (const actor of actors) {
    await expectVisible(actor, 'organizations', state.orgA.id);
    await expectHidden(actor, 'organizations', state.orgB.id);
    await expectVisible(actor, 'clients', state.clientA.id);
    await expectHidden(actor, 'clients', state.clientB.id);
    await expectVisible(actor, 'documents', state.documentA.id);
    await expectVisible(actor, 'financial_statements', state.statementA.id);
    await expectVisible(actor, 'extraction_review_items', state.reviewA.id);
  }

  await expectHidden(state.pending, 'organizations', state.orgA.id, 'pending-user');
  await expectHidden(state.pending, 'clients', state.clientA.id, 'pending-user');
  await expectHidden(state.pending, 'documents', state.documentA.id, 'pending-user');
  await expectHidden(state.pending, 'financial_statements', state.statementA.id, 'pending-user');
  await expectHidden(state.pending, 'extraction_review_items', state.reviewA.id, 'pending-user');

  await expectInsert(state.analyst, 'clients', {
    org_id: state.orgA.id,
    name: `RLS Analyst Insert ${runId}`,
    currency: 'MXN',
  }, true, 'analyst can insert same-org client');

  await expectInsert(state.analyst, 'clients', {
    org_id: state.orgB.id,
    name: `RLS Analyst Cross Org ${runId}`,
    currency: 'MXN',
  }, false, 'analyst cannot insert cross-org client');

  await expectInsert(state.pending, 'clients', {
    org_id: state.orgA.id,
    name: `RLS Pending Insert ${runId}`,
    currency: 'MXN',
  }, false, 'pending cannot insert same-org client');

  const failed = results.filter(result => !result.pass);
  console.log(JSON.stringify({
    ok: failed.length === 0,
    runId,
    checks: results,
    failed,
    remediation: failed.length
      ? 'Apply database/20260830_strict_authenticated_rls_repair.sql in Supabase SQL Editor or via a DB connection, then rerun npm run verify:rls.'
      : 'Authenticated manager/analyst/pending RLS smoke checks passed.',
  }, null, 2));
  process.exitCode = failed.length === 0 ? 0 : 1;
} catch (error) {
  console.error(JSON.stringify({ ok: false, runId, error: error?.message || String(error) }, null, 2));
  process.exitCode = 1;
} finally {
  await cleanup();
}
