// Multi-provider AI service: Gemini, Claude, OpenAI
// Uses Vite proxy at /api/gemini, /api/claude, /api/openai

import loanTapePrompt from '../prompts/loan-tape.md?raw';
import financialsPrompt from '../prompts/financials.md?raw';

export type AIProvider = 'gemini' | 'claude' | 'openai';

export interface AISettings {
  provider: AIProvider;
  apiKey: string;
}

const SETTINGS_KEY = 'finmonitor_ai_settings';
const GEMINI_MODEL = 'gemini-flash-latest';

export interface AIMedia {
  base64: string;
  mimeType: string;
  fileName?: string;
}

export function loadAISettings(): AISettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return JSON.parse(raw) as AISettings;
  } catch {}
  // Legacy key
  const legacyKey = localStorage.getItem('finmonitor_claude_key');
  if (legacyKey) return { provider: 'claude', apiKey: legacyKey };
  return { provider: 'gemini', apiKey: '' };
}

export function saveAISettings(s: AISettings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

// ─── Raw types ────────────────────────────────────────────────────────────────

export type StatementType = 'balance_general' | 'estado_resultados' | 'flujo_efectivo' | 'otro';

export interface RawLineItem { name: string; value: number; source?: string; sectionPath?: string | null; statementType?: StatementType; }

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
}

export interface ContractExtractionResult {
  condicionesHacer: string[];
  condicionesNoHacer: string[];
  covenants: FinancialCovenant[];
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

// ─── Core request dispatcher ──────────────────────────────────────────────────

async function callAI(settings: AISettings, systemPrompt: string, userPrompt: string, media?: AIMedia | AIMedia[]): Promise<string> {
  const { provider, apiKey } = settings;
  const mediaItems = media ? (Array.isArray(media) ? media : [media]).filter(item => item.base64 && item.mimeType) : [];

  if (provider === 'gemini') {
    const parts: any[] = [{ text: `${systemPrompt}\n\n${userPrompt}` }];
    for (const item of mediaItems) {
      parts.push({ inlineData: { data: item.base64, mimeType: item.mimeType } });
    }
    const payload = {
      contents: [{ parts }],
      generationConfig: { temperature: 0.0, maxOutputTokens: 16384, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } },
    };
    const res = await fetchAIWithRetry('/api/gemini', { apiKey, model: GEMINI_MODEL, payload });
    const data = await res.json();
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
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    };
    const res = await fetchAIWithRetry('/api/claude', { apiKey, payload });
    const data = await res.json();
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
      model: 'gpt-4o',
      max_output_tokens: 8192,
      instructions: systemPrompt,
      input: [{ role: 'user', content: userContent }],
    };
    const res = await fetchAIWithRetry('/api/openai/responses', { apiKey, payload });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || data.error || 'OpenAI error');
    return data.output_text
      || data.output?.flatMap((item: any) => item.content || []).map((part: any) => part.text || '').join('')
      || data.choices?.[0]?.message?.content
      || '';
  }

  throw new Error(`Proveedor desconocido: ${provider}`);
}

async function fetchAIWithRetry(url: string, body: unknown): Promise<Response> {
  let lastResponse: Response | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 62000);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      lastResponse = response;
      if (![429, 502, 503, 504].includes(response.status) || attempt === 1) return response;
      await new Promise(resolve => window.setTimeout(resolve, 1400));
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        throw new Error('El análisis tardó demasiado. El contrato quedó guardado; intenta analizarlo nuevamente o usa otro proveedor.');
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
  content: string | AIMedia,
  expectedClientName?: string
): Promise<ExtractionResult> {
  const system = financialsPrompt;

  const prompt = typeof content === 'string'
    ? `Cliente esperado en la app (NO confundir con el emisor del documento): ${expectedClientName || 'no indicado'}.

Aplica el proceso de extracción completo descrito en las instrucciones del sistema.
Devuelve únicamente JSON minificado con la estructura indicada.

Documento:
${content}`
    : `Cliente esperado en la app (NO confundir con el emisor del documento): ${expectedClientName || 'no indicado'}.

Lee el documento adjunto y aplica el proceso de extracción completo descrito en las instrucciones del sistema.
Devuelve únicamente JSON minificado con la estructura indicada.`;

  const text = await callAI(settings, system, prompt, typeof content === 'string' ? undefined : content);
  const parsed = extractJSON(text);
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
    rawLineItems: (stmt.rawLineItems || []).map((item: any) => ({
      name: String(item.name || ''),
      value: Number(item.value) || 0,
      source: item.source,
      sectionPath: item.sectionPath || null,
      statementType: item.statementType || item.type || 'otro',
    })),
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

// ─── Contract covenant extraction ─────────────────────────────────────────────

export async function extractCovenants(
  settings: AISettings,
  contractText: string,
  media?: AIMedia | AIMedia[]
): Promise<ContractExtractionResult> {
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
3. covenants: razones financieras con umbrales numéricos

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
      "formula": "descripción de cómo se calcula"
    }
  ]
}
${attachmentList}
${hasText ? `\nTexto del contrato:\n${contractText.slice(0, 12000)}` : ''}`;

  const text = await callAI(settings, system, prompt, media);
  const parsed = extractJSON(text);
  return {
    condicionesHacer: Array.isArray(parsed.condicionesHacer) ? parsed.condicionesHacer : [],
    condicionesNoHacer: Array.isArray(parsed.condicionesNoHacer) ? parsed.condicionesNoHacer : [],
    covenants: Array.isArray(parsed.covenants) ? parsed.covenants : [],
  };
}

export async function extractClientFromContract(
  settings: AISettings,
  contractText: string,
  media?: AIMedia | AIMedia[]
): Promise<ContractClientExtractionResult> {
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
  const system = loanTapePrompt;

  const prompt = `Ejecuta el análisis completo para la cartera de crédito de "${clientName}".
${covenants?.length ? `\nCovenants contractuales a evaluar: ${JSON.stringify(covenants)}` : ''}

Datos del loan tape (primeras 200 filas):
${JSON.stringify(tapeData.slice(0, 200))}

Sigue los 8 pasos del sistema y devuelve únicamente JSON minificado con la estructura indicada.`;

  const text = await callAI(settings, system, prompt);
  return extractJSON(text);
}

// ─── Monitoring opinion ────────────────────────────────────────────────────────

export async function generateOpinion(
  settings: AISettings,
  clientName: string,
  period: string,
  covenantData: Array<{ name: string; threshold: string; value?: string; status: string }>,
  paymentSummary: string
): Promise<string> {
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
  const text = await callAI(settings, 'Responde únicamente con: OK', 'Di "OK"');
  return text.trim();
}
