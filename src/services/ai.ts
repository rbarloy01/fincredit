// Multi-provider AI service: Gemini, Claude, OpenAI, OpenRouter, Bytez, NVIDIA NIM
// Uses Vite proxy at /api/gemini, /api/claude, /api/openai, /api/bytez, /api/nvidia-nim

import loanTapePrompt from '../prompts/loan-tape.md?raw';
import financialsPrompt from '../prompts/financials.md?raw';
import { parseFinancialNumber } from '../lib/numberParsing';
import { supabase } from '../lib/supabase';

export type AIProvider = 'gemini' | 'claude' | 'openai' | 'openrouter' | 'bytez' | 'nvidia_nim';
export type AITask = 'financials' | 'contracts' | 'loan_tape' | 'liabilities' | 'opinion' | 'account_consolidation' | 'assistant';

export interface AIProviderConfig {
  provider: AIProvider;
  enabled: boolean;
  apiKey: string;
  model?: string;
  fallbackModels?: string[];
}

export interface AISettings {
  provider: AIProvider;
  apiKey: string;
  model?: string;
  fallbackModels?: string[];
  providers?: Partial<Record<AIProvider, AIProviderConfig>>;
  taskProviders?: Partial<Record<AITask, AIProvider>>;
}

const SETTINGS_KEY = 'finmonitor_ai_settings';
// Free-tier Gemini: Flash models give only ~20 requests/day, Flash-Lite ~500/day (Sept 2026), and a statement extraction makes 2 calls.
// New setups default to Flash-Lite; on a quota error any Gemini model falls back to it automatically.
const GEMINI_MODEL = 'gemini-flash-lite-latest';
const GEMINI_QUOTA_FALLBACK = 'gemini-flash-lite-latest';
// Free, JSON-capable models with a large context (checked against OpenRouter's public catalog). OpenRouter accepts at most
// 3 models per request: primary + 2 fallbacks. Models OpenRouter retires are listed so saved settings can be migrated.
const OPENROUTER_MODEL = 'google/gemma-4-31b-it:free';
const OPENROUTER_FALLBACK_MODELS = ['nvidia/nemotron-3-super-120b-a12b:free', 'openrouter/free'];
const RETIRED_OPENROUTER_MODELS = new Set(['stealth/ox-alpha']);
// Free models that can read images (checked against the public catalog); "openrouter/free" routes to whichever free model supports the request.
const OPENROUTER_VISION_MODELS = ['google/gemma-4-31b-it:free', 'thinkingmachines/inkling:free', 'openrouter/free'];
const VISION_CAPABLE = /gemini|gpt-4|gpt-5|claude|gemma-4|inkling|dots-3|omni|vision|-vl|qwen.*vl|pixtral|llama-4|openrouter\/free|openrouter\/auto/i;
const BYTEZ_MODEL = 'Qwen/Qwen3-4B';
// Modelo sin "razonamiento": en el plan gratuito de NVIDIA los modelos que piensan antes de responder (DeepSeek,
// Nemotron 3) tardan más de lo que espera el proxy (58 s) incluso para un "OK".
const NVIDIA_NIM_MODEL = 'mistralai/mistral-large-2-instruct';
// NVIDIA deja de servir modelos aunque sigan en su catálogo (404 "no disponible para la cuenta") o los satura (504):
// se prueba la cadena y se RECUERDA el que respondió con esta llave para usarlo primero la próxima vez.
const NVIDIA_NIM_FALLBACK_MODELS = ['google/gemma-4-31b-it', 'openai/gpt-oss-20b', 'nv-mistralai/mistral-nemo-12b-instruct', 'deepseek-ai/deepseek-v4.1-flash'];
const NIM_WORKING_MODEL_KEY = 'finmonitor_nim_working_model';
let lastNimModel = '';
const rememberNimModel = (model: string) => { lastNimModel = model; try { localStorage.setItem(NIM_WORKING_MODEL_KEY, model); } catch { /* sin storage */ } };
const workingNimModel = () => { try { return localStorage.getItem(NIM_WORKING_MODEL_KEY) || ''; } catch { return ''; } };
const RETIRED_NIM_MODELS = new Set(['nvidia/llama-3.1-nemotron-70b-instruct', 'deepseek-ai/deepseek-v4.1-flash']);
// NVIDIA NIM hosts free vision models (checked against its public catalog). Used automatically when the request has images.
const NVIDIA_NIM_VISION_MODEL = 'google/gemma-4-31b-it';
const NVIDIA_NIM_VISION_FALLBACKS = ['meta/llama-3.2-90b-vision-instruct', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning'];
const NIM_VISION_CAPABLE = /gemma-[34]|vision|-vl|omni|neva|vila|fuyu|kosmos|cosmos|phi-.*vision/i;
const NIM_MAX_IMAGES = 10;
const AI_PROVIDERS: AIProvider[] = ['gemini', 'claude', 'openai', 'openrouter', 'bytez', 'nvidia_nim'];

export const AI_TASK_LABELS: Record<AITask, string> = {
  financials: 'Estados financieros',
  contracts: 'Contratos y covenants',
  loan_tape: 'Loan tape',
  liabilities: 'Pasivos institucionales',
  opinion: 'Opinión / comentarios',
  account_consolidation: 'Consolidación de cuentas',
  assistant: 'Asistente del cliente (preguntas)',
};

export function defaultModelForProvider(provider: AIProvider): string {
  if (provider === 'openrouter') return OPENROUTER_MODEL;
  if (provider === 'bytez') return BYTEZ_MODEL;
  if (provider === 'nvidia_nim') return NVIDIA_NIM_MODEL;
  if (provider === 'openai') return 'gpt-4o';
  if (provider === 'claude') return 'claude-sonnet-4-6';
  return GEMINI_MODEL;
}

export function defaultFallbackModelsForProvider(provider: AIProvider): string[] {
  return provider === 'openrouter' ? [...OPENROUTER_FALLBACK_MODELS] : [];
}

export function defaultProviderConfig(provider: AIProvider): AIProviderConfig {
  return {
    provider,
    enabled: provider === 'gemini',
    apiKey: '',
    model: defaultModelForProvider(provider),
    fallbackModels: defaultFallbackModelsForProvider(provider),
  };
}

function normalizeProviderConfig(provider: AIProvider, config?: Partial<AIProviderConfig>): AIProviderConfig {
  let model = config?.model || defaultModelForProvider(provider);
  let fallbackModels = config?.fallbackModels || defaultFallbackModelsForProvider(provider);
  if (provider === 'nvidia_nim' && RETIRED_NIM_MODELS.has(model)) model = defaultModelForProvider('nvidia_nim');
  if (provider === 'openrouter') {
    // A retired model makes every extraction fail ("No endpoints found"): move saved settings to the current default.
    if (RETIRED_OPENROUTER_MODELS.has(model)) model = defaultModelForProvider('openrouter');
    fallbackModels = fallbackModels.filter(item => !RETIRED_OPENROUTER_MODELS.has(item));
    if (!fallbackModels.length) fallbackModels = defaultFallbackModelsForProvider('openrouter');
  }
  return {
    ...defaultProviderConfig(provider),
    ...config,
    provider,
    enabled: config?.enabled ?? defaultProviderConfig(provider).enabled,
    apiKey: config?.apiKey ?? '',
    model,
    fallbackModels,
  };
}

export function normalizeAISettings(settings: AISettings): AISettings {
  const providers = Object.fromEntries(AI_PROVIDERS.map(provider => {
    const legacyForCurrent = provider === settings.provider
      ? { apiKey: settings.apiKey, model: settings.model, fallbackModels: settings.fallbackModels, enabled: true }
      : {};
    return [provider, normalizeProviderConfig(provider, { ...legacyForCurrent, ...(settings.providers?.[provider] || {}) })];
  })) as Record<AIProvider, AIProviderConfig>;
  const active = providers[settings.provider] || providers.gemini;
  return {
    ...settings,
    provider: active.provider,
    apiKey: active.apiKey,
    model: active.model,
    fallbackModels: active.fallbackModels,
    providers,
    taskProviders: settings.taskProviders || {},
  };
}

export function providerSettings(settings: AISettings, provider = settings.provider): AIProviderConfig {
  return normalizeAISettings(settings).providers?.[provider] || defaultProviderConfig(provider);
}

export function settingsForTask(settings: AISettings, task: AITask): AISettings {
  const normalized = normalizeAISettings(settings);
  const requested = normalized.taskProviders?.[task];
  const provider = requested && normalized.providers?.[requested]?.enabled
    ? requested
    : normalized.providers?.[normalized.provider]?.enabled
      ? normalized.provider
      : AI_PROVIDERS.find(item => normalized.providers?.[item]?.enabled) || normalized.provider;
  const config = normalized.providers?.[provider] || providerSettings(normalized, provider);
  return {
    ...normalized,
    provider,
    apiKey: config.apiKey,
    model: config.model,
    fallbackModels: config.fallbackModels,
  };
}

export interface AIMedia {
  base64: string;
  mimeType: string;
  fileName?: string;
}

export interface AIDocumentContent {
  text?: string;
  media?: AIMedia | AIMedia[];
}

export function loadAISettings(): AISettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as AISettings;
      return normalizeAISettings({
        ...parsed,
        model: parsed.model || defaultModelForProvider(parsed.provider),
        fallbackModels: parsed.fallbackModels || defaultFallbackModelsForProvider(parsed.provider),
      });
    }
  } catch {}
  // Legacy key
  const legacyKey = localStorage.getItem('finmonitor_claude_key');
  if (legacyKey) localStorage.removeItem('finmonitor_claude_key');
  return normalizeAISettings({ provider: 'gemini', apiKey: '', model: defaultModelForProvider('gemini'), fallbackModels: [] });
}

export function saveAISettings(s: AISettings) {
  const normalized = normalizeAISettings(s);
  const providers = Object.fromEntries(AI_PROVIDERS.map(provider => {
    const config = normalized.providers?.[provider] || defaultProviderConfig(provider);
    return [provider, { ...config, apiKey: '' }];
  })) as Record<AIProvider, AIProviderConfig>;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({
    ...normalized,
    apiKey: '',
    providers,
  }));
}

// ─── Raw types ────────────────────────────────────────────────────────────────

export type StatementType = 'balance_general' | 'estado_resultados' | 'flujo_efectivo' | 'otro';

export type LineItemRole = 'detail' | 'subtotal' | 'total';
export interface RawLineItem { name: string; value: number; source?: string; sectionPath?: string | null; statementType?: StatementType; role?: LineItemRole; parent?: string | null; }

export interface ExtractedStatement {
  period: string;
  periodDate: string;
  rawLineItems: RawLineItem[];
}

export interface ExtractionResult {
  companyName?: string;
  documentType?: string;
  period: string;
  periodDate: string;
  rawLineItems: RawLineItem[];
  statements?: ExtractedStatement[];
}

export interface FinancialCovenant {
  name: string; threshold: string; operator: 'gt'|'lt'|'gte'|'lte'|'none'; description: string; formula?: string;
  indicatorKey?: string;   // indicador estándar calculable (KNOWN_INDICATORS) al que corresponde, si aplica
}

export interface ContractExtractionResult {
  condicionesHacer: string[];
  condicionesNoHacer: string[];
  covenants: FinancialCovenant[];
  terminos?: Record<string, any>;   // términos económicos de la facility (ver facilityTerms.termsFromExtraction)
}

export interface ContractClientExtractionResult extends ContractExtractionResult {
  client: {
    legalName: string;
    taxId: string;
    industry: string;
  };
  transaction: {
    contractName: string;
    description: string;
    creditType: string;
    originalAmount: number;
    currency: 'MXN' | 'USD' | 'EUR';
    signedAt: string;
    maturityAt: string;
    reviewFrequency: 'mensual' | 'trimestral';
  };
}

export interface StructuredLoanTapeAnalysis {
  overallStatus: string; riskScore: number; executiveSummary: string; trendDirection: string;
  portfolioQuality?: Record<string, { count: number; balance: number; pct: number }>;
  dpd_distribution?: Array<{ bucket: string; count: number; balance: number; pct: number }>;
  concentrations?: Record<string, any[]>;
  anomalies?: Record<string, any[]>;
  validation?: Array<{ loan_id: string; rule_id: string; field: string; message: string; severity?: string }>;
  metrics: Array<{ name: string; latestValue: string; previousValue?: string; change?: string; trend: string; status: string; contractLimit?: string; congruent: boolean; }>;
  findings: Array<{ severity: string; category: string; title: string; detail: string; recommendation?: string; }>;
  congruencyChecks: Array<{ item: string; contractRequirement?: string; actualValue: string; status: string; }>;
}

export interface ExtractedLoanTapeSheet {
  name: string;
  rows: any[][];
}

export interface AccountConsolidationSuggestion {
  mappings: Array<{
    accountName: string;
    statementType?: StatementType | 'any';
    metric: string;
    confidence: number;
    reason: string;
  }>;
  covenantTemplates: Array<{
    name: string;
    formula: string;
    description: string;
    operator?: 'gt'|'lt'|'gte'|'lte'|'none';
    threshold?: string;
  }>;
}

export interface ExtractedInstitutionalLiability {
  lenderName: string;
  liabilityType: 'linea_credito' | 'prestamo_simple' | 'bono' | 'otro';
  originalAmount: number | null;
  currentBalance: number | null;
  currency: string;
  interestRate: number | null;
  rateDescription?: string;
  originationDate?: string;
  maturityDate?: string;
  amortization?: string;
  guarantee?: string;
  notes?: string;
}

// ─── Core request dispatcher ──────────────────────────────────────────────────

function normalizeFinancialLineItem(item: any): RawLineItem | null {
  const statementType = item.statementType || item.type;
  if (statementType !== 'balance_general' && statementType !== 'estado_resultados') return null;

  const name = String(item.name || '').trim();
  if (!name) return null;

  const value = parseFinancialNumber(item.value, Number.NaN);
  if (!Number.isFinite(value)) return null;

  const role: LineItemRole | undefined =
    item.role === 'total' || item.role === 'subtotal' || item.role === 'detail' ? item.role : undefined;
  const parent = typeof item.parent === 'string' && item.parent.trim() ? item.parent.trim() : null;

  return {
    name,
    value,
    source: item.source,
    sectionPath: item.sectionPath || null,
    statementType,
    role,
    parent,
  };
}

function normalizeFinancialExtraction(parsed: any): ExtractionResult {
  const parsedStatements = Array.isArray(parsed.statements) && parsed.statements.length > 0
    ? parsed.statements
    : [{
        period: parsed.period || 'Sin período',
        periodDate: parsed.periodDate || new Date().toISOString().slice(0, 10),
        rawLineItems: parsed.rawLineItems || [],
      }];
  const statements = parsedStatements.map((stmt: any) => ({
    period: stmt.period || parsed.period || 'Sin período',
    periodDate: stmt.periodDate || parsed.periodDate || new Date().toISOString().slice(0, 10),
    rawLineItems: (stmt.rawLineItems || []).map(normalizeFinancialLineItem).filter((item: RawLineItem | null): item is RawLineItem => Boolean(item)),
  }));
  return {
    companyName: parsed.companyName || undefined,
    documentType: parsed.documentType || undefined,
    period: statements[0]?.period || 'Sin período',
    periodDate: statements[0]?.periodDate || new Date().toISOString().slice(0, 10),
    rawLineItems: statements[0]?.rawLineItems || [],
    statements,
  };
}

function hasStatementType(result: ExtractionResult, statementType: StatementType) {
  return (result.statements || [result]).some(statement =>
    (statement.rawLineItems || []).some(item => item.statementType === statementType)
  );
}

function lineItemKey(item: RawLineItem) {
  return [
    item.statementType || 'otro',
    String(item.name || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, ''),
  ].join('||');
}

function mergeFinancialLineItems(items: RawLineItem[]): RawLineItem[] {
  const byAccount = new Map<string, RawLineItem>();
  for (const item of items) {
    const key = lineItemKey(item);
    const existing = byAccount.get(key);
    if (!existing) {
      byAccount.set(key, { ...item });
      continue;
    }

    const existingValue = Number(existing.value) || 0;
    const incomingValue = Number(item.value) || 0;
    byAccount.set(key, {
      ...existing,
      value: existingValue === incomingValue ? existingValue : existingValue + incomingValue,
      sectionPath: existing.sectionPath || item.sectionPath || null,
      source: existing.source || item.source,
      role: existing.role || item.role,
      parent: existing.parent ?? item.parent ?? null,
    });
  }
  return Array.from(byAccount.values());
}

function mergeFinancialExtractions(primary: ExtractionResult, rescue: ExtractionResult): ExtractionResult {
  const byPeriod = new Map<string, ExtractedStatement>();
  const addStatement = (statement: ExtractedStatement) => {
    const key = statement.periodDate || statement.period;
    const existing = byPeriod.get(key);
    if (!existing) {
      byPeriod.set(key, { ...statement, rawLineItems: mergeFinancialLineItems(statement.rawLineItems) });
      return;
    }

    existing.rawLineItems = mergeFinancialLineItems([...existing.rawLineItems, ...statement.rawLineItems]);
  };

  (primary.statements || [primary]).forEach(addStatement);
  (rescue.statements || [rescue]).forEach(addStatement);
  const statements = Array.from(byPeriod.values()).sort((a, b) => a.periodDate.localeCompare(b.periodDate));

  return {
    ...primary,
    period: statements[0]?.period || primary.period,
    periodDate: statements[0]?.periodDate || primary.periodDate,
    rawLineItems: statements[0]?.rawLineItems || primary.rawLineItems,
    statements,
  };
}

// OpenRouter chat payload. Images go as image_url parts; raw PDFs go as file parts parsed by OpenRouter's free text engine.
// With attachments, a model that cannot see images is replaced by the free vision chain.
export function buildOpenRouterPayload(settings: AISettings, systemPrompt: string, userPrompt: string, mediaItems: AIMedia[]): Record<string, any> {
  const configured = settings.model || OPENROUTER_MODEL;
  const needsVision = mediaItems.length > 0;
  const model = needsVision && !VISION_CAPABLE.test(configured) ? OPENROUTER_VISION_MODELS[0] : configured;
  const base = needsVision && model !== configured ? OPENROUTER_VISION_MODELS.slice(1) : (settings.fallbackModels || OPENROUTER_FALLBACK_MODELS);
  const fallbackModels = base.filter(item => item && item !== model && (!needsVision || VISION_CAPABLE.test(item))).slice(0, 2);
  const userContent: any = needsVision
    ? [
        { type: 'text', text: userPrompt },
        ...mediaItems.map(item => item.mimeType === 'application/pdf'
          ? { type: 'file', file: { filename: item.fileName || 'documento.pdf', file_data: `data:application/pdf;base64,${item.base64}` } }
          : { type: 'image_url', image_url: { url: `data:${item.mimeType};base64,${item.base64}` } }),
      ]
    : userPrompt;
  const payload: Record<string, any> = {
    messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userContent }],
    temperature: 0,
    max_tokens: 8192,
    provider: { sort: { by: 'price', partition: 'none' } },
  };
  if (mediaItems.some(item => item.mimeType === 'application/pdf')) payload.plugins = [{ id: 'file-parser', pdf: { engine: 'pdf-text' } }];
  if (fallbackModels.length) payload.models = [model, ...fallbackModels];
  else payload.model = model;
  return payload;
}

// ── Automatic fallback between providers ─────────────────────────────────────────────────────────────────────────────
// Free tiers run out or retire models without notice. When the selected provider fails for a recoverable reason (quota, rate
// limit, retired model, outage), the same request is retried on the OTHER providers the user enabled, in this order.
const FALLBACK_ORDER: AIProvider[] = ['nvidia_nim', 'openrouter', 'gemini', 'openai', 'claude'];
const RECOVERABLE_AI_ERROR = /429|quota|rate.?limit|resource_exhausted|exceed|insufficient|credits|payment|402|no endpoints|not a valid model|model.*(not found|unavailable|retired)|overloaded|unavailable|timeout|timed out|demasiado|tardó|\b5\d\d\b|respuesta no json|gateway|capacity|too many/i;

export function fallbackCandidates(settings: AISettings, documentText: string, media?: AIMedia | AIMedia[]): AISettings[] {
  const normalized = normalizeAISettings(settings);
  const out: AISettings[] = [];
  const seen = new Set<AIProvider>([settings.provider]);
  for (const provider of FALLBACK_ORDER) {
    if (seen.has(provider)) continue;
    const config = normalized.providers?.[provider];
    if (!config?.enabled || !config.apiKey) continue;
    const candidate: AISettings = { ...normalized, provider, apiKey: config.apiKey, model: config.model, fallbackModels: config.fallbackModels };
    const access = resolveMediaAccess(candidate, documentText, media);
    const hasMedia = !!access.media && (Array.isArray(access.media) ? access.media.length > 0 : true);
    // a provider that would be handed images it cannot read (text-only, no OCR text available) is not a valid fallback
    if (hasMedia && !providerSupportsMedia(provider) && !FREE_VISION_PROVIDERS.includes(provider)) continue;
    seen.add(provider);
    out.push(candidate);
  }
  return out;
}

async function callAIResilient(settings: AISettings, systemPrompt: string, userPrompt: string, documentText: string, media?: AIMedia | AIMedia[]): Promise<string> {
  const attempts: Array<{ provider: AIProvider; error: string }> = [];
  const candidates = [settings, ...fallbackCandidates(settings, documentText, media)];
  for (const candidate of candidates) {
    const access = resolveMediaAccess(candidate, documentText, media);
    try {
      return await callAI(access.settings, systemPrompt, userPrompt, access.media);
    } catch (error: any) {
      const message = String(error?.message || error);
      attempts.push({ provider: candidate.provider, error: message });
      if (!RECOVERABLE_AI_ERROR.test(message)) throw error; // a real problem with the request (bad key, bad file): do not mask it
      console.warn(`${candidate.provider} falló (${message.slice(0, 160)}); probando el siguiente proveedor habilitado.`);
    }
  }
  const detail = attempts.map(a => `${a.provider}: ${a.error.slice(0, 140)}`).join(' | ');
  throw new Error(attempts.length > 1
    ? `Ningún proveedor habilitado pudo procesar el documento. ${detail}. Habilita otro proveedor gratuito en Configuración → Motor de IA (por ejemplo NVIDIA NIM u OpenRouter).`
    : attempts[0]?.error || 'No se pudo procesar el documento.');
}

// chat = respuesta conversacional del asistente: texto normal (no JSON), salida corta y ruteo por latencia.
// La extracción de documentos sigue en modo JSON con salida larga.
interface CallOptions { chat?: boolean; maxTokens?: number }
const CHAT_MAX_TOKENS = 2048;

async function callAI(settings: AISettings, systemPrompt: string, userPrompt: string, media?: AIMedia | AIMedia[], opts: CallOptions = {}): Promise<string> {
  const { provider, apiKey } = settings;
  const maxTokens = opts.maxTokens ?? (opts.chat ? CHAT_MAX_TOKENS : 8192);
  const mediaItems = media ? (Array.isArray(media) ? media : [media]).filter(item => item.base64 && item.mimeType) : [];

  if (provider === 'gemini') {
    const parts: any[] = [{ text: `${systemPrompt}\n\n${userPrompt}` }];
    for (const item of mediaItems) {
      parts.push({ inlineData: { data: item.base64, mimeType: item.mimeType } });
    }
    const payload = {
      contents: [{ parts }],
      // gemini-flash-latest ahora apunta a un modelo de "pensamiento" que RECHAZA thinkingBudget:0
      // (400 INVALID_ARGUMENT). 128 es el mínimo aceptado → mantiene el pensamiento al mínimo sin romper.
      generationConfig: opts.chat
        ? { temperature: 0.2, maxOutputTokens: CHAT_MAX_TOKENS, thinkingConfig: { thinkingBudget: 128 } }
        : { temperature: 0.0, maxOutputTokens: 16384, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 128 } },
    };
    let res = await fetchAIWithRetry('/api/gemini', { apiKey, model: settings.model || GEMINI_MODEL, payload });
    let data = await readAIResponseJson(res, 'Gemini');
    // Newer Gemini models change how "thinking" is configured and answer 400 to the old field: retry without it.
    if (!res.ok && /thinking/i.test(String(data.error?.message || data.error || ''))) {
      const { thinkingConfig: _unused, ...generationConfig } = payload.generationConfig;
      res = await fetchAIWithRetry('/api/gemini', { apiKey, model: settings.model || GEMINI_MODEL, payload: { ...payload, generationConfig } });
      data = await readAIResponseJson(res, 'Gemini');
    }
    const geminiModel = settings.model || GEMINI_MODEL;
    if (!res.ok && geminiModel !== GEMINI_QUOTA_FALLBACK && (res.status === 429 || /quota|resource_exhausted|rate.?limit|exceeded/i.test(String(data.error?.message || data.error || '')))) {
      console.warn(`Gemini ${geminiModel} agotó su cuota gratuita; reintentando con ${GEMINI_QUOTA_FALLBACK}.`);
      res = await fetchAIWithRetry('/api/gemini', { apiKey, model: GEMINI_QUOTA_FALLBACK, payload });
      data = await readAIResponseJson(res, 'Gemini');
    }
    if (!res.ok) throw new Error(data.error?.message || data.error || 'Gemini error');
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }

  if (provider === 'claude') {
    let userContent: any;
    if (mediaItems.length > 0) {
      const parts: any[] = [];
      for (const item of mediaItems) {
        if (item.mimeType === 'application/pdf') {
          parts.push({ type: 'document', source: { type: 'base64', media_type: item.mimeType, data: item.base64 } });
        } else {
          parts.push({ type: 'image', source: { type: 'base64', media_type: item.mimeType, data: item.base64 } });
        }
      }
      parts.push({ type: 'text', text: userPrompt });
      userContent = parts;
    } else {
      userContent = userPrompt;
    }
    const payload = {
      model: settings.model || 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    };
    const res = await fetchAIWithRetry('/api/claude', { apiKey, payload });
    const data = await readAIResponseJson(res, 'Claude');
    if (!res.ok) throw new Error(data.error?.message || data.error || 'Claude error');
    return data.content?.[0]?.text || '';
  }

  if (provider === 'openai') {
    const userContent: any[] = [{ type: 'input_text', text: userPrompt }];
    for (const item of mediaItems) {
      const dataUrl = `data:${item.mimeType};base64,${item.base64}`;
      if (item.mimeType === 'application/pdf') {
        userContent.push({ type: 'input_file', filename: item.fileName || 'document.pdf', file_data: dataUrl });
      } else {
        userContent.push({ type: 'input_image', image_url: dataUrl });
      }
    }
    const payload = {
      model: settings.model || 'gpt-4o',
      max_output_tokens: maxTokens,
      instructions: systemPrompt,
      input: [{ role: 'user', content: userContent }],
    };
    const res = await fetchAIWithRetry('/api/openai/responses', { apiKey, payload });
    const data = await readAIResponseJson(res, 'OpenAI');
    if (!res.ok) throw new Error(data.error?.message || data.error || 'OpenAI error');
    return data.output_text
      || data.output?.flatMap((item: any) => item.content || []).map((part: any) => part.text || '').join('')
      || data.choices?.[0]?.message?.content
      || '';
  }

  if (provider === 'openrouter') {
    const payload = buildOpenRouterPayload(settings, systemPrompt, userPrompt, mediaItems);
    if (opts.chat) { payload.max_tokens = CHAT_MAX_TOKENS; payload.provider = { sort: 'latency' }; }
    const model = String(payload.model || payload.models?.[0] || settings.model || OPENROUTER_MODEL);
    const res = await fetchAIWithRetry('/api/bytez', { provider: 'openrouter', apiKey, payload });
    const data = await readAIResponseJson(res, 'OpenRouter');
    if (!res.ok) {
      const detail = String(data.error?.message || data.error || 'OpenRouter error');
      if (/no endpoints found|not a valid model|model.*(not found|unavailable)|no allowed providers/i.test(detail)) {
        throw new Error(`OpenRouter no tiene disponible el modelo "${model}" (${detail}). En Configuración → Motor de IA elige un modelo vigente de OpenRouter.`);
      }
      if (/insufficient|credits|payment/i.test(detail) || res.status === 402) {
        throw new Error(`OpenRouter rechazó la solicitud por falta de créditos o límite de la llave (${detail}).`);
      }
      throw new Error(detail);
    }
    return data.choices?.[0]?.message?.content || '';
  }

  if (provider === 'bytez' || provider === 'nvidia_nim') {
    if (mediaItems.length > 0 && provider === 'bytez') {
      throw new Error('Bytez está configurado para texto en este flujo. Usa Gemini, NVIDIA NIM u OpenRouter para PDFs o imágenes, o pasa texto OCR.');
    }
    if (provider === 'nvidia_nim' && mediaItems.length > 0) {
      // OpenAI-compatible multimodal message: images first, then the text (NVIDIA's recommendation for document reading).
      const configured = settings.model || NVIDIA_NIM_MODEL;
      const model = NIM_VISION_CAPABLE.test(configured) ? configured : NVIDIA_NIM_VISION_MODEL;
      const pages = mediaItems.filter(item => item.mimeType.startsWith('image/')).slice(0, NIM_MAX_IMAGES);
      if (!pages.length) throw new Error('NVIDIA NIM lee imágenes (JPG/PNG o páginas de PDF). Convierte el archivo a imágenes o usa otro proveedor.');
      const visionModels = [model, ...[NVIDIA_NIM_VISION_MODEL, ...NVIDIA_NIM_VISION_FALLBACKS].filter(m => m !== model)];
      let lastVisionError = '';
      for (const visionModel of visionModels) {
        const nimPayload = {
          model: visionModel,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: [...pages.map(item => ({ type: 'image_url', image_url: { url: `data:${item.mimeType};base64,${item.base64}` } })), { type: 'text', text: userPrompt }] },
          ],
          temperature: 0,
          max_tokens: maxTokens,
        };
        const nimRes = await fetchAIWithRetry('/api/bytez', { provider, apiKey, payload: nimPayload }, [429, 502, 503]);
        const nimData = await readAIResponseJson(nimRes, 'NVIDIA NIM');
        if (nimRes.ok) return nimData.choices?.[0]?.message?.content || '';
        lastVisionError = String(nimData.error?.message || nimData.detail || nimData.title || nimData.error || `NVIDIA NIM error ${nimRes.status}`);
        if (nimRes.status !== 404 && nimRes.status !== 504) throw new Error(nimRes.status === 401 || nimRes.status === 403 ? `NVIDIA NIM rechazó la llave (${nimRes.status}): revisa que sea una llave nvapi- vigente. ${lastVisionError}` : lastVisionError);
      }
      throw new Error(`NVIDIA NIM: ningún modelo de visión disponible para esta cuenta (${visionModels.join(', ')}). ${lastVisionError}`);
    }
    const configuredModel = settings.model && !RETIRED_NIM_MODELS.has(settings.model) ? settings.model : (provider === 'bytez' ? BYTEZ_MODEL : NVIDIA_NIM_MODEL);
    const remembered = provider === 'nvidia_nim' ? workingNimModel() : '';
    const models = provider === 'nvidia_nim'
      ? Array.from(new Set([remembered, configuredModel, NVIDIA_NIM_MODEL, ...NVIDIA_NIM_FALLBACK_MODELS].filter(Boolean)))
      : [configuredModel];
    let lastError = '';
    for (const model of models) {
      const payload = {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0,
        max_tokens: maxTokens,
      };
      // NVIDIA: si un modelo no contesta a tiempo (504) se pasa al siguiente en vez de reintentar el mismo.
      const res = await fetchAIWithRetry('/api/bytez', { provider, apiKey, payload }, provider === 'nvidia_nim' ? [429, 502, 503] : undefined);
      const data = await readAIResponseJson(res, provider === 'bytez' ? 'Bytez' : 'NVIDIA NIM');
      if (res.ok) {
        const msg = data.choices?.[0]?.message || {};
        // Modelos que razonan (gpt-oss, deepseek) pueden dejar la respuesta en reasoning_content.
        const content = msg.content || msg.reasoning_content || msg.reasoning || '';
        if (provider === 'nvidia_nim') rememberNimModel(model);
        return content;
      }
      const detail = String(data.error?.message || data.detail || data.title || data.error || `${provider} error ${res.status}`);
      lastError = detail;
      // Modelo no disponible (404) o que no respondió a tiempo (504) → siguiente modelo; llave inválida (401/403) o límite (429) no.
      if (provider !== 'nvidia_nim' || (res.status !== 404 && res.status !== 504)) {
        throw new Error(res.status === 401 || res.status === 403 ? `NVIDIA NIM rechazó la llave (${res.status}): revisa que sea una llave nvapi- vigente. ${detail}` : detail);
      }
      console.warn(`NVIDIA NIM: el modelo ${model} no respondió (${res.status}); probando el siguiente.`);
    }
    throw new Error(`NVIDIA NIM: ningún modelo disponible para esta cuenta (${models.join(', ')}). ${lastError}`);
  }

  throw new Error(`Proveedor desconocido: ${provider}`);
}

async function readAIResponseJson(response: Response, provider: string) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    const plain = text.replace(/\s+/g, ' ').trim().slice(0, 240);
    if (response.status === 413 || /request entity too large|payload too large/i.test(plain)) {
      throw new Error(`El archivo es demasiado grande para enviarlo a ${provider}. Divide el PDF por estado financiero, comprímelo o súbelo como Excel/CSV/texto.`);
    }
    throw new Error(`${provider} devolvió una respuesta no JSON (${response.status}): ${plain || 'sin contenido'}`);
  }
}

async function fetchAIWithRetry(url: string, body: unknown, retryStatuses: number[] = [429, 502, 503, 504]): Promise<Response> {
  const { data: { session } } = await supabase.auth.getSession();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;
  let lastResponse: Response | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 62000);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      lastResponse = response;
      if (!retryStatuses.includes(response.status) || attempt === 1) return response;
      await new Promise(resolve => window.setTimeout(resolve, 1400));
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        throw new Error('La IA tardó más de 60 segundos en responder. Los modelos gratuitos se saturan seguido: intenta de nuevo o usa otro proveedor (Configuración → Motor de IA). Si estabas subiendo un documento, ya quedó guardado.');
      }
      if (attempt === 1) {
        throw new Error('Se perdió la conexión al recibir el análisis. Reintenta: el PDF ya se procesa en modo compacto y no necesitas volver a cargar otra API.');
      }
      await new Promise(resolve => window.setTimeout(resolve, 1000));
    } finally {
      window.clearTimeout(timeout);
    }
  }
  return lastResponse as Response;
}

function extractJSON(text: string): any {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1] : text;
  const start = raw.search(/[{\[]/);
  const end = raw.lastIndexOf('}') > raw.lastIndexOf(']') ? raw.lastIndexOf('}') : raw.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error('No JSON found in response');
  const candidate = raw.slice(start, end + 1).replace(/,\s*([}\]])/g, '$1');
  try {
    return JSON.parse(candidate);
  } catch (error: any) {
    throw new Error(`Respuesta JSON inválida o incompleta del modelo. Reintenta la extracción; si el PDF tiene muchas páginas, divide el archivo por estado financiero. Detalle: ${error?.message || error}`);
  }
}

function parseNullableNumber(value: unknown): number | null {
  const parsed = parseFinancialNumber(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeLiabilityType(value: unknown): ExtractedInstitutionalLiability['liabilityType'] {
  const raw = String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (/bono|bursatil|cebur|certificado/.test(raw)) return 'bono';
  if (/simple|term loan|prestamo/.test(raw)) return 'prestamo_simple';
  if (/linea|revolvente|revolver|credito en cuenta corriente/.test(raw)) return 'linea_credito';
  return 'otro';
}

function providerSupportsMedia(provider: AIProvider) {
  return provider === 'gemini' || provider === 'openai' || provider === 'claude';
}

// Free providers that can read page images but do better (and faster) with OCR text when the document has it.
const FREE_VISION_PROVIDERS: AIProvider[] = ['openrouter', 'nvidia_nim'];

// When the document already has OCR/text, text-only and free providers use it and drop the images (faster, more reliable). With no
// text (scanned), OpenRouter reads the page images with a free vision model; Bytez/NVIDIA hand off to an enabled vision provider.
export function resolveMediaAccess(settings: AISettings, documentText: string, media?: AIMedia | AIMedia[]): { settings: AISettings; media?: AIMedia | AIMedia[]; droppedMedia: boolean } {
  const items = media ? (Array.isArray(media) ? media : [media]).filter(item => item.base64 && item.mimeType) : [];
  if (!items.length || providerSupportsMedia(settings.provider)) return { settings, media, droppedMedia: false };
  // (text-only and free-vision providers: use the text when there is enough, otherwise see below)
  if (documentText.trim().length >= 200) return { settings, media: undefined, droppedMedia: true };
  if (FREE_VISION_PROVIDERS.includes(settings.provider)) return { settings, media, droppedMedia: false }; // free vision models read the page images
  const normalized = normalizeAISettings(settings);
  const visual = (['gemini', 'openai', 'claude'] as AIProvider[]).find(p => normalized.providers?.[p]?.enabled && normalized.providers?.[p]?.apiKey);
  if (visual) {
    const config = normalized.providers![visual];
    return { settings: { ...normalized, provider: visual, apiKey: config.apiKey, model: config.model, fallbackModels: config.fallbackModels }, media, droppedMedia: false };
  }
  return { settings, media, droppedMedia: false }; // callAI explains what to do
}

function normalizeDateString(value: unknown): string | undefined {
  const raw = String(value || '').trim();
  if (!raw) return undefined;
  const parsed = new Date(raw);
  if (Number.isFinite(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  const match = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (!match) return undefined;
  const year = match[3].length === 2 ? `20${match[3]}` : match[3];
  const iso = `${year}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
  const fallbackDate = new Date(iso);
  return Number.isFinite(fallbackDate.getTime()) ? iso : undefined;
}

function normalizeInterestRate(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = parseNullableNumber(value);
  if (parsed === null) return null;
  if (String(value).includes('%')) return parsed / 100;
  return parsed > 1 && parsed <= 100 ? parsed / 100 : parsed;
}

function normalizeLiabilitiesExtraction(parsed: any): ExtractedInstitutionalLiability[] {
  const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.liabilities) ? parsed.liabilities : [];
  return rows.map((row: any) => {
    const lenderName = String(row.lenderName || row.lender || row.acreedor || row.institucion || '').trim();
    if (!lenderName) return null;
    return {
      lenderName,
      liabilityType: normalizeLiabilityType(row.liabilityType || row.type || row.tipo),
      originalAmount: parseNullableNumber(row.originalAmount ?? row.montoOriginal ?? row.montoOtorgado ?? row.lineaCredito),
      currentBalance: parseNullableNumber(row.currentBalance ?? row.saldoActual ?? row.saldoInsoluto ?? row.saldo),
      currency: String(row.currency || row.moneda || 'MXN').trim().toUpperCase() || 'MXN',
      interestRate: normalizeInterestRate(row.interestRate ?? row.tasa ?? row.tasaInteres),
      rateDescription: String(row.rateDescription || row.referenciaTasa || row.formulaTasa || '').trim() || undefined,
      originationDate: normalizeDateString(row.originationDate || row.fechaOriginacion || row.fechaFirma),
      maturityDate: normalizeDateString(row.maturityDate || row.fechaVencimiento || row.vencimiento),
      amortization: String(row.amortization || row.amortizacion || row.esquemaPago || '').trim() || undefined,
      guarantee: String(row.guarantee || row.garantia || row.garantias || '').trim() || undefined,
      notes: String(row.notes || row.notas || row.observaciones || '').trim() || undefined,
    } satisfies ExtractedInstitutionalLiability;
  }).filter((row: ExtractedInstitutionalLiability | null): row is ExtractedInstitutionalLiability => Boolean(row));
}

function normalizeLoanTapeSheetExtraction(parsed: any): ExtractedLoanTapeSheet[] {
  const rawSheets = Array.isArray(parsed?.sheets)
    ? parsed.sheets
    : Array.isArray(parsed?.tables)
      ? parsed.tables
      : Array.isArray(parsed?.rows)
        ? [{ name: parsed?.sheetName || parsed?.name || 'Imagen', rows: parsed.rows }]
        : Array.isArray(parsed)
          ? [{ name: 'Imagen', rows: parsed }]
          : [];

  const sheets = rawSheets.map((sheet: any, index: number) => {
    const rawRows = Array.isArray(sheet?.rows) ? sheet.rows : Array.isArray(sheet) ? sheet : [];
    let rows: any[][] = [];
    if (rawRows.every((row: any) => Array.isArray(row))) {
      rows = rawRows as any[][];
    } else if (rawRows.every((row: any) => row && typeof row === 'object' && !Array.isArray(row))) {
      const headers = Array.from(new Set(rawRows.flatMap((row: any) => Object.keys(row)))) as string[];
      rows = [headers, ...rawRows.map((row: any) => headers.map(header => row[header] ?? null))];
    }
    rows = rows
      .map(row => row.map(cell => {
        if (cell === undefined || cell === '') return null;
        if (cell === null || typeof cell === 'string' || typeof cell === 'number' || typeof cell === 'boolean') return cell;
        return String(cell);
      }))
      .filter(row => row.some(cell => cell !== null && String(cell).trim() !== ''))
      .slice(0, 2500);
    return { name: String(sheet?.name || sheet?.sheetName || `Imagen ${index + 1}`), rows };
  }).filter((sheet: ExtractedLoanTapeSheet) => sheet.rows.length >= 2);

  if (!sheets.length) throw new Error('La imagen/PDF no devolvió una tabla de loan tape legible.');
  return sheets;
}

async function extractContractJSONWithRepair(settings: AISettings, text: string): Promise<any> {
  try {
    return extractJSON(text);
  } catch {
    const repairSystem = `Eres un reparador estricto de JSON.
Recibes una respuesta parcialmente inválida y devuelves únicamente JSON válido.
No agregues explicaciones, markdown ni información nueva. Conserva los datos recuperables.`;
    const repairPrompt = `Repara este JSON para que cumpla exactamente esta estructura:
{
  "client":{"legalName":"","taxId":"","industry":"Otro"},
  "transaction":{"contractName":"","description":"","creditType":"Otro","originalAmount":0,"currency":"MXN","signedAt":"","maturityAt":"","reviewFrequency":"mensual"},
  "condicionesHacer":[],
  "condicionesNoHacer":[],
  "covenants":[{"name":"","threshold":"","operator":"none","description":"","formula":""}]
}

Limita cada lista a los elementos completos que ya existan. Elimina el último elemento si quedó truncado.

Respuesta a reparar:
${text.slice(0, 14000)}`;
    const repaired = await callAI(settings, repairSystem, repairPrompt);
    try {
      return extractJSON(repaired);
    } catch (error: any) {
      throw new Error(`El modelo respondió, pero el JSON quedó incompleto incluso después de repararlo. Reintenta una vez; la segunda pasada suele completarlo. Detalle: ${error?.message || error}`);
    }
  }
}

// ─── Financial statement extraction ──────────────────────────────────────────

export async function extractFinancials(
  settings: AISettings,
  content: string | AIMedia | AIMedia[] | AIDocumentContent,
  expectedClientName?: string
): Promise<ExtractionResult> {
  settings = settingsForTask(settings, 'financials');
  const system = financialsPrompt;

  const isTextContent = typeof content === 'string';
  const documentText = isTextContent
    ? content
    : !Array.isArray(content) && 'text' in content
      ? String(content.text || '')
      : '';
  const rawMedia: AIMedia | AIMedia[] | undefined = isTextContent
    ? undefined
    : !Array.isArray(content) && 'media' in content
      ? content.media
      : content as AIMedia | AIMedia[];
  const access = resolveMediaAccess(settings, documentText, rawMedia);
  settings = access.settings;
  const documentMedia = access.media;
  const prompt = documentText
    ? `Cliente esperado en la app (NO confundir con el emisor del documento): ${expectedClientName || 'no indicado'}.

Aplica el proceso de extracción completo descrito en las instrucciones del sistema.
${documentMedia ? 'Usa el texto OCR como guía y valida/completa contra las imágenes adjuntas cuando haya tablas escaneadas o jerarquía visual.' : ''}
Devuelve únicamente JSON minificado con la estructura indicada.

Documento:
${documentText}`
    : `Cliente esperado en la app (NO confundir con el emisor del documento): ${expectedClientName || 'no indicado'}.

Lee el documento adjunto y aplica el proceso de extracción completo descrito en las instrucciones del sistema.
Devuelve únicamente JSON minificado con la estructura indicada.`;

  const text = await callAIResilient(settings, system, prompt, documentText, documentMedia);
  const result = normalizeFinancialExtraction(extractJSON(text));

  if (hasStatementType(result, 'estado_resultados')) return result;

  const rescuePrompt = documentText
    ? `Cliente esperado en la app (NO confundir con el emisor del documento): ${expectedClientName || 'no indicado'}.

La extracción anterior NO encontró Estado de Resultados. Relee el documento completo y extrae SOLO Estado de Resultados / PyG / Estado de Resultados Integral.
Ignora Balance General, flujo de efectivo, covenants, razones financieras, notas y tablas auxiliares.
Busca encabezados como INGRESOS, COSTOS, GASTOS, UTILIDAD, RESULTADO, MARGEN FINANCIERO, INTERESES, COMISIONES, IMPUESTOS.
Devuelve únicamente JSON minificado con la misma estructura indicada; todos los rawLineItems deben tener statementType "estado_resultados".

Documento:
${documentText}`
    : `Cliente esperado en la app (NO confundir con el emisor del documento): ${expectedClientName || 'no indicado'}.

La extracción anterior NO encontró Estado de Resultados. Relee todos los adjuntos y extrae SOLO Estado de Resultados / PyG / Estado de Resultados Integral.
Ignora Balance General, flujo de efectivo, covenants, razones financieras, notas y tablas auxiliares.
Busca encabezados como INGRESOS, COSTOS, GASTOS, UTILIDAD, RESULTADO, MARGEN FINANCIERO, INTERESES, COMISIONES, IMPUESTOS.
Devuelve únicamente JSON minificado con la misma estructura indicada; todos los rawLineItems deben tener statementType "estado_resultados".`;

  try {
    const rescueText = await callAIResilient(settings, system, rescuePrompt, documentText, documentMedia);
    const rescue = normalizeFinancialExtraction(extractJSON(rescueText));
    return hasStatementType(rescue, 'estado_resultados')
      ? mergeFinancialExtractions(result, rescue)
      : result;
  } catch (error) {
    console.warn('No se pudo rescatar Estado de Resultados en segunda pasada.', error);
    return result;
  }
}

// ─── Contract covenant extraction ─────────────────────────────────────────────

export async function extractCovenants(
  settings: AISettings,
  contractText: string,
  media?: AIMedia | AIMedia[]
): Promise<ContractExtractionResult> {
  settings = settingsForTask(settings, 'contracts');
  const system = `Eres un abogado y analista de crédito experto en contratos de financiamiento IFNB mexicanos.
Extraes covenants financieros y condiciones de hacer/no hacer de contratos de crédito.
Devuelves únicamente JSON válido.`;

  const hasText = contractText.trim().length > 0;
  const mediaItems = media ? (Array.isArray(media) ? media : [media]).filter(item => item.base64 && item.mimeType) : [];
  const docRef = mediaItems.length > 0
    ? `los documentos adjuntos${hasText ? ' y el texto proporcionado' : ''}`
    : 'el siguiente contrato';
  const attachmentList = mediaItems.length > 0
    ? `\nArchivos adjuntos: ${mediaItems.map(item => item.fileName || item.mimeType).join(', ')}`
    : '';

  const prompt = `Extrae de ${docRef}:
1. condicionesHacer: obligaciones positivas (cosas que el acreditado DEBE hacer)
2. condicionesNoHacer: obligaciones negativas (cosas que el acreditado NO debe hacer)
3. covenants: razones financieras con umbrales numéricos. Si el covenant corresponde a uno de estos indicadores, pon su clave en "indicatorKey" (si no corresponde a ninguno, deja "indicatorKey": null):
   capitalization (ICAP = capital contable / activos), adjusted_capitalization (capital / cartera neta), leverage (bancos y fondos / activos),
   debt_equity (deuda / capital), debt_ebitda (deuda / EBITDA), dscr (EBITDA / gasto financiero), current_ratio (activo circulante / pasivo circulante),
   immediate_liquidity (efectivo e inversiones / pasivo circulante), roa, roe, ifnb_net_margin, ifnb_financial_margin, ifnb_operating_efficiency,
   past_due_portfolio (cartera vencida / cartera total, IMOR), past_due_coverage (estimación preventiva / cartera vencida), portfolio_yield, funding_cost, financial_spread.
4. terminos: términos económicos del crédito. Usa null cuando el contrato no lo diga; NO inventes.
   - Tasas en % anual como número (ej. 14.5). Si la tasa es variable (TIIE, SOFR…): tasaTipo "variable", referencia, sobretasa en puntos porcentuales, y piso / techo si los hay.
   - Moratorios: copia el texto del contrato en moratorioTexto; si es un múltiplo de la ordinaria pon moratorioFactor (ej. 2), si es una tasa fija pon moratorioTasa.
   - Comisiones relevantes (apertura, disposición, administración, prepago, no disposición, etc.) con su valor y base tal como vienen.

Devuelve JSON:
{
  "condicionesHacer": ["condición completa tal como aparece en el contrato", ...],
  "condicionesNoHacer": ["condición completa...", ...],
  "covenants": [
    {
      "name": "nombre del indicador",
      "threshold": "valor límite (ej: 2.0, 5%, 1.25x)",
      "operator": "gte|lte|gt|lt",
      "description": "descripción breve del indicador",
      "formula": "descripción de cómo se calcula",
      "indicatorKey": "debt_equity | null"
    }
  ],
  "terminos": {
    "plazoMeses": "plazo total del crédito en meses o null",
    "disposicionMinima": "monto mínimo por disposición o null",
    "plazoDisposicionMeses": "plazo de pago de cada disposición en meses o null",
    "periodicidadPago": "mensual | trimestral | al vencimiento | ... o null",
    "tasaTipo": "fija | variable",
    "tasaFija": "número % anual o null",
    "referencia": "TIIE 28 | TIIE 91 | SOFR | ... o null",
    "sobretasa": "puntos porcentuales sobre la referencia o null",
    "piso": "% anual o null",
    "techo": "% anual o null",
    "moratorioTexto": "texto del contrato o null",
    "moratorioFactor": "veces la ordinaria o null",
    "moratorioTasa": "% anual o null",
    "comisiones": [{ "concepto": "apertura", "valor": "1%", "base": "sobre el monto de la línea, por única vez" }],
    "notas": "otras condiciones económicas relevantes o null"
  }
}
${attachmentList}
${hasText ? `\nTexto del contrato:\n${contractText.slice(0, 40000)}` : ''}`;

  const text = await callAI(settings, system, prompt, media);
  const parsed = extractJSON(text);
  return {
    condicionesHacer: Array.isArray(parsed.condicionesHacer) ? parsed.condicionesHacer : [],
    condicionesNoHacer: Array.isArray(parsed.condicionesNoHacer) ? parsed.condicionesNoHacer : [],
    covenants: Array.isArray(parsed.covenants) ? parsed.covenants : [],
    terminos: parsed.terminos && typeof parsed.terminos === 'object' ? parsed.terminos : undefined,
  };
}

export async function extractClientFromContract(
  settings: AISettings,
  contractText: string,
  media?: AIMedia | AIMedia[]
): Promise<ContractClientExtractionResult> {
  settings = settingsForTask(settings, 'contracts');
  const system = `Eres un abogado y analista de crédito experto en contratos de financiamiento mexicanos.
Extraes el perfil del acreditado, condiciones principales, obligaciones y covenants.
No inventes información. Cuando un dato no aparezca, usa cadena vacía o cero.
Devuelve únicamente JSON válido.`;

  const hasText = contractText.trim().length > 0;
  const mediaItems = media ? (Array.isArray(media) ? media : [media]).filter(item => item.base64 && item.mimeType) : [];
  const prompt = `Analiza ${mediaItems.length ? 'los documentos adjuntos' : 'el contrato proporcionado'} y devuelve:
{
  "client": {
    "legalName": "razón social exacta del acreditado",
    "taxId": "RFC o identificador fiscal",
    "industry": "SOFOM|SOFIPO|Arrendadora|Factoraje|Crédito Simple|Otro"
  },
  "transaction": {
    "contractName": "nombre o título del contrato",
    "description": "resumen breve del financiamiento",
    "creditType": "Simple|Revolvente|Flex|Factoraje|Arrendamiento|Crédito Puente|Otro",
    "originalAmount": 0,
    "currency": "MXN|USD|EUR",
    "signedAt": "YYYY-MM-DD o vacío",
    "maturityAt": "YYYY-MM-DD o vacío",
    "reviewFrequency": "mensual|trimestral"
  },
  "condicionesHacer": ["obligación positiva completa"],
  "condicionesNoHacer": ["obligación negativa completa"],
  "covenants": [{
    "name": "nombre",
    "threshold": "umbral",
    "operator": "gte|lte|gt|lt|none",
    "description": "descripción",
    "formula": "fórmula descrita en el contrato"
  }]
}

Reglas:
- Distingue al acreditado de acreditante, fiduciario, obligado solidario y garantes.
- originalAmount debe ser número sin símbolos ni separadores.
- Usa MXN por defecto solo si el contrato habla de pesos mexicanos.
- No conviertas ni estimes importes.
- Conserva literalmente los umbrales de covenants.
- Esta es una extracción inicial rápida: devuelve máximo 8 condiciones de hacer, 8 de no hacer y 10 covenants prioritarios.
- Usa descripciones concisas; no copies cláusulas completas de varias páginas.
${hasText ? `\nTexto extraído y priorizado:\n${contractText.slice(0, 26000)}` : ''}`;

  const text = await callAI(settings, system, prompt, mediaItems.length ? mediaItems : undefined);
  const parsed = await extractContractJSONWithRepair(settings, text);
  const currency = ['MXN', 'USD', 'EUR'].includes(parsed.transaction?.currency) ? parsed.transaction.currency : 'MXN';
  const frequency = parsed.transaction?.reviewFrequency === 'trimestral' ? 'trimestral' : 'mensual';
  return {
    client: {
      legalName: String(parsed.client?.legalName || ''),
      taxId: String(parsed.client?.taxId || ''),
      industry: String(parsed.client?.industry || 'Otro'),
    },
    transaction: {
      contractName: String(parsed.transaction?.contractName || ''),
      description: String(parsed.transaction?.description || ''),
      creditType: String(parsed.transaction?.creditType || 'Simple'),
      originalAmount: Number(parsed.transaction?.originalAmount) || 0,
      currency,
      signedAt: String(parsed.transaction?.signedAt || ''),
      maturityAt: String(parsed.transaction?.maturityAt || ''),
      reviewFrequency: frequency,
    },
    condicionesHacer: Array.isArray(parsed.condicionesHacer) ? parsed.condicionesHacer.map(String) : [],
    condicionesNoHacer: Array.isArray(parsed.condicionesNoHacer) ? parsed.condicionesNoHacer.map(String) : [],
    covenants: Array.isArray(parsed.covenants) ? parsed.covenants : [],
  };
}

// ─── Loan tape analysis ────────────────────────────────────────────────────────

export async function analyzeLoanTape(
  settings: AISettings,
  tapeData: any[],
  clientName: string,
  covenants?: Array<{ name: string; threshold: string }>
): Promise<StructuredLoanTapeAnalysis> {
  settings = settingsForTask(settings, 'loan_tape');
  const system = loanTapePrompt;

  const prompt = `Ejecuta el análisis completo para la cartera de crédito de "${clientName}".
${covenants?.length ? `\nCovenants contractuales a evaluar: ${JSON.stringify(covenants)}` : ''}

Datos del loan tape (primeras 200 filas):
${JSON.stringify(tapeData.slice(0, 200))}

Sigue los 8 pasos del sistema y devuelve únicamente JSON minificado con la estructura indicada.`;

  const text = await callAI(settings, system, prompt);
  return extractJSON(text);
}

export async function extractLoanTapeSheetsFromDocument(
  settings: AISettings,
  content: AIMedia | AIMedia[] | AIDocumentContent,
  clientName?: string,
  fileName?: string,
): Promise<ExtractedLoanTapeSheet[]> {
  settings = settingsForTask(settings, 'loan_tape');
  const isDocument = !Array.isArray(content) && 'text' in content;
  const documentText = isDocument ? String(content.text || '') : '';
  const documentMedia = isDocument ? content.media : content as AIMedia | AIMedia[];
  const mediaItems = documentMedia ? (Array.isArray(documentMedia) ? documentMedia : [documentMedia]).filter(item => item.base64 && item.mimeType) : [];
  if (mediaItems.length > 0 && !providerSupportsMedia(settings.provider)) {
    const normalized = normalizeAISettings(settings);
    const visualProvider = (['gemini', 'openai', 'claude'] as AIProvider[])
      .find(provider => normalized.providers?.[provider]?.enabled);
    if (visualProvider) {
      const config = normalized.providers?.[visualProvider] || providerSettings(normalized, visualProvider);
      settings = {
        ...normalized,
        provider: visualProvider,
        apiKey: config.apiKey,
        model: config.model,
        fallbackModels: config.fallbackModels,
      };
    }
  }
  const system = `Eres un extractor OCR/tabular para loan tapes de crédito.
Reconstruyes tablas desde imágenes, PDFs escaneados o texto pegado y devuelves únicamente JSON válido.
No hagas análisis de riesgo aquí. No inventes columnas ni valores.`;

  const prompt = `Cliente esperado: ${clientName || 'no indicado'}.
Archivo: ${fileName || 'no indicado'}.

Extrae la tabla de cartera/loan tape visible. Conserva encabezados originales y filas de datos.
Si el archivo es un desglose resumido por producto, estado, segmento o modalidad, extrae esa tabla resumen completa.
Si hay varias tablas, devuelve una hoja por tabla.

Devuelve exactamente:
{"sheets":[{"name":"nombre de hoja o tabla","rows":[["encabezado 1","encabezado 2"],["valor 1","valor 2"]]}]}

Reglas:
- La primera fila de cada "rows" debe ser la fila de encabezados.
- Mantén importes como texto o número sin traducir su escala.
- Mantén porcentajes con su símbolo si aparece.
- No agregues totales si no están visibles.
- Si una celda no se puede leer, usa null.
${documentText ? `\nTexto OCR/base disponible:\n${documentText.slice(0, 50000)}` : '\nUsa el documento/imagen adjunta.'}`;

  const text = await callAI(settings, system, prompt, documentMedia);
  return normalizeLoanTapeSheetExtraction(extractJSON(text));
}

// ─── Institutional liabilities extraction ────────────────────────────────────

export async function extractInstitutionalLiabilities(
  settings: AISettings,
  content: string | AIDocumentContent,
  clientName?: string,
  fileName?: string,
): Promise<ExtractedInstitutionalLiability[]> {
  settings = settingsForTask(settings, 'liabilities');
  const isTextContent = typeof content === 'string';
  const documentText = isTextContent ? content : String(content.text || '');
  const documentMedia = isTextContent ? undefined : content.media;
  const system = `Eres analista de crédito especializado en fondeo institucional de IFNB/SOFOM/SOFIPO.
Extraes una tabla de pasivos institucionales: bancos, fideicomisos, líneas de crédito, préstamos simples, bonos y otros fondeadores.
No inventes datos. Si un campo no aparece, usa null o cadena vacía.
Devuelve únicamente JSON válido.`;

  const prompt = `Cliente esperado en la app: ${clientName || 'no indicado'}.
Archivo: ${fileName || 'no indicado'}.

Extrae cada pasivo/facility institucional como una fila. Busca tablas o secciones con acreedor, acreditante, banco, fondeador, préstamo, línea, saldo, monto autorizado, saldo insoluto, tasa, vencimiento, garantía y amortización.

Devuelve exactamente:
{
  "liabilities": [
    {
      "lenderName": "Banco / institución / fondeador",
      "liabilityType": "linea_credito|prestamo_simple|bono|otro",
      "originalAmount": 0,
      "currentBalance": 0,
      "currency": "MXN|USD|EUR",
      "interestRate": 0.12,
      "rateDescription": "TIIE + 350 pb",
      "originationDate": "YYYY-MM-DD",
      "maturityDate": "YYYY-MM-DD",
      "amortization": "mensual|trimestral|bullet|otro",
      "guarantee": "garantía principal",
      "notes": "observación breve o fuente"
    }
  ]
}

Reglas:
- originalAmount y currentBalance deben ser números sin separadores ni símbolos.
- interestRate debe ser decimal anual: 12% => 0.12.
- Si solo aparece una tasa descriptiva sin número, deja interestRate null y úsala en rateDescription.
- Si hay totales agregados, no los dupliques como facilities.
- Si el documento trae varios acreedores o varios créditos, devuelve una fila por cada uno.
- Si no hay pasivos institucionales claros, devuelve {"liabilities":[]}.
${documentText ? `\nTexto del documento:\n${documentText.slice(0, 50000)}` : '\nUsa el documento/imagen adjunta.'}`;

  const text = await callAI(settings, system, prompt, documentMedia);
  return normalizeLiabilitiesExtraction(extractJSON(text));
}

// ─── Monitoring opinion ────────────────────────────────────────────────────────

export async function generateOpinion(
  settings: AISettings,
  clientName: string,
  period: string,
  covenantData: Array<{ name: string; threshold: string; value?: string; status: string }>,
  paymentSummary: string
): Promise<string> {
  settings = settingsForTask(settings, 'opinion');
  const system = `Eres un analista de crédito senior de una institución financiera mexicana.
Redactas comentarios de monitoreo profesionales, concisos y objetivos.`;

  const prompt = `Redacta el apartado "Resumen y Comentarios" del reporte de monitoreo para:
Cliente: ${clientName}
Período: ${period}

Historial de pagos: ${paymentSummary}

Covenants:
${covenantData.map(c => `- ${c.name}: requerido ${c.threshold}, valor ${c.value || 'N/D'} → ${c.status}`).join('\n')}

Redacta 3-4 párrafos breves y directos en español. Sin bullets. Tono profesional y objetivo.
Menciona: cumplimiento de pagos, estado de covenants, observaciones relevantes, perspectiva.`;

  return callAI(settings, system, prompt);
}

export async function suggestAccountConsolidation(
  settings: AISettings,
  accounts: Array<{ name: string; statementType?: string; clientName?: string }>,
  existingCovenants: Array<{ name: string; formula?: string; description?: string }> = []
): Promise<AccountConsolidationSuggestion> {
  settings = settingsForTask(settings, 'account_consolidation');
  const system = `Eres analista contable NIF y crédito IFNB.
Tu tarea es mapear nombres de cuentas extraídas a campos consolidados y proponer plantillas de covenants.
No inventes cifras. No devuelvas cuentas que no estén en el input. Devuelve JSON válido.`;

  const prompt = `Campos permitidos para metric:
revenue, ebitda, interestExpense, netIncome, currentAssets, currentLiabilities, totalDebt, totalAssets, equity, cash, operatingCashFlow.

Reglas:
- Si no estás razonablemente seguro, omite esa cuenta.
- confidence debe ser 0 a 1.
- covenantTemplates son plantillas globales sin activar; formula debe usar formato ratio:campo/campo cuando aplique.
- No pongas umbral si no viene de covenants existentes.

Cuentas:
${JSON.stringify(accounts.slice(0, 400))}

Covenants existentes:
${JSON.stringify(existingCovenants.slice(0, 120))}

Devuelve:
{
  "mappings":[{"accountName":"...","statementType":"balance_general|estado_resultados|flujo_efectivo|otro|any","metric":"...","confidence":0.85,"reason":"..."}],
  "covenantTemplates":[{"name":"...","formula":"ratio:totalDebt/ebitda","description":"...","operator":"none","threshold":""}]
}`;

  const text = await callAI(settings, system, prompt);
  const parsed = extractJSON(text);
  return {
    mappings: Array.isArray(parsed.mappings) ? parsed.mappings : [],
    covenantTemplates: Array.isArray(parsed.covenantTemplates) ? parsed.covenantTemplates : [],
  };
}

// ─── Test connection ──────────────────────────────────────────────────────────

export async function testConnection(settings: AISettings): Promise<string> {
  // Respuesta corta pero con margen: un modelo que razona gasta tokens "pensando" antes de escribir el OK.
  lastNimModel = '';
  const text = await callAI(settings, 'Responde únicamente con: OK', 'Di "OK"', undefined, { chat: true, maxTokens: 512 });
  const model = settings.provider === 'nvidia_nim' && lastNimModel ? ` · modelo ${lastNimModel}` : '';
  return text.trim() ? `OK${model}` : `El proveedor respondió vacío${model}`;
}


// Pregunta libre sobre un cliente. El contexto (clientContext.ts) ya trae estados, ratios, indicadores y loan tape agregados;
// la conversación previa se manda como texto para que funcione igual con cualquier proveedor (OpenRouter, Gemini, Claude…).
export async function askClientAssistant(
  settings: AISettings,
  systemPrompt: string,
  contextText: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  question: string,
  contextLabel = 'CONTEXTO DEL CLIENTE',
): Promise<string> {
  settings = settingsForTask(settings, 'assistant');
  const previous = history.slice(-6).map(m => `${m.role === 'user' ? 'USUARIO' : 'ASISTENTE'}: ${m.content}`).join('\n\n');
  const prompt = `${contextLabel}\n${contextText}\n\n${previous ? `CONVERSACIÓN PREVIA\n${previous}\n\n` : ''}PREGUNTA ACTUAL\n${question}`;
  return callAI(settings, systemPrompt, prompt, undefined, { chat: true });
}
