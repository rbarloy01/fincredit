// FinMonitor DB — Supabase backend
import { supabase } from '../lib/supabase';
import { normalizeFinancialNumberString, parseFinancialNumber } from '../lib/numberParsing';

export type Role = 'manager' | 'analyst' | 'pending';
export type ActiveRole = Exclude<Role, 'pending'>;

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  createdAt: string;
}

export interface Client {
  id: string;
  orgId?: string;
  name: string;
  taxId: string;
  industry: string;
  score: string;
  currency: 'MXN' | 'USD' | 'EUR';
  totalCreditValue: number;
  creditType: string[];
  contractName: string;
  analystName: string;
  createdBy: string;
  createdAt: string;
  paymentHistory: Array<{
    month: string;
    principalStatus: 'paid' | 'unpaid' | 'none';
    interestStatus: 'paid' | 'unpaid' | 'none';
    principalAmount?: string;
    interestAmount?: string;
    transactionId?: string;
  }>;
  currentDue: number;
  maxDefaultDays: number;
  maxDefaultAmount: number;
  defaultFrequency12m: number;
  opinion: string;
  aforoRequerido: string;
  aforoHistory: Array<{ month: string; value: string; status: 'good' | 'warning' | 'bad'; transactionId?: string }>;
  documentation: Array<{ id: string; name: string; date: string; periodicity: string; isCompliant: boolean; comments: string }>;
  reportDate: string;
  frequency: 'mensual' | 'trimestral';
  lastPeriod: string;
  logoLeft?: string;
  logoRight?: string;
}

export interface CustomField {
  id: string;
  clientId: string;
  label: string;
  value: string;
  fieldType: 'text' | 'number' | 'date';
}

export type CrmInfluence = 'low' | 'medium' | 'high' | 'decision_maker';
export type CrmRelationship = 'champion' | 'neutral' | 'risk';
export type CrmActivityType = 'call' | 'meeting' | 'email' | 'task' | 'note' | 'review';
export type CrmActivityStatus = 'planned' | 'done' | 'canceled';
export type CrmPriority = 'low' | 'normal' | 'high';

export interface CrmContact {
  id: string;
  clientId: string;
  name: string;
  title: string;
  department: string;
  email: string;
  phone: string;
  influence: CrmInfluence;
  relationship: CrmRelationship;
  isPrimary: boolean;
  notes: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CrmActivity {
  id: string;
  clientId: string;
  contactId?: string;
  type: CrmActivityType;
  phase: string;
  recordType: string;
  nextStage: string;
  contactName: string;
  analystName: string;
  subject: string;
  quickNote: string;
  nextStep: string;
  detail: string;
  status: CrmActivityStatus;
  priority: CrmPriority;
  dueAt?: string;
  completedAt?: string;
  ownerId?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CrmTimelineItem {
  id: string;
  kind: 'contact' | 'activity';
  title: string;
  detail: string;
  at: string;
  status?: string;
}

export interface Transaction {
  id: string;
  clientId: string;
  name: string;
  description: string;
  date: string;
  creditType: string;
  originalAmount: number;
  currency: string;
  signedAt: string;
  maturityAt: string;
  createdBy: string;
  createdAt: string;
}

export interface ContractFile {
  id: string;
  transactionId: string;
  clientId: string;
  sourceDocumentId?: string;
  originalName: string;
  mimeType: string;
  base64Data: string;
  uploadedAt: string;
  extractionStatus: 'pending' | 'processing' | 'done' | 'error';
  extractedCovenants?: any;
}

export interface Covenant_DB {
  id: string;
  clientId: string;
  transactionId?: string;
  name: string;
  type: 'financial' | 'hacer' | 'noHacer';
  formula: string;
  threshold: string;
  operator: 'gt' | 'lt' | 'gte' | 'lte' | 'none';
  description: string;
  complianceStatus?: string;
  formulaByPeriod?: Record<string, string>;
  isCustom: boolean;
  extractedFrom?: string;
  createdAt: string;
}

export interface CovenantAnnotation {
  id: string;
  covenantId: string;
  userId: string;
  userName: string;
  text: string;
  createdAt: string;
}

export interface FinancialStatement_DB {
  id: string;
  clientId: string;
  sourceDocumentId?: string;
  sourceCompanyName?: string;
  documentType?: string;
  period: string;
  periodDate: string;
  uploadDate: string;
  fileName: string;
  rawLineItems: Array<{ name: string; value: number; source?: string; sectionPath?: string | null; statementType?: 'balance_general' | 'estado_resultados' | 'flujo_efectivo' | 'otro' }>;
  mappedData: {
    revenue: number; cogs: number; operatingExpenses: number; ebitda: number;
    interestExpense: number; netIncome: number; currentAssets: number;
    currentLiabilities: number; totalDebt: number; totalAssets: number; equity: number;
    [key: string]: number;
  };
  extraAccounts: Array<{ key: string; label: string; value: number }>;
}

const EMPTY_MAPPED_DATA: FinancialStatement_DB['mappedData'] = {
  revenue: 0,
  cogs: 0,
  operatingExpenses: 0,
  ebitda: 0,
  interestExpense: 0,
  netIncome: 0,
  currentAssets: 0,
  currentLiabilities: 0,
  totalDebt: 0,
  totalAssets: 0,
  equity: 0,
};

export interface LoanTape_DB {
  id: string;
  clientId: string;
  sourceDocumentId?: string;
  name: string;
  uploadDate: string;
  fileName: string;
  tapeType: 'credito' | 'factoraje' | 'otro';
  extractedData: any;
  analystState?: {
    workspaceBlocks?: any[];
    qa?: {
      draft?: string;
      question?: string;
      answer?: string;
      updatedAt?: string;
    };
    updatedAt?: string;
  };
}

export interface SourceDocument {
  id: string;
  orgId: string;
  clientId?: string;
  sourceKind: 'upload' | 'drive' | 'external';
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  documentType: 'financial_statement' | 'loan_tape' | 'institutional_liability' | 'contract' | 'other' | 'unknown';
  storageBucket?: string;
  storagePath?: string;
  extractionStatus: string;
  uploadedBy?: string;
  createdAt: string;
}

// Pasivos Institucionales — the mirror of LoanTape_DB for the other side of the
// balance sheet: who is lending money TO the client, not who the client lends to.
// One row per facility/credit line rather than one row per uploaded file, since
// a client's institutional funding sources are a short, human-scale list.
export interface InstitutionalLiability_DB {
  id: string;
  clientId: string;
  sourceDocumentId?: string;
  lenderName: string;
  liabilityType: 'linea_credito' | 'prestamo_simple' | 'bono' | 'otro';
  originalAmount: number | null;
  currentBalance: number | null;
  currency: string;
  interestRate: number | null; // all-in annual rate as a decimal (0.12 = 12%)
  rateDescription?: string; // human-readable formula, e.g. "TIIE + 350 pb"
  originationDate?: string;
  maturityDate?: string;
  amortization?: string;
  guarantee?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export type RolloutGuardFeature = 'crm' | 'lifecycle';

export interface RolloutMigrationStatus {
  file: string;
  reason: string;
}

export interface RolloutGuardResult {
  missing: RolloutMigrationStatus[];
  unverified: RolloutMigrationStatus[];
}

const FINANCIAL_DOCUMENT_BUCKET = 'financial-documents';

// ── Row mappers ───────────────────────────────────────────────────────────────

const FINANCIAL_KEYS = new Set([
  'amount', 'original_amount', 'originalAmount', 'outstanding_balance', 'outstandingBalance',
  'balance', 'current_due', 'currentDue', 'max_default_amount', 'maxDefaultAmount',
  'total_credit_value', 'totalCreditValue', 'revenue', 'cogs', 'operatingExpenses',
  'operating_expenses', 'ebitda', 'interestExpense', 'interest_expense', 'netIncome',
  'net_income', 'currentAssets', 'current_assets', 'currentLiabilities',
  'current_liabilities', 'totalDebt', 'total_debt', 'totalAssets', 'total_assets',
  'equity', 'value', 'pct', 'percentage', 'rate', 'interest_rate', 'avg_interest_rate',
  'days_overdue', 'avg_days_overdue', 'count', 'riskScore',
]);

export function normalizeFinancialWriteValue(value: unknown): number {
  return parseFinancialNumber(value, 0);
}

function normalizeFinancialObject<T extends Record<string, any>>(obj: T, preserveNullish = false): T {
  return Object.fromEntries(
    Object.entries(obj || {}).map(([key, value]) => [
      key,
      FINANCIAL_KEYS.has(key) && (!preserveNullish || (value !== null && value !== undefined && value !== ''))
        ? normalizeFinancialWriteValue(value)
        : value,
    ]),
  ) as T;
}

function normalizeRawLineItems(items: FinancialStatement_DB['rawLineItems'] = []) {
  return items.map(item => ({
    ...item,
    name: String(item.name || '').trim(),
    value: normalizeFinancialWriteValue(item.value),
    sectionPath: item.sectionPath ?? null,
    statementType: item.statementType || 'otro',
  }));
}

function normalizeExtraAccounts(accounts: FinancialStatement_DB['extraAccounts'] = []) {
  return accounts.map(account => ({
    ...account,
    key: String(account.key || '').trim(),
    label: String(account.label || '').trim(),
    value: normalizeFinancialWriteValue(account.value),
  }));
}

function normalizeMappedData(mappedData: FinancialStatement_DB['mappedData']) {
  return normalizeFinancialObject({ ...mappedData });
}

function normalizeLoanTapeData(data: any): any {
  if (!data || typeof data !== 'object') return data;
  if (Array.isArray(data)) return data;
  const next = { ...data };
  if (Array.isArray(next._standardized)) {
    next._standardized = next._standardized.map((row: any) => normalizeFinancialObject({ ...row }, true));
  }
  if (next._analysis && typeof next._analysis === 'object') {
    next._analysis = normalizeKnownFinancialJson(next._analysis);
  }
  return next;
}

function normalizeKnownFinancialJson(value: any): any {
  if (Array.isArray(value)) return value.map(normalizeKnownFinancialJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (FINANCIAL_KEYS.has(key)) return [key, item === null || item === undefined || item === '' ? item : normalizeFinancialWriteValue(item)];
      if (Array.isArray(item) || (item && typeof item === 'object')) return [key, normalizeKnownFinancialJson(item)];
      return [key, item];
    }),
  );
}

function normalizeAforoHistory(value: any): Client['aforoHistory'] {
  if (!Array.isArray(value)) return [];
  return value.map(item => {
    if (!item || typeof item !== 'object') return item;
    const transactionId = item.transactionId || item.transaction_id || undefined;
    const normalized = { ...item, transactionId };
    delete normalized.transaction_id;
    if (!normalized.transactionId) delete normalized.transactionId;
    return normalized;
  });
}

function normalizePaymentHistory(value: any): Client['paymentHistory'] {
  if (!Array.isArray(value)) return [];
  return value.map(item => {
    if (!item || typeof item !== 'object') return item;
    const transactionId = item.transactionId || item.transaction_id || undefined;
    const normalized = { ...item, transactionId };
    delete normalized.transaction_id;
    if (!normalized.transactionId) delete normalized.transactionId;
    return normalized;
  });
}

function toClient(r: any): Client {
  return {
    id: r.id, orgId: r.org_id || '', name: r.name, taxId: r.tax_id || '', industry: r.industry || '',
    score: r.score || '', currency: r.currency || 'MXN',
    totalCreditValue: normalizeFinancialWriteValue(r.total_credit_value), creditType: r.credit_type || [],
    contractName: r.contract_name || '', analystName: r.analyst_name || '',
    createdBy: r.created_by || '', createdAt: r.created_at,
    paymentHistory: normalizePaymentHistory(r.payment_history), currentDue: normalizeFinancialWriteValue(r.current_due),
    maxDefaultDays: normalizeFinancialWriteValue(r.max_default_days), maxDefaultAmount: normalizeFinancialWriteValue(r.max_default_amount),
    defaultFrequency12m: normalizeFinancialWriteValue(r.default_frequency_12m), opinion: r.opinion || '',
    aforoRequerido: r.aforo_requerido || '', aforoHistory: normalizeAforoHistory(r.aforo_history),
    documentation: r.documentation || [], reportDate: r.report_date || '',
    frequency: r.frequency || 'mensual', lastPeriod: r.last_period || '',
    logoLeft: r.logo_left, logoRight: r.logo_right,
  };
}

function fromClient(c: Omit<Client, 'id' | 'createdAt'>): any {
  return {
    ...(c.orgId ? { org_id: c.orgId } : {}),
    name: c.name, tax_id: c.taxId, industry: c.industry, score: c.score,
    currency: c.currency, total_credit_value: normalizeFinancialWriteValue(c.totalCreditValue), credit_type: c.creditType,
    contract_name: c.contractName, analyst_name: c.analystName, created_by: c.createdBy || null,
    payment_history: c.paymentHistory, current_due: normalizeFinancialWriteValue(c.currentDue),
    max_default_days: normalizeFinancialWriteValue(c.maxDefaultDays), max_default_amount: normalizeFinancialWriteValue(c.maxDefaultAmount),
    default_frequency_12m: c.defaultFrequency12m, opinion: c.opinion,
    aforo_requerido: c.aforoRequerido, aforo_history: c.aforoHistory,
    documentation: c.documentation, report_date: c.reportDate,
    frequency: c.frequency, last_period: c.lastPeriod,
    logo_left: c.logoLeft || null, logo_right: c.logoRight || null,
  };
}

function toTransaction(r: any): Transaction {
  return {
    id: r.id, clientId: r.client_id, name: r.name, description: r.description || '',
    date: r.date || '', creditType: r.credit_type || '', originalAmount: normalizeFinancialWriteValue(r.original_amount),
    currency: r.currency || 'MXN', signedAt: r.signed_at || '', maturityAt: r.maturity_at || '',
    createdBy: r.created_by || '', createdAt: r.created_at,
  };
}

function toContractFile(r: any): ContractFile {
  return {
    id: r.id, transactionId: r.transaction_id, clientId: r.client_id,
    sourceDocumentId: r.source_document_id || undefined,
    originalName: r.original_name, mimeType: r.mime_type || '',
    base64Data: r.base64_data || '', uploadedAt: r.uploaded_at,
    extractionStatus: r.extraction_status || 'pending',
    extractedCovenants: r.extracted_covenants,
  };
}

function toCovenant(r: any): Covenant_DB {
  return {
    id: r.id, clientId: r.client_id, transactionId: r.transaction_id,
    name: r.name, type: r.type, formula: r.formula || '', threshold: normalizeFinancialNumberString(r.threshold),
    operator: r.operator || 'none', description: r.description || '',
    complianceStatus: r.compliance_status || 'pendiente',
    formulaByPeriod: r.formula_by_period || {},
    isCustom: r.is_custom ?? true, extractedFrom: r.extracted_from, createdAt: r.created_at,
  };
}

function toAnnotation(r: any): CovenantAnnotation {
  return {
    id: r.id, covenantId: r.covenant_id, userId: r.user_id || '',
    userName: r.user_name, text: r.text, createdAt: r.created_at,
  };
}

function toCrmContact(r: any): CrmContact {
  return {
    id: r.id,
    clientId: r.client_id,
    name: r.name,
    title: r.title || '',
    department: r.department || '',
    email: r.email || '',
    phone: r.phone || '',
    influence: r.influence || 'medium',
    relationship: r.relationship || 'neutral',
    isPrimary: Boolean(r.is_primary),
    notes: r.notes || '',
    createdBy: r.created_by || '',
    createdAt: r.created_at,
    updatedAt: r.updated_at || r.created_at,
  };
}

function fromCrmContact(contact: Omit<CrmContact, 'id' | 'createdAt' | 'updatedAt'> | Partial<CrmContact>): any {
  const row: any = {};
  if (contact.clientId !== undefined) row.client_id = contact.clientId;
  if (contact.name !== undefined) row.name = contact.name;
  if (contact.title !== undefined) row.title = contact.title;
  if (contact.department !== undefined) row.department = contact.department;
  if (contact.email !== undefined) row.email = contact.email;
  if (contact.phone !== undefined) row.phone = contact.phone;
  if (contact.influence !== undefined) row.influence = contact.influence;
  if (contact.relationship !== undefined) row.relationship = contact.relationship;
  if (contact.isPrimary !== undefined) row.is_primary = contact.isPrimary;
  if (contact.notes !== undefined) row.notes = contact.notes;
  if (contact.createdBy !== undefined) row.created_by = contact.createdBy || null;
  row.updated_at = new Date().toISOString();
  return row;
}

function toCrmActivity(r: any): CrmActivity {
  return {
    id: r.id,
    clientId: r.client_id,
    contactId: r.contact_id || undefined,
    type: r.type || 'task',
    phase: r.phase || '',
    recordType: r.record_type || '',
    nextStage: r.next_stage || '',
    contactName: r.contact_name || '',
    analystName: r.analyst_name || '',
    subject: r.subject,
    quickNote: r.quick_note || '',
    nextStep: r.next_step || '',
    detail: r.detail || '',
    status: r.status || 'planned',
    priority: r.priority || 'normal',
    dueAt: r.due_at || undefined,
    completedAt: r.completed_at || undefined,
    ownerId: r.owner_id || undefined,
    createdBy: r.created_by || '',
    createdAt: r.created_at,
    updatedAt: r.updated_at || r.created_at,
  };
}

function fromCrmActivity(activity: Omit<CrmActivity, 'id' | 'createdAt' | 'updatedAt'> | Partial<CrmActivity>): any {
  const row: any = {};
  if (activity.clientId !== undefined) row.client_id = activity.clientId;
  if (activity.contactId !== undefined) row.contact_id = activity.contactId || null;
  if (activity.type !== undefined) row.type = activity.type;
  if (activity.phase !== undefined) row.phase = activity.phase;
  if (activity.recordType !== undefined) row.record_type = activity.recordType;
  if (activity.nextStage !== undefined) row.next_stage = activity.nextStage;
  if (activity.contactName !== undefined) row.contact_name = activity.contactName;
  if (activity.analystName !== undefined) row.analyst_name = activity.analystName;
  if (activity.subject !== undefined) row.subject = activity.subject;
  if (activity.quickNote !== undefined) row.quick_note = activity.quickNote;
  if (activity.nextStep !== undefined) row.next_step = activity.nextStep;
  if (activity.detail !== undefined) row.detail = activity.detail;
  if (activity.status !== undefined) row.status = activity.status;
  if (activity.priority !== undefined) row.priority = activity.priority;
  if (activity.dueAt !== undefined) row.due_at = activity.dueAt || null;
  if (activity.completedAt !== undefined) row.completed_at = activity.completedAt || null;
  if (activity.ownerId !== undefined) row.owner_id = activity.ownerId || null;
  if (activity.createdBy !== undefined) row.created_by = activity.createdBy || null;
  row.updated_at = new Date().toISOString();
  return row;
}

function jsonArray(value: any) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function jsonObject(value: any) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function toStatement(r: any): FinancialStatement_DB {
  return {
    id: r.id, clientId: r.client_id, sourceDocumentId: r.source_document_id || undefined,
    sourceCompanyName: r.source_company_name,
    documentType: r.document_type, period: r.period, periodDate: r.period_date,
    uploadDate: r.upload_date, fileName: r.file_name || '',
    rawLineItems: jsonArray(r.raw_line_items), mappedData: jsonObject(r.mapped_data) as FinancialStatement_DB['mappedData'],
    extraAccounts: jsonArray(r.extra_accounts),
  };
}

function joinStatementValues(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.flatMap(value => String(value || '').split(',')).map(value => value.trim()).filter(Boolean))).join(', ');
}

function normalizedStatementAccountName(value: unknown) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function rawLineItemMergeKey(item: FinancialStatement_DB['rawLineItems'][number] & { sourceKey?: string; metric?: string }) {
  return [
    item.metric || '',
    item.statementType || 'otro',
    normalizedStatementAccountName(item.name),
  ].join('|');
}

function mergeRawLineItems(items: FinancialStatement_DB['rawLineItems']) {
  const grouped = new Map<string, FinancialStatement_DB['rawLineItems'][number]>();
  for (const item of items || []) {
    const key = rawLineItemMergeKey(item);
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, { ...item, value: normalizeFinancialWriteValue(item.value), sectionPath: item.sectionPath ?? null });
      continue;
    }

    const existingValue = normalizeFinancialWriteValue(existing.value);
    const incomingValue = normalizeFinancialWriteValue(item.value);
    grouped.set(key, {
      ...existing,
      value: existingValue === incomingValue ? existingValue : existingValue + incomingValue,
      sectionPath: existing.sectionPath || item.sectionPath || null,
      source: existing.source || item.source,
      statementType: existing.statementType || item.statementType || 'otro',
    });
  }
  return Array.from(grouped.values());
}

function mergeMappedMetric(current: unknown, incoming: unknown) {
  const a = normalizeFinancialWriteValue(current);
  const b = normalizeFinancialWriteValue(incoming);
  if (!a) return b;
  if (!b) return a;
  if (a === b) return a;
  return a + b;
}

function mergeStatementRows(statements: FinancialStatement_DB[]) {
  const grouped = new Map<string, FinancialStatement_DB>();
  for (const statement of statements) {
    const key = `${statement.clientId}|${statement.periodDate || statement.period}`;
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, {
        ...statement,
        rawLineItems: mergeRawLineItems(statement.rawLineItems || []),
        mappedData: { ...EMPTY_MAPPED_DATA, ...(statement.mappedData || {}) },
        extraAccounts: [...(statement.extraAccounts || [])],
      });
      continue;
    }

    existing.rawLineItems = mergeRawLineItems([...existing.rawLineItems, ...(statement.rawLineItems || [])]);

    const allMetrics = new Set([...Object.keys(existing.mappedData || {}), ...Object.keys(statement.mappedData || {})]);
    for (const metric of allMetrics) {
      existing.mappedData[metric] = mergeMappedMetric(existing.mappedData?.[metric], statement.mappedData?.[metric]);
    }

    const extraKeys = new Set(existing.extraAccounts.map(account => `${account.key}|${account.label}|${normalizeFinancialWriteValue(account.value)}`));
    for (const account of statement.extraAccounts || []) {
      const accountKey = `${account.key}|${account.label}|${normalizeFinancialWriteValue(account.value)}`;
      if (!extraKeys.has(accountKey)) {
        existing.extraAccounts.push(account);
        extraKeys.add(accountKey);
      }
    }

    existing.sourceDocumentId = existing.sourceDocumentId || statement.sourceDocumentId;
    existing.sourceCompanyName = existing.sourceCompanyName || statement.sourceCompanyName;
    existing.documentType = joinStatementValues([existing.documentType, statement.documentType]) || existing.documentType || statement.documentType;
    existing.fileName = joinStatementValues([existing.fileName, statement.fileName]);
    existing.period = existing.period || statement.period;
  }
  return Array.from(grouped.values());
}

function toLoanTape(r: any): LoanTape_DB {
  return {
    id: r.id, clientId: r.client_id, sourceDocumentId: r.source_document_id || undefined,
    name: r.name,
    uploadDate: r.upload_date, fileName: r.file_name || '',
    tapeType: r.tape_type || 'credito', extractedData: r.extracted_data,
    analystState: r.analyst_state || undefined,
  };
}

function toInstitutionalLiability(r: any): InstitutionalLiability_DB {
  return {
    id: r.id, clientId: r.client_id, sourceDocumentId: r.source_document_id || undefined,
    lenderName: r.lender_name,
    liabilityType: r.liability_type || 'linea_credito',
    originalAmount: r.original_amount === null || r.original_amount === undefined ? null : Number(r.original_amount),
    currentBalance: r.current_balance === null || r.current_balance === undefined ? null : Number(r.current_balance),
    currency: r.currency || 'MXN',
    interestRate: r.interest_rate === null || r.interest_rate === undefined ? null : Number(r.interest_rate),
    rateDescription: r.rate_description || undefined,
    originationDate: r.origination_date || undefined,
    maturityDate: r.maturity_date || undefined,
    amortization: r.amortization || undefined,
    guarantee: r.guarantee || undefined,
    notes: r.notes || undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toSourceDocument(r: any): SourceDocument {
  return {
    id: r.id,
    orgId: r.org_id,
    clientId: r.client_id || undefined,
    sourceKind: r.source_kind || 'external',
    fileName: r.file_name,
    mimeType: r.mime_type || '',
    sizeBytes: Number(r.size_bytes || 0),
    documentType: r.document_type || 'unknown',
    storageBucket: r.storage_bucket || undefined,
    storagePath: r.storage_path || undefined,
    extractionStatus: r.extraction_status || 'pending',
    uploadedBy: r.uploaded_by || undefined,
    createdAt: r.created_at,
  };
}

function err(label: string, e: any): never {
  throw new Error(`${label}: ${e?.message || e}`);
}

function isMissingSchemaError(error: any, name?: string) {
  const message = String(error?.message || error || '');
  return /schema cache|could not find|does not exist|column .* does not exist/i.test(message)
    && (!name || message.includes(name));
}

function uniqueMigrationStatuses(items: RolloutMigrationStatus[]) {
  const seen = new Set<string>();
  return items.filter(item => {
    if (seen.has(item.file)) return false;
    seen.add(item.file);
    return true;
  });
}

const ROLLOUT_MIGRATIONS = {
  crmRelationship: {
    version: '20260706',
    file: 'database/20260706_crm_relationship_layer.sql',
    reason: 'Crea crm_contacts, crm_activities y sus políticas RLS.',
  },
  crmSheetFields: {
    version: '20260706',
    file: 'database/20260706_crm_sheet_fields.sql',
    reason: 'Agrega phase, record_type, next_stage, contact_name, analyst_name, quick_note y next_step a crm_activities.',
  },
  facilityAforoHistory: {
    version: '20260701',
    file: 'database/20260701_facility_specific_aforo_history.sql',
    reason: 'Etiqueta el aforo histórico legacy con transactionId cuando el cliente tiene una sola facility.',
  },
} as const;

async function readAppliedMigrationVersions(): Promise<Set<string> | null> {
  try {
    const client = (supabase as any).schema?.('supabase_migrations') || supabase;
    const { data, error } = await client
      .from('schema_migrations')
      .select('version')
      .in('version', [ROLLOUT_MIGRATIONS.facilityAforoHistory.version]);
    if (error) return null;
    return new Set((data || []).map((row: any) => String(row.version || '')));
  } catch {
    return null;
  }
}

async function probeSelect(table: string, columns: string) {
  return supabase.from(table).select(columns).limit(1);
}

async function findMissingLifecycleDataMigration(): Promise<RolloutMigrationStatus[]> {
  const [clients, transactions] = await Promise.all([
    supabase.from('clients').select('id,aforo_history'),
    supabase.from('transactions').select('id,client_id'),
  ]);
  if (clients.error || transactions.error) return [];

  const transactionCountByClient = new Map<string, number>();
  for (const transaction of transactions.data || []) {
    const clientId = String((transaction as any).client_id || '');
    if (!clientId) continue;
    transactionCountByClient.set(clientId, (transactionCountByClient.get(clientId) || 0) + 1);
  }

  const hasUntaggedSingleFacilityAforo = (clients.data || []).some((client: any) => {
    if ((transactionCountByClient.get(client.id) || 0) !== 1) return false;
    const history = Array.isArray(client.aforo_history) ? client.aforo_history : [];
    return history.some((item: any) => item && typeof item === 'object' && !item.transactionId && !item.transaction_id);
  });

  return hasUntaggedSingleFacilityAforo ? [ROLLOUT_MIGRATIONS.facilityAforoHistory] : [];
}

async function findMissingRolloutSchema(feature: RolloutGuardFeature): Promise<RolloutMigrationStatus[]> {
  const missing: RolloutMigrationStatus[] = [];

  if (feature === 'crm') {
    const [contacts, activities] = await Promise.all([
      probeSelect('crm_contacts', 'id'),
      probeSelect('crm_activities', 'id,client_id,subject,status,due_at,created_at'),
    ]);
    if (contacts.error && isMissingSchemaError(contacts.error, 'crm_contacts')) {
      missing.push(ROLLOUT_MIGRATIONS.crmRelationship);
    }
    if (activities.error && isMissingSchemaError(activities.error, 'crm_activities')) {
      missing.push(ROLLOUT_MIGRATIONS.crmRelationship);
    }
    if (!activities.error) {
      const sheetFields = await probeSelect('crm_activities', 'phase,record_type,next_stage,contact_name,analyst_name,quick_note,next_step');
      if (sheetFields.error && isMissingSchemaError(sheetFields.error)) {
        missing.push(ROLLOUT_MIGRATIONS.crmSheetFields);
      }
    }
  }

  const transactions = await probeSelect('transactions', 'id,client_id,name,signed_at,maturity_at');
  if (transactions.error && isMissingSchemaError(transactions.error)) {
    missing.push({
      file: 'database/schema.sql',
      reason: 'La vista necesita la tabla transactions con signed_at y maturity_at.',
    });
  }

  if (feature === 'lifecycle') {
    missing.push(...await findMissingLifecycleDataMigration());
  }

  return uniqueMigrationStatuses(missing);
}

async function currentAuthUser() {
  const { data } = await supabase.auth.getUser();
  return data.user;
}

async function resolveOrgId(userId?: string): Promise<string | null> {
  if (!userId) return null;
  const authUser = await currentAuthUser();
  if (!authUser || authUser.id !== userId) return null;

  const { data: profile, error: profileError } = await supabase.from('profiles').select('org_id').eq('id', userId).maybeSingle();
  if (profileError && !/column .*org_id|org_id.*column|schema cache/i.test(profileError.message || '')) {
    err('resolveOrgId', profileError);
  }
  if (profile?.org_id) return profile.org_id;

  try {
    const { data: { session } } = await supabase.auth.getSession();
    const response = await fetch('/api/admin/org/ensure', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
      },
      body: JSON.stringify({}),
    });
    const json = await response.json().catch(() => ({}));
    if (response.ok && json.orgId) return json.orgId;
  } catch {
    // The server endpoint is authoritative for assigning organizations.
  }
  return null;
}

function legacyLocalValue<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : fallback;
  } catch {
    return fallback;
  }
}

function safeFileName(name: string): string {
  const cleaned = name.normalize('NFKD')
    .replace(/[^\w.\-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || `document_${Date.now()}`;
}

function documentStoragePath(orgId: string, clientId: string, documentType: SourceDocument['documentType'], fileName: string): string {
  const id = crypto.randomUUID();
  return `${orgId}/${clientId}/${documentType}/${id}/${safeFileName(fileName)}`;
}

// ── DB object ────────────────────────────────────────────────────────────────
export const db = {
  async checkRolloutMigrations(feature: RolloutGuardFeature): Promise<RolloutGuardResult> {
    const [appliedVersions, missingSchema] = await Promise.all([
      readAppliedMigrationVersions(),
      findMissingRolloutSchema(feature),
    ]);
    const missing = [...missingSchema];
    const unverified: RolloutMigrationStatus[] = [];

    if (feature === 'lifecycle') {
      const migration = ROLLOUT_MIGRATIONS.facilityAforoHistory;
      if (appliedVersions?.has(migration.version) === false) {
        missing.push(migration);
      } else if (appliedVersions === null) {
        unverified.push(migration);
      }
    }

    return {
      missing: uniqueMigrationStatuses(missing),
      unverified: uniqueMigrationStatuses(unverified),
    };
  },

  // ── Users ──────────────────────────────────────────────────────────────────
  async getUsers(): Promise<User[]> {
    const { data, error } = await supabase.from('profiles').select('*').order('created_at');
    if (error) err('getUsers', error);
    return (data || []).map(r => ({ id: r.id, name: r.name, email: r.email || '', role: r.role, createdAt: r.created_at }));
  },

  async getUserByEmail(email: string): Promise<User | undefined> {
    const { data } = await supabase.from('profiles').select('*').eq('email', email.toLowerCase()).maybeSingle();
    if (!data) return undefined;
    return { id: data.id, name: data.name, email: data.email || '', role: data.role, createdAt: data.created_at };
  },

  async createUser(data: { name: string; email: string; password: string; role: ActiveRole }): Promise<User> {
    const { data: authData } = await supabase.auth.getSession();
    const res = await fetch('/api/admin/users/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authData.session?.access_token ? { Authorization: `Bearer ${authData.session.access_token}` } : {}),
      },
      body: JSON.stringify(data),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Error al crear usuario');
    return json;
  },

  async updateUser(id: string, updates: Partial<User>): Promise<void> {
    const row: any = {};
    if (updates.name) row.name = updates.name;
    if (updates.role) row.role = updates.role;
    if (updates.email) row.email = updates.email;
    const { error } = await supabase.from('profiles').update(row).eq('id', id);
    if (error) err('updateUser', error);
  },

  async deleteUser(id: string): Promise<void> {
    const { data: authData } = await supabase.auth.getSession();
    const res = await fetch('/api/admin/users/delete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authData.session?.access_token ? { Authorization: `Bearer ${authData.session.access_token}` } : {}),
      },
      body: JSON.stringify({ userId: id }),
    });
    if (!res.ok) { const j = await res.json(); throw new Error(j.error || 'Error al eliminar usuario'); }
  },

  // ── Clients ────────────────────────────────────────────────────────────────
  async createClient(data: Omit<Client, 'id' | 'createdAt'>): Promise<Client> {
    const payload = fromClient(data);
    const authUser = await currentAuthUser();
    if (!authUser?.id) throw new Error('No se pudo identificar al usuario autenticado.');
    payload.created_by = authUser.id;
    const orgId = await resolveOrgId(authUser.id);
    if (!orgId) throw new Error('No se pudo preparar la organización del usuario. Intenta cerrar sesión e iniciar con Google nuevamente.');
    payload.org_id = orgId;
    let { data: row, error } = await supabase.from('clients').insert(payload).select().single();
    if (error && /org_id|organización|organization/i.test(error.message || '')) {
      const ensuredOrgId = await resolveOrgId(authUser.id);
      if (ensuredOrgId) {
        const retry = await supabase.from('clients').insert({ ...payload, org_id: ensuredOrgId }).select().single();
        row = retry.data;
        error = retry.error;
      }
    }
    if (error) err('createClient', error);
    return toClient(row);
  },

  async getClients(): Promise<Client[]> {
    const { data, error } = await supabase.from('clients').select('*').order('created_at', { ascending: false });
    if (error) err('getClients', error);
    return (data || []).map(toClient);
  },

  async getClientById(id: string): Promise<Client | undefined> {
    const { data } = await supabase.from('clients').select('*').eq('id', id).maybeSingle();
    return data ? toClient(data) : undefined;
  },

  async updateClient(id: string, updates: Partial<Client>): Promise<void> {
    const row: any = {};
    if (updates.name !== undefined) row.name = updates.name;
    if (updates.taxId !== undefined) row.tax_id = updates.taxId;
    if (updates.industry !== undefined) row.industry = updates.industry;
    if (updates.score !== undefined) row.score = updates.score;
    if (updates.currency !== undefined) row.currency = updates.currency;
    if (updates.totalCreditValue !== undefined) row.total_credit_value = normalizeFinancialWriteValue(updates.totalCreditValue);
    if (updates.creditType !== undefined) row.credit_type = updates.creditType;
    if (updates.contractName !== undefined) row.contract_name = updates.contractName;
    if (updates.analystName !== undefined) row.analyst_name = updates.analystName;
    if (updates.paymentHistory !== undefined) row.payment_history = updates.paymentHistory;
    if (updates.currentDue !== undefined) row.current_due = normalizeFinancialWriteValue(updates.currentDue);
    if (updates.maxDefaultDays !== undefined) row.max_default_days = normalizeFinancialWriteValue(updates.maxDefaultDays);
    if (updates.maxDefaultAmount !== undefined) row.max_default_amount = normalizeFinancialWriteValue(updates.maxDefaultAmount);
    if (updates.defaultFrequency12m !== undefined) row.default_frequency_12m = updates.defaultFrequency12m;
    if (updates.opinion !== undefined) row.opinion = updates.opinion;
    if (updates.aforoRequerido !== undefined) row.aforo_requerido = updates.aforoRequerido;
    if (updates.aforoHistory !== undefined) row.aforo_history = updates.aforoHistory;
    if (updates.documentation !== undefined) row.documentation = updates.documentation;
    if (updates.reportDate !== undefined) row.report_date = updates.reportDate;
    if (updates.frequency !== undefined) row.frequency = updates.frequency;
    if (updates.lastPeriod !== undefined) row.last_period = updates.lastPeriod;
    if (updates.logoLeft !== undefined) row.logo_left = updates.logoLeft;
    if (updates.logoRight !== undefined) row.logo_right = updates.logoRight;
    const { error } = await supabase.from('clients').update(row).eq('id', id);
    if (error) err('updateClient', error);
  },

  async deleteClient(id: string): Promise<void> {
    const { error } = await supabase.from('clients').delete().eq('id', id);
    if (error) err('deleteClient', error);
  },

  async getClientSetting<T>(clientId: string, key: string, fallback: T): Promise<T> {
    const localFallback = () => legacyLocalValue(key, fallback);
    const hasLegacyLocal = () => {
      try { return localStorage.getItem(key) !== null; } catch { return false; }
    };
    const { data, error } = await supabase
      .from('client_settings')
      .select('value')
      .eq('client_id', clientId)
      .eq('key', key)
      .maybeSingle();
    if (error) {
      const legacy = await supabase
        .from('custom_fields')
        .select('value')
        .eq('client_id', clientId)
        .eq('label', `__setting:${key}`)
        .maybeSingle();
      if (!legacy.error && legacy.data?.value) {
        try {
          const parsed = JSON.parse(legacy.data.value);
          localStorage.setItem(key, JSON.stringify(parsed));
          return parsed as T;
        } catch {}
      }
      const value = localFallback();
      if (value !== fallback) void this.setClientSetting(clientId, key, value);
      return value;
    }
    if (data?.value === undefined || data?.value === null) {
      const value = localFallback();
      if (hasLegacyLocal()) void this.setClientSetting(clientId, key, value);
      return value;
    }
    localStorage.setItem(key, JSON.stringify(data.value));
    return data.value as T;
  },

  async setClientSetting<T>(clientId: string, key: string, value: T): Promise<void> {
    localStorage.setItem(key, JSON.stringify(value));
    const { error } = await supabase
      .from('client_settings')
      .upsert({ client_id: clientId, key, value, updated_at: new Date().toISOString() }, { onConflict: 'client_id,key' });
    if (error) {
      await supabase.from('custom_fields').delete().eq('client_id', clientId).eq('label', `__setting:${key}`);
      const legacy = await supabase.from('custom_fields').insert({
        client_id: clientId,
        label: `__setting:${key}`,
        value: JSON.stringify(value),
        field_type: 'setting',
      });
      if (legacy.error) console.warn(`setClientSetting fallback local (${key}):`, legacy.error.message);
    }
  },

  async getOrgSetting<T>(userId: string, key: string, fallback: T): Promise<T> {
    const orgId = await resolveOrgId(userId);
    const localFallback = () => legacyLocalValue(key, fallback);
    if (!orgId) return localFallback();
    const { data, error } = await supabase
      .from('org_settings')
      .select('value')
      .eq('org_id', orgId)
      .eq('key', key)
      .maybeSingle();
    if (error) {
      const value = localFallback();
      if (value !== fallback) void this.setOrgSetting(userId, key, value);
      return value;
    }
    if (data?.value === undefined || data?.value === null) {
      const value = localFallback();
      if (value !== fallback) void this.setOrgSetting(userId, key, value);
      return value;
    }
    return data.value as T;
  },

  async setOrgSetting<T>(userId: string, key: string, value: T): Promise<void> {
    const orgId = await resolveOrgId(userId);
    if (!orgId) {
      localStorage.setItem(key, JSON.stringify(value));
      return;
    }
    const { error } = await supabase
      .from('org_settings')
      .upsert({ org_id: orgId, key, value, updated_at: new Date().toISOString() }, { onConflict: 'org_id,key' });
    if (error) {
      console.warn(`setOrgSetting fallback local (${key}):`, error.message);
      localStorage.setItem(key, JSON.stringify(value));
    }
  },

  // ── Custom Fields ──────────────────────────────────────────────────────────
  async setCustomFields(clientId: string, fields: CustomField[]): Promise<void> {
    await supabase.from('custom_fields').delete().eq('client_id', clientId).not('label', 'like', '__setting:%');
    const cleanFields = fields.filter(f => f.label.trim() && !f.label.startsWith('__setting:'));
    if (cleanFields.length > 0) {
      const rows = cleanFields.map(f => ({
        ...(f.id && f.id.length === 36 ? { id: f.id } : {}),
        client_id: clientId,
        label: f.label,
        value: f.value,
        field_type: f.fieldType,
      }));
      const { error } = await supabase.from('custom_fields').insert(rows);
      if (error) err('setCustomFields', error);
    }
  },

  async getCustomFields(clientId: string): Promise<CustomField[]> {
    const { data, error } = await supabase.from('custom_fields').select('*').eq('client_id', clientId);
    if (error) err('getCustomFields', error);
    return (data || [])
      .filter(r => !String(r.label || '').startsWith('__setting:'))
      .map(r => ({ id: r.id, clientId: r.client_id, label: r.label, value: r.value || '', fieldType: r.field_type as any }));
  },

  async getCustomFieldsForClients(clientIds: string[]): Promise<Record<string, CustomField[]>> {
    if (!clientIds.length) return {};
    const { data, error } = await supabase.from('custom_fields').select('*').in('client_id', clientIds);
    if (error) err('getCustomFieldsForClients', error);
    return (data || [])
      .filter(r => !String(r.label || '').startsWith('__setting:'))
      .reduce((acc, r) => {
        const clientId = r.client_id;
        (acc[clientId] ||= []).push({ id: r.id, clientId, label: r.label, value: r.value || '', fieldType: r.field_type as any });
        return acc;
      }, {} as Record<string, CustomField[]>);
  },

  // ── CRM ────────────────────────────────────────────────────────────────────
  async createCrmContact(data: Omit<CrmContact, 'id' | 'createdAt' | 'updatedAt'>): Promise<CrmContact> {
    const { data: row, error } = await supabase.from('crm_contacts').insert(fromCrmContact(data)).select().single();
    if (error && isMissingSchemaError(error, 'crm_contacts')) {
      throw new Error('Falta aplicar la migración CRM en Supabase: database/20260706_crm_relationship_layer.sql');
    }
    if (error) err('createCrmContact', error);
    return toCrmContact(row);
  },

  async getCrmContacts(clientId: string): Promise<CrmContact[]> {
    const { data, error } = await supabase
      .from('crm_contacts')
      .select('*')
      .eq('client_id', clientId)
      .order('is_primary', { ascending: false })
      .order('created_at', { ascending: false });
    if (error && isMissingSchemaError(error, 'crm_contacts')) return [];
    if (error) err('getCrmContacts', error);
    return (data || []).map(toCrmContact);
  },

  async updateCrmContact(id: string, updates: Partial<CrmContact>): Promise<void> {
    const { error } = await supabase.from('crm_contacts').update(fromCrmContact(updates)).eq('id', id);
    if (error && isMissingSchemaError(error, 'crm_contacts')) {
      throw new Error('Falta aplicar la migración CRM en Supabase: database/20260706_crm_relationship_layer.sql');
    }
    if (error) err('updateCrmContact', error);
  },

  async deleteCrmContact(id: string): Promise<void> {
    const { error } = await supabase.from('crm_contacts').delete().eq('id', id);
    if (error && isMissingSchemaError(error, 'crm_contacts')) {
      throw new Error('Falta aplicar la migración CRM en Supabase: database/20260706_crm_relationship_layer.sql');
    }
    if (error) err('deleteCrmContact', error);
  },

  async createCrmActivity(data: Omit<CrmActivity, 'id' | 'createdAt' | 'updatedAt'>): Promise<CrmActivity> {
    const { data: row, error } = await supabase.from('crm_activities').insert(fromCrmActivity(data)).select().single();
    if (error && isMissingSchemaError(error, 'crm_activities')) {
      throw new Error('Falta aplicar la migración CRM en Supabase: database/20260706_crm_relationship_layer.sql');
    }
    if (error && isMissingSchemaError(error)) {
      throw new Error('Falta aplicar la migración de campos del tracker: database/20260706_crm_sheet_fields.sql');
    }
    if (error) err('createCrmActivity', error);
    return toCrmActivity(row);
  },

  async getCrmActivities(clientId: string): Promise<CrmActivity[]> {
    const { data, error } = await supabase
      .from('crm_activities')
      .select('*')
      .eq('client_id', clientId)
      .order('due_at', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: false });
    if (error && isMissingSchemaError(error, 'crm_activities')) return [];
    if (error) err('getCrmActivities', error);
    return (data || []).map(toCrmActivity);
  },

  async getCrmActivitiesForClients(clientIds: string[]): Promise<Record<string, CrmActivity[]>> {
    if (!clientIds.length) return {};
    const { data, error } = await supabase
      .from('crm_activities')
      .select('*')
      .in('client_id', clientIds)
      .order('due_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false });
    if (error && isMissingSchemaError(error, 'crm_activities')) return {};
    if (error) err('getCrmActivitiesForClients', error);
    return (data || []).map(toCrmActivity).reduce((acc, activity) => {
      (acc[activity.clientId] ||= []).push(activity);
      return acc;
    }, {} as Record<string, CrmActivity[]>);
  },

  async updateCrmActivity(id: string, updates: Partial<CrmActivity>): Promise<void> {
    const { error } = await supabase.from('crm_activities').update(fromCrmActivity(updates)).eq('id', id);
    if (error && isMissingSchemaError(error, 'crm_activities')) {
      throw new Error('Falta aplicar la migración CRM en Supabase: database/20260706_crm_relationship_layer.sql');
    }
    if (error) err('updateCrmActivity', error);
  },

  async deleteCrmActivity(id: string): Promise<void> {
    const { error } = await supabase.from('crm_activities').delete().eq('id', id);
    if (error && isMissingSchemaError(error, 'crm_activities')) {
      throw new Error('Falta aplicar la migración CRM en Supabase: database/20260706_crm_relationship_layer.sql');
    }
    if (error) err('deleteCrmActivity', error);
  },

  async getCrmTimeline(clientId: string): Promise<CrmTimelineItem[]> {
    const [contacts, activities] = await Promise.all([
      this.getCrmContacts(clientId),
      this.getCrmActivities(clientId),
    ]);
    return [
      ...contacts.map(contact => ({
        id: contact.id,
        kind: 'contact' as const,
        title: `Contacto agregado: ${contact.name}`,
        detail: [contact.title, contact.department, contact.email].filter(Boolean).join(' · '),
        at: contact.createdAt,
        status: contact.relationship,
      })),
      ...activities.map(activity => ({
        id: activity.id,
        kind: 'activity' as const,
        title: activity.subject,
        detail: [activity.phase, activity.recordType, activity.quickNote || activity.detail, activity.nextStep].filter(Boolean).join(' · ') || activity.type,
        at: activity.completedAt || activity.dueAt || activity.createdAt,
        status: activity.status,
      })),
    ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  },

  // ── Transactions ───────────────────────────────────────────────────────────
  async createTransaction(data: Omit<Transaction, 'id' | 'createdAt'>): Promise<Transaction> {
    const { data: row, error } = await supabase.from('transactions').insert({
      client_id: data.clientId, name: data.name, description: data.description,
      date: data.date, credit_type: data.creditType, original_amount: normalizeFinancialWriteValue(data.originalAmount),
      currency: data.currency, signed_at: data.signedAt, maturity_at: data.maturityAt,
      created_by: data.createdBy || null,
    }).select().single();
    if (error) err('createTransaction', error);
    return toTransaction(row);
  },

  async getTransactions(clientId: string): Promise<Transaction[]> {
    const { data, error } = await supabase.from('transactions').select('*').eq('client_id', clientId).order('created_at', { ascending: false });
    if (error) err('getTransactions', error);
    return (data || []).map(toTransaction);
  },

  async getTransactionsForClients(clientIds: string[]): Promise<Record<string, Transaction[]>> {
    if (!clientIds.length) return {};
    const { data, error } = await supabase.from('transactions').select('*').in('client_id', clientIds).order('created_at', { ascending: false });
    if (error) err('getTransactionsForClients', error);
    return (data || []).map(toTransaction).reduce((acc, transaction) => {
      (acc[transaction.clientId] ||= []).push(transaction);
      return acc;
    }, {} as Record<string, Transaction[]>);
  },

  async getTransactionById(id: string): Promise<Transaction | undefined> {
    const { data } = await supabase.from('transactions').select('*').eq('id', id).maybeSingle();
    return data ? toTransaction(data) : undefined;
  },

  async updateTransaction(id: string, updates: Partial<Transaction>): Promise<void> {
    const row: any = {};
    if (updates.name !== undefined) row.name = updates.name;
    if (updates.description !== undefined) row.description = updates.description;
    if (updates.date !== undefined) row.date = updates.date;
    if (updates.creditType !== undefined) row.credit_type = updates.creditType;
    if (updates.originalAmount !== undefined) row.original_amount = normalizeFinancialWriteValue(updates.originalAmount);
    if (updates.currency !== undefined) row.currency = updates.currency;
    if (updates.signedAt !== undefined) row.signed_at = updates.signedAt;
    if (updates.maturityAt !== undefined) row.maturity_at = updates.maturityAt;
    const { error } = await supabase.from('transactions').update(row).eq('id', id);
    if (error) err('updateTransaction', error);
  },

  async deleteTransaction(id: string): Promise<void> {
    const { error } = await supabase.from('transactions').delete().eq('id', id);
    if (error) err('deleteTransaction', error);
  },

  // ── Contract Files ─────────────────────────────────────────────────────────
  async addContractFile(data: Omit<ContractFile, 'id' | 'uploadedAt'>): Promise<ContractFile> {
    const payload = {
      transaction_id: data.transactionId, client_id: data.clientId,
      source_document_id: data.sourceDocumentId || null,
      original_name: data.originalName, mime_type: data.mimeType,
      base64_data: data.base64Data, extraction_status: data.extractionStatus,
      extracted_covenants: data.extractedCovenants || null,
    };
    let { data: row, error } = await supabase.from('contract_files').insert(payload).select().single();
    if (error && isMissingSchemaError(error, 'source_document_id')) {
      const { source_document_id, ...fallbackPayload } = payload;
      const retry = await supabase.from('contract_files').insert(fallbackPayload).select().single();
      row = retry.data;
      error = retry.error;
    }
    if (error) err('addContractFile', error);
    return toContractFile(row);
  },

  async getContractFiles(transactionId: string): Promise<ContractFile[]> {
    const { data, error } = await supabase.from('contract_files').select('*').eq('transaction_id', transactionId).order('uploaded_at');
    if (error) err('getContractFiles', error);
    return (data || []).map(toContractFile);
  },

  async getContractFilesForTransactions(transactionIds: string[]): Promise<Record<string, ContractFile[]>> {
    if (!transactionIds.length) return {};
    const { data, error } = await supabase
      .from('contract_files')
      .select('*')
      .in('transaction_id', transactionIds)
      .order('uploaded_at', { ascending: false });
    if (error) err('getContractFilesForTransactions', error);
    return (data || []).map(toContractFile).reduce((acc, file) => {
      (acc[file.transactionId] ||= []).push(file);
      return acc;
    }, {} as Record<string, ContractFile[]>);
  },

  async updateContractFile(id: string, updates: Partial<ContractFile>): Promise<void> {
    const row: any = {};
    if (updates.extractionStatus !== undefined) row.extraction_status = updates.extractionStatus;
    if (updates.extractedCovenants !== undefined) row.extracted_covenants = updates.extractedCovenants;
    const { error } = await supabase.from('contract_files').update(row).eq('id', id);
    if (error) err('updateContractFile', error);
  },

  async deleteContractFile(id: string): Promise<void> {
    const { error } = await supabase.from('contract_files').delete().eq('id', id);
    if (error) err('deleteContractFile', error);
  },

  // ── Covenants ──────────────────────────────────────────────────────────────
  async createCovenant(data: Omit<Covenant_DB, 'id' | 'createdAt'>): Promise<Covenant_DB> {
    const payload: any = {
      client_id: data.clientId, transaction_id: data.transactionId || null,
      name: data.name, type: data.type, formula: data.formula, threshold: normalizeFinancialNumberString(data.threshold),
      operator: data.operator, description: data.description,
      compliance_status: data.complianceStatus || 'pendiente',
      formula_by_period: data.formulaByPeriod || {},
      is_custom: data.isCustom, extracted_from: data.extractedFrom || null,
    };
    let { data: row, error } = await supabase.from('covenants').insert(payload).select().single();
    if (error && String(error.message || '').includes('formula_by_period')) {
      delete payload.formula_by_period;
      const retry = await supabase.from('covenants').insert(payload).select().single();
      row = retry.data;
      error = retry.error;
    }
    if (error) err('createCovenant', error);
    return toCovenant(row);
  },

  async getCovenants(clientId: string): Promise<Covenant_DB[]> {
    const { data, error } = await supabase.from('covenants').select('*').eq('client_id', clientId).order('created_at');
    if (error) err('getCovenants', error);
    return (data || []).map(toCovenant);
  },

  async getCovenantById(id: string): Promise<Covenant_DB | undefined> {
    const { data } = await supabase.from('covenants').select('*').eq('id', id).maybeSingle();
    return data ? toCovenant(data) : undefined;
  },

  async updateCovenant(id: string, updates: Partial<Covenant_DB>): Promise<void> {
    const row: any = {};
    if (updates.transactionId !== undefined) row.transaction_id = updates.transactionId || null;
    if (updates.name !== undefined) row.name = updates.name;
    if (updates.formula !== undefined) row.formula = updates.formula;
    if (updates.threshold !== undefined) row.threshold = normalizeFinancialNumberString(updates.threshold);
    if (updates.operator !== undefined) row.operator = updates.operator;
    if (updates.description !== undefined) row.description = updates.description;
    if (updates.formulaByPeriod !== undefined) row.formula_by_period = updates.formulaByPeriod;
    if ((updates as any).complianceStatus !== undefined) row.compliance_status = (updates as any).complianceStatus;
    let { error } = await supabase.from('covenants').update(row).eq('id', id);
    if (error && String(error.message || '').includes('formula_by_period')) {
      delete row.formula_by_period;
      if (Object.keys(row).length === 0) return;
      const retry = await supabase.from('covenants').update(row).eq('id', id);
      error = retry.error;
    }
    if (error) err('updateCovenant', error);
  },

  async deleteCovenant(id: string): Promise<void> {
    const { error } = await supabase.from('covenants').delete().eq('id', id);
    if (error) err('deleteCovenant', error);
  },

  // ── Covenant Annotations ───────────────────────────────────────────────────
  async addAnnotation(data: Omit<CovenantAnnotation, 'id' | 'createdAt'>): Promise<CovenantAnnotation> {
    const userId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(data.userId || '')
      ? data.userId
      : null;
    const { data: row, error } = await supabase.from('covenant_annotations').insert({
      covenant_id: data.covenantId, user_id: userId,
      user_name: data.userName, text: data.text,
    }).select().single();
    if (error) err('addAnnotation', error);
    return toAnnotation(row);
  },

  async getAnnotations(covenantId: string): Promise<CovenantAnnotation[]> {
    const { data, error } = await supabase.from('covenant_annotations').select('*').eq('covenant_id', covenantId).order('created_at');
    if (error) err('getAnnotations', error);
    return (data || []).map(toAnnotation);
  },

  // ── Private Source Documents ───────────────────────────────────────────────
  async uploadClientDocument(
    clientId: string,
    file: File,
    documentType: SourceDocument['documentType'],
    metadata: Record<string, any> = {},
  ): Promise<SourceDocument> {
    const authUser = await currentAuthUser();
    if (!authUser?.id) throw new Error('No se pudo identificar al usuario autenticado.');
    const orgId = await resolveOrgId(authUser.id);
    if (!orgId) throw new Error('No se pudo resolver la organización para guardar el archivo.');

    let storagePath = documentStoragePath(orgId, clientId, documentType, file.name);
    let storageBucket: string | null = FINANCIAL_DOCUMENT_BUCKET;
    let storageWarning = '';
    const mimeType = file.type || 'application/octet-stream';
    const uploaded = await supabase.storage
      .from(FINANCIAL_DOCUMENT_BUCKET)
      .upload(storagePath, file, {
        contentType: mimeType,
        cacheControl: '3600',
        upsert: false,
      });
    if (uploaded.error) {
      storageWarning = `No se guardó el original en Supabase Storage: ${uploaded.error.message || 'error de almacenamiento'}.`;
      storagePath = '';
      storageBucket = null;
    }

    const { data: row, error } = await supabase.from('documents').insert({
      org_id: orgId,
      client_id: clientId,
      source_kind: 'upload',
      source_uri: storageBucket ? `supabase://${storageBucket}/${storagePath}` : `upload://${safeFileName(file.name)}`,
      storage_bucket: storageBucket,
      storage_path: storagePath || null,
      file_name: file.name,
      mime_type: mimeType,
      size_bytes: file.size,
      document_type: documentType,
      extraction_status: 'uploaded',
      raw_metadata: storageWarning ? { ...metadata, storageWarning } : metadata,
      uploaded_by: authUser.id,
    }).select().single();

    if (error) {
      if (storageBucket && storagePath) await supabase.storage.from(FINANCIAL_DOCUMENT_BUCKET).remove([storagePath]);
      if (isMissingSchemaError(error, 'documents')) {
        return {
          id: '',
          orgId,
          clientId,
          sourceKind: 'upload',
          fileName: file.name,
          mimeType,
          sizeBytes: file.size,
          documentType,
          extractionStatus: 'uploaded',
          uploadedBy: authUser.id,
          createdAt: new Date().toISOString(),
        };
      }
      err('uploadClientDocument.record', error);
    }
    return toSourceDocument(row);
  },

  async getSourceDocument(id: string): Promise<SourceDocument | undefined> {
    const { data } = await supabase.from('documents').select('*').eq('id', id).maybeSingle();
    return data ? toSourceDocument(data) : undefined;
  },

  async createSignedDocumentUrl(id: string, expiresIn = 60): Promise<string> {
    const doc = await this.getSourceDocument(id);
    if (!doc?.storageBucket || !doc.storagePath) throw new Error('El documento no tiene archivo privado asociado.');
    const { data, error } = await supabase.storage.from(doc.storageBucket).createSignedUrl(doc.storagePath, expiresIn);
    if (error) err('createSignedDocumentUrl', error);
    return data.signedUrl;
  },

  // ── Financial Statements ───────────────────────────────────────────────────
  async createStatement(data: Omit<FinancialStatement_DB, 'id' | 'uploadDate'>): Promise<FinancialStatement_DB> {
    const payload = {
      client_id: data.clientId, source_document_id: data.sourceDocumentId || null,
      source_company_name: data.sourceCompanyName || null,
      document_type: data.documentType || null, period: data.period, period_date: data.periodDate,
      file_name: data.fileName, raw_line_items: normalizeRawLineItems(data.rawLineItems),
      mapped_data: normalizeMappedData(data.mappedData), extra_accounts: normalizeExtraAccounts(data.extraAccounts),
    };
    let { data: row, error } = await supabase.from('financial_statements').insert(payload).select().single();
    if (error && isMissingSchemaError(error, 'source_document_id')) {
      const { source_document_id, ...fallbackPayload } = payload;
      const retry = await supabase.from('financial_statements').insert(fallbackPayload).select().single();
      row = retry.data;
      error = retry.error;
    }
    if (error) err('createStatement', error);
    return toStatement(row);
  },

  async getStatements(clientId: string): Promise<FinancialStatement_DB[]> {
    const { data, error } = await supabase.from('financial_statements').select('*').eq('client_id', clientId).order('period_date');
    if (error) err('getStatements', error);
    return mergeStatementRows((data || []).map(toStatement));
  },

  async getStatementsForClients(clientIds: string[]): Promise<Record<string, FinancialStatement_DB[]>> {
    if (!clientIds.length) return {};
    const { data, error } = await supabase.from('financial_statements').select('*').in('client_id', clientIds).order('period_date');
    if (error) err('getStatementsForClients', error);
    return mergeStatementRows((data || []).map(toStatement)).reduce((acc, statement) => {
      (acc[statement.clientId] ||= []).push(statement);
      return acc;
    }, {} as Record<string, FinancialStatement_DB[]>);
  },

  async getStatementById(id: string): Promise<FinancialStatement_DB | undefined> {
    const { data } = await supabase.from('financial_statements').select('*').eq('id', id).maybeSingle();
    return data ? toStatement(data) : undefined;
  },

  async updateStatement(id: string, updates: Partial<FinancialStatement_DB>): Promise<void> {
    const row: any = {};
    if (updates.mappedData !== undefined) row.mapped_data = normalizeMappedData(updates.mappedData);
    if (updates.rawLineItems !== undefined) row.raw_line_items = normalizeRawLineItems(updates.rawLineItems);
    if (updates.extraAccounts !== undefined) row.extra_accounts = normalizeExtraAccounts(updates.extraAccounts);
    if (updates.sourceDocumentId !== undefined) row.source_document_id = updates.sourceDocumentId || null;
    if (updates.sourceCompanyName !== undefined) row.source_company_name = updates.sourceCompanyName || null;
    if (updates.documentType !== undefined) row.document_type = updates.documentType || null;
    if (updates.fileName !== undefined) row.file_name = updates.fileName;
    if (updates.period !== undefined) row.period = updates.period;
    if (updates.periodDate !== undefined) row.period_date = updates.periodDate;
    const { error } = await supabase.from('financial_statements').update(row).eq('id', id);
    if (error) err('updateStatement', error);
  },

  async deleteStatement(id: string): Promise<void> {
    const { error } = await supabase.from('financial_statements').delete().eq('id', id);
    if (error) err('deleteStatement', error);
  },

  // ── Loan Tapes ─────────────────────────────────────────────────────────────
  async createLoanTape(data: Omit<LoanTape_DB, 'id' | 'uploadDate'>): Promise<LoanTape_DB> {
    const payload: any = {
      client_id: data.clientId, source_document_id: data.sourceDocumentId || null,
      name: data.name, file_name: data.fileName,
      tape_type: data.tapeType, extracted_data: normalizeLoanTapeData(data.extractedData),
      analyst_state: data.analystState || {},
    };
    let insertPayload = { ...payload };
    let { data: row, error } = await supabase.from('loan_tapes').insert(insertPayload).select().single();
    for (let attempt = 0; error && attempt < 2; attempt += 1) {
      if (isMissingSchemaError(error, 'source_document_id')) delete insertPayload.source_document_id;
      else if (isMissingSchemaError(error, 'analyst_state')) delete insertPayload.analyst_state;
      else break;
      const retry = await supabase.from('loan_tapes').insert(insertPayload).select().single();
      row = retry.data;
      error = retry.error;
    }
    if (error) err('createLoanTape', error);
    return toLoanTape(row);
  },

  async getLoanTapes(clientId: string): Promise<LoanTape_DB[]> {
    const { data, error } = await supabase.from('loan_tapes').select('*').eq('client_id', clientId).order('upload_date', { ascending: false });
    if (error) err('getLoanTapes', error);
    return (data || []).map(toLoanTape);
  },

  async getLoanTapesForClients(clientIds: string[]): Promise<Record<string, LoanTape_DB[]>> {
    if (!clientIds.length) return {};
    const { data, error } = await supabase
      .from('loan_tapes')
      .select('*')
      .in('client_id', clientIds)
      .order('upload_date', { ascending: false });
    if (error) err('getLoanTapesForClients', error);
    return (data || []).map(toLoanTape).reduce((acc, tape) => {
      (acc[tape.clientId] ||= []).push(tape);
      return acc;
    }, {} as Record<string, LoanTape_DB[]>);
  },

  async getLoanTapeById(id: string): Promise<LoanTape_DB | undefined> {
    const { data } = await supabase.from('loan_tapes').select('*').eq('id', id).maybeSingle();
    return data ? toLoanTape(data) : undefined;
  },

  async updateLoanTape(id: string, updates: Partial<LoanTape_DB>): Promise<void> {
    const row: any = {};
    if (updates.name !== undefined) row.name = updates.name;
    if (updates.extractedData !== undefined) row.extracted_data = normalizeLoanTapeData(updates.extractedData);
    if (updates.analystState !== undefined) row.analyst_state = updates.analystState;
    let { error } = await supabase.from('loan_tapes').update(row).eq('id', id);
    if (error && isMissingSchemaError(error, 'analyst_state')) {
      delete row.analyst_state;
      if (Object.keys(row).length === 0) return;
      const retry = await supabase.from('loan_tapes').update(row).eq('id', id);
      error = retry.error;
    }
    if (error) err('updateLoanTape', error);
  },

  async deleteLoanTape(id: string): Promise<void> {
    const { error } = await supabase.from('loan_tapes').delete().eq('id', id);
    if (error) err('deleteLoanTape', error);
  },

  // ── Institutional Liabilities (Pasivos Institucionales) ─────────────────────
  async createInstitutionalLiability(data: Omit<InstitutionalLiability_DB, 'id' | 'createdAt' | 'updatedAt'>): Promise<InstitutionalLiability_DB> {
    const insertPayload: any = {
      client_id: data.clientId, source_document_id: data.sourceDocumentId || null,
      lender_name: data.lenderName, liability_type: data.liabilityType,
      original_amount: data.originalAmount, current_balance: data.currentBalance,
      currency: data.currency, interest_rate: data.interestRate, rate_description: data.rateDescription || null,
      origination_date: data.originationDate || null, maturity_date: data.maturityDate || null,
      amortization: data.amortization || null, guarantee: data.guarantee || null, notes: data.notes || null,
    };
    let { data: row, error } = await supabase.from('institutional_liabilities').insert(insertPayload).select().single();
    if (error && isMissingSchemaError(error, 'source_document_id')) {
      delete insertPayload.source_document_id;
      const retry = await supabase.from('institutional_liabilities').insert(insertPayload).select().single();
      row = retry.data;
      error = retry.error;
    }
    if (error) err('createInstitutionalLiability', error);
    return toInstitutionalLiability(row);
  },

  async getInstitutionalLiabilities(clientId: string): Promise<InstitutionalLiability_DB[]> {
    const { data, error } = await supabase.from('institutional_liabilities').select('*').eq('client_id', clientId).order('created_at', { ascending: true });
    if (error) {
      if (isMissingSchemaError(error, 'institutional_liabilities')) return [];
      err('getInstitutionalLiabilities', error);
    }
    return (data || []).map(toInstitutionalLiability);
  },

  async getInstitutionalLiabilitiesForClients(clientIds: string[]): Promise<Record<string, InstitutionalLiability_DB[]>> {
    if (!clientIds.length) return {};
    const { data, error } = await supabase
      .from('institutional_liabilities')
      .select('*')
      .in('client_id', clientIds)
      .order('created_at', { ascending: true });
    if (error) {
      if (isMissingSchemaError(error, 'institutional_liabilities')) return {};
      err('getInstitutionalLiabilitiesForClients', error);
    }
    return (data || []).map(toInstitutionalLiability).reduce((acc, item) => {
      (acc[item.clientId] ||= []).push(item);
      return acc;
    }, {} as Record<string, InstitutionalLiability_DB[]>);
  },

  async updateInstitutionalLiability(id: string, updates: Partial<InstitutionalLiability_DB>): Promise<void> {
    const row: any = {};
    if (updates.lenderName !== undefined) row.lender_name = updates.lenderName;
    if (updates.liabilityType !== undefined) row.liability_type = updates.liabilityType;
    if (updates.originalAmount !== undefined) row.original_amount = updates.originalAmount;
    if (updates.currentBalance !== undefined) row.current_balance = updates.currentBalance;
    if (updates.currency !== undefined) row.currency = updates.currency;
    if (updates.interestRate !== undefined) row.interest_rate = updates.interestRate;
    if (updates.rateDescription !== undefined) row.rate_description = updates.rateDescription || null;
    if (updates.originationDate !== undefined) row.origination_date = updates.originationDate || null;
    if (updates.maturityDate !== undefined) row.maturity_date = updates.maturityDate || null;
    if (updates.amortization !== undefined) row.amortization = updates.amortization || null;
    if (updates.guarantee !== undefined) row.guarantee = updates.guarantee || null;
    if (updates.notes !== undefined) row.notes = updates.notes || null;
    row.updated_at = new Date().toISOString();
    const { error } = await supabase.from('institutional_liabilities').update(row).eq('id', id);
    if (error) err('updateInstitutionalLiability', error);
  },

  async deleteInstitutionalLiability(id: string): Promise<void> {
    const { error } = await supabase.from('institutional_liabilities').delete().eq('id', id);
    if (error) err('deleteInstitutionalLiability', error);
  },
};
