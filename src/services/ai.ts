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

export interface RawLineItem { name: string; value: number; source?: string; statementType?: StatementType; }

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

export interface StructuredLoanTapeAnalysis {
  overallStatus: string; riskScore: number; executiveSummary: string; trendDirection: string;
  portfolioQuality?: Record<string, { count: number; balance: number; pct: number }>;
  dpd_distribution?: Array<{ bucket: string; count: number; balance: number; pct: number }>;
  concentrations?: Record<string, Array<{ name: string; count: number; balance: number; pct: number; severity?: string }>>;
  anomalies?: Record<string, any[]>;
  validation?: Array<{ loan_id: string; rule_id: string; field: string; message: string; severity?: string }>;
  metrics: Array<{ name: string; latestValue: string; previousValue?: string; change?: string; trend: string; status: string; contractLimit?: string; congruent: boolean; }>;
  findings: Array<{ severity: string; category: string; title: string; detail: string; recommendation?: string; }>;
  congruencyChecks: Array<{ item: string; contractRequirement?: string; actualValue: string; status: string; }>;
}

// ─── Core request dispatcher ──────────────────────────────────────────────────

async function callAI(settings: AISettings, systemPrompt: string, userPrompt: string, media?: { base64: string; mimeType: string }): Promise<string> {
  const { provider, apiKey } = settings;

  if (provider === 'gemini') {
    const parts: any[] = [{ text: `${systemPrompt}\n\n${userPrompt}` }];
    if (media) parts.push({ inlineData: { data: media.base64, mimeType: media.mimeType } });
    const payload = {
      contents: [{ parts }],
      generationConfig: { temperature: 0.0, maxOutputTokens: 65536, responseMimeType: 'application/json' },
    };
    const res = await fetch('/api/gemini', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey, model: GEMINI_MODEL, payload }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || data.error || 'Gemini error');
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }

  if (provider === 'claude') {
    let userContent: any;
    if (media) {
      const parts: any[] = [];
      if (media.mimeType === 'application/pdf') {
        parts.push({ type: 'document', source: { type: 'base64', media_type: media.mimeType, data: media.base64 } });
      } else {
        parts.push({ type: 'image', source: { type: 'base64', media_type: media.mimeType, data: media.base64 } });
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
    const res = await fetch('/api/claude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey, payload }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || data.error || 'Claude error');
    return data.content?.[0]?.text || '';
  }

  if (provider === 'openai') {
    const userContent: any = media
      ? [
          { type: 'image_url', image_url: { url: `data:${media.mimeType};base64,${media.base64}` } },
          { type: 'text', text: userPrompt },
        ]
      : userPrompt;
    const payload = {
      model: 'gpt-4o',
      max_tokens: 8192,
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userContent }],
    };
    const res = await fetch('/api/openai/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey, payload }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || data.error || 'OpenAI error');
    return data.choices?.[0]?.message?.content || '';
  }

  throw new Error(`Proveedor desconocido: ${provider}`);
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

// ─── Financial statement extraction ──────────────────────────────────────────

export async function extractFinancials(
  settings: AISettings,
  content: string | { base64: string; mimeType: string },
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
  media?: { base64: string; mimeType: string }
): Promise<ContractExtractionResult> {
  const system = `Eres un abogado y analista de crédito experto en contratos de financiamiento IFNB mexicanos.
Extraes covenants financieros y condiciones de hacer/no hacer de contratos de crédito.
Devuelves únicamente JSON válido.`;

  const hasText = contractText.trim().length > 0;
  const docRef = media
    ? `el documento adjunto${hasText ? ' y el texto proporcionado' : ''}`
    : 'el siguiente contrato';

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
${hasText ? `\nTexto del contrato:\n${contractText.slice(0, 12000)}` : ''}`;

  const text = await callAI(settings, system, prompt, media);
  const parsed = extractJSON(text);
  return {
    condicionesHacer: Array.isArray(parsed.condicionesHacer) ? parsed.condicionesHacer : [],
    condicionesNoHacer: Array.isArray(parsed.condicionesNoHacer) ? parsed.condicionesNoHacer : [],
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

// ─── Test connection ──────────────────────────────────────────────────────────

export async function testConnection(settings: AISettings): Promise<string> {
  const text = await callAI(settings, 'Responde únicamente con: OK', 'Di "OK"');
  return text.trim();
}
