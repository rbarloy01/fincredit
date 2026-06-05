// FinMonitor DB — Supabase backend
import { supabase } from '../lib/supabase';

export type Role = 'manager' | 'analyst';

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  createdAt: string;
}

export interface Client {
  id: string;
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
  paymentHistory: Array<{ month: string; principalStatus: 'paid' | 'unpaid' | 'none'; interestStatus: 'paid' | 'unpaid' | 'none' }>;
  currentDue: number;
  maxDefaultDays: number;
  maxDefaultAmount: number;
  defaultFrequency12m: number;
  opinion: string;
  aforoRequerido: string;
  aforoHistory: Array<{ month: string; value: string; status: 'good' | 'warning' | 'bad' }>;
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

export interface LoanTape_DB {
  id: string;
  clientId: string;
  name: string;
  uploadDate: string;
  fileName: string;
  tapeType: 'credito' | 'factoraje' | 'otro';
  extractedData: any;
}

// ── Row mappers ───────────────────────────────────────────────────────────────

function toClient(r: any): Client {
  return {
    id: r.id, name: r.name, taxId: r.tax_id || '', industry: r.industry || '',
    score: r.score || '', currency: r.currency || 'MXN',
    totalCreditValue: r.total_credit_value || 0, creditType: r.credit_type || [],
    contractName: r.contract_name || '', analystName: r.analyst_name || '',
    createdBy: r.created_by || '', createdAt: r.created_at,
    paymentHistory: r.payment_history || [], currentDue: r.current_due || 0,
    maxDefaultDays: r.max_default_days || 0, maxDefaultAmount: r.max_default_amount || 0,
    defaultFrequency12m: r.default_frequency_12m || 0, opinion: r.opinion || '',
    aforoRequerido: r.aforo_requerido || '', aforoHistory: r.aforo_history || [],
    documentation: r.documentation || [], reportDate: r.report_date || '',
    frequency: r.frequency || 'mensual', lastPeriod: r.last_period || '',
    logoLeft: r.logo_left, logoRight: r.logo_right,
  };
}

function fromClient(c: Omit<Client, 'id' | 'createdAt'>): any {
  return {
    name: c.name, tax_id: c.taxId, industry: c.industry, score: c.score,
    currency: c.currency, total_credit_value: c.totalCreditValue, credit_type: c.creditType,
    contract_name: c.contractName, analyst_name: c.analystName, created_by: c.createdBy || null,
    payment_history: c.paymentHistory, current_due: c.currentDue,
    max_default_days: c.maxDefaultDays, max_default_amount: c.maxDefaultAmount,
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
    date: r.date || '', creditType: r.credit_type || '', originalAmount: r.original_amount || 0,
    currency: r.currency || 'MXN', signedAt: r.signed_at || '', maturityAt: r.maturity_at || '',
    createdBy: r.created_by || '', createdAt: r.created_at,
  };
}

function toContractFile(r: any): ContractFile {
  return {
    id: r.id, transactionId: r.transaction_id, clientId: r.client_id,
    originalName: r.original_name, mimeType: r.mime_type || '',
    base64Data: r.base64_data || '', uploadedAt: r.uploaded_at,
    extractionStatus: r.extraction_status || 'pending',
    extractedCovenants: r.extracted_covenants,
  };
}

function toCovenant(r: any): Covenant_DB {
  return {
    id: r.id, clientId: r.client_id, transactionId: r.transaction_id,
    name: r.name, type: r.type, formula: r.formula || '', threshold: r.threshold || '',
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

function toStatement(r: any): FinancialStatement_DB {
  return {
    id: r.id, clientId: r.client_id, sourceCompanyName: r.source_company_name,
    documentType: r.document_type, period: r.period, periodDate: r.period_date,
    uploadDate: r.upload_date, fileName: r.file_name || '',
    rawLineItems: r.raw_line_items || [], mappedData: r.mapped_data || {},
    extraAccounts: r.extra_accounts || [],
  };
}

function toLoanTape(r: any): LoanTape_DB {
  return {
    id: r.id, clientId: r.client_id, name: r.name,
    uploadDate: r.upload_date, fileName: r.file_name || '',
    tapeType: r.tape_type || 'credito', extractedData: r.extracted_data,
  };
}

function err(label: string, e: any): never {
  throw new Error(`${label}: ${e?.message || e}`);
}

// ── DB object ────────────────────────────────────────────────────────────────
export const db = {
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

  async createUser(data: { name: string; email: string; password: string; role: Role }): Promise<User> {
    const res = await fetch('/api/admin/users/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
    const res = await fetch('/api/admin/users/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: id }),
    });
    if (!res.ok) { const j = await res.json(); throw new Error(j.error || 'Error al eliminar usuario'); }
  },

  // ── Clients ────────────────────────────────────────────────────────────────
  async createClient(data: Omit<Client, 'id' | 'createdAt'>): Promise<Client> {
    const { data: row, error } = await supabase.from('clients').insert(fromClient(data)).select().single();
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
    if (updates.totalCreditValue !== undefined) row.total_credit_value = updates.totalCreditValue;
    if (updates.creditType !== undefined) row.credit_type = updates.creditType;
    if (updates.contractName !== undefined) row.contract_name = updates.contractName;
    if (updates.analystName !== undefined) row.analyst_name = updates.analystName;
    if (updates.paymentHistory !== undefined) row.payment_history = updates.paymentHistory;
    if (updates.currentDue !== undefined) row.current_due = updates.currentDue;
    if (updates.maxDefaultDays !== undefined) row.max_default_days = updates.maxDefaultDays;
    if (updates.maxDefaultAmount !== undefined) row.max_default_amount = updates.maxDefaultAmount;
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
    const localFallback = () => {
      try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); } catch { return fallback; }
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
      return localFallback();
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

  // ── Custom Fields ──────────────────────────────────────────────────────────
  async setCustomFields(clientId: string, fields: CustomField[]): Promise<void> {
    await supabase.from('custom_fields').delete().eq('client_id', clientId).not('label', 'like', '__setting:%');
    if (fields.length > 0) {
      const rows = fields.map(f => ({ id: f.id, client_id: clientId, label: f.label, value: f.value, field_type: f.fieldType }));
      const { error } = await supabase.from('custom_fields').insert(rows);
      if (error) err('setCustomFields', error);
    }
  },

  async getCustomFields(clientId: string): Promise<CustomField[]> {
    const { data, error } = await supabase.from('custom_fields').select('*').eq('client_id', clientId);
    if (error) err('getCustomFields', error);
    return (data || []).map(r => ({ id: r.id, clientId: r.client_id, label: r.label, value: r.value || '', fieldType: r.field_type as any }));
  },

  // ── Transactions ───────────────────────────────────────────────────────────
  async createTransaction(data: Omit<Transaction, 'id' | 'createdAt'>): Promise<Transaction> {
    const { data: row, error } = await supabase.from('transactions').insert({
      client_id: data.clientId, name: data.name, description: data.description,
      date: data.date, credit_type: data.creditType, original_amount: data.originalAmount,
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
    if (updates.originalAmount !== undefined) row.original_amount = updates.originalAmount;
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
    const { data: row, error } = await supabase.from('contract_files').insert({
      transaction_id: data.transactionId, client_id: data.clientId,
      original_name: data.originalName, mime_type: data.mimeType,
      base64_data: data.base64Data, extraction_status: data.extractionStatus,
      extracted_covenants: data.extractedCovenants || null,
    }).select().single();
    if (error) err('addContractFile', error);
    return toContractFile(row);
  },

  async getContractFiles(transactionId: string): Promise<ContractFile[]> {
    const { data, error } = await supabase.from('contract_files').select('*').eq('transaction_id', transactionId).order('uploaded_at');
    if (error) err('getContractFiles', error);
    return (data || []).map(toContractFile);
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
      name: data.name, type: data.type, formula: data.formula, threshold: data.threshold,
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
    if (updates.name !== undefined) row.name = updates.name;
    if (updates.formula !== undefined) row.formula = updates.formula;
    if (updates.threshold !== undefined) row.threshold = updates.threshold;
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

  // ── Financial Statements ───────────────────────────────────────────────────
  async createStatement(data: Omit<FinancialStatement_DB, 'id' | 'uploadDate'>): Promise<FinancialStatement_DB> {
    const { data: row, error } = await supabase.from('financial_statements').insert({
      client_id: data.clientId, source_company_name: data.sourceCompanyName || null,
      document_type: data.documentType || null, period: data.period, period_date: data.periodDate,
      file_name: data.fileName, raw_line_items: data.rawLineItems,
      mapped_data: data.mappedData, extra_accounts: data.extraAccounts,
    }).select().single();
    if (error) err('createStatement', error);
    return toStatement(row);
  },

  async getStatements(clientId: string): Promise<FinancialStatement_DB[]> {
    const { data, error } = await supabase.from('financial_statements').select('*').eq('client_id', clientId).order('period_date');
    if (error) err('getStatements', error);
    return (data || []).map(toStatement);
  },

  async getStatementById(id: string): Promise<FinancialStatement_DB | undefined> {
    const { data } = await supabase.from('financial_statements').select('*').eq('id', id).maybeSingle();
    return data ? toStatement(data) : undefined;
  },

  async updateStatement(id: string, updates: Partial<FinancialStatement_DB>): Promise<void> {
    const row: any = {};
    if (updates.mappedData !== undefined) row.mapped_data = updates.mappedData;
    if (updates.rawLineItems !== undefined) row.raw_line_items = updates.rawLineItems;
    if (updates.extraAccounts !== undefined) row.extra_accounts = updates.extraAccounts;
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
    const { data: row, error } = await supabase.from('loan_tapes').insert({
      client_id: data.clientId, name: data.name, file_name: data.fileName,
      tape_type: data.tapeType, extracted_data: data.extractedData,
    }).select().single();
    if (error) err('createLoanTape', error);
    return toLoanTape(row);
  },

  async getLoanTapes(clientId: string): Promise<LoanTape_DB[]> {
    const { data, error } = await supabase.from('loan_tapes').select('*').eq('client_id', clientId).order('upload_date', { ascending: false });
    if (error) err('getLoanTapes', error);
    return (data || []).map(toLoanTape);
  },

  async getLoanTapeById(id: string): Promise<LoanTape_DB | undefined> {
    const { data } = await supabase.from('loan_tapes').select('*').eq('id', id).maybeSingle();
    return data ? toLoanTape(data) : undefined;
  },

  async updateLoanTape(id: string, updates: Partial<LoanTape_DB>): Promise<void> {
    const row: any = {};
    if (updates.name !== undefined) row.name = updates.name;
    if (updates.extractedData !== undefined) row.extracted_data = updates.extractedData;
    const { error } = await supabase.from('loan_tapes').update(row).eq('id', id);
    if (error) err('updateLoanTape', error);
  },

  async deleteLoanTape(id: string): Promise<void> {
    const { error } = await supabase.from('loan_tapes').delete().eq('id', id);
    if (error) err('deleteLoanTape', error);
  },
};
