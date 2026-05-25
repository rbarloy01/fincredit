// Claude API service — calls /api/claude proxy (Vite dev server)
// No Anthropic SDK; uses raw fetch()

export interface RawLineItem {
  name: string;
  value: number;
  source?: string;
}

export interface MappedData {
  revenue: number;
  cogs: number;
  operatingExpenses: number;
  ebitda: number;
  interestExpense: number;
  netIncome: number;
  currentAssets: number;
  currentLiabilities: number;
  totalDebt: number;
  totalAssets: number;
  equity: number;
  [key: string]: number;
}

export interface ExtractionResult {
  period: string;
  periodDate: string;
  rawLineItems: RawLineItem[];
  mappedData: MappedData;
  extraAccounts: Array<{ key: string; label: string; value: number }>;
}

export interface FinancialCovenant {
  name: string;
  threshold: string;
  operator: 'gt' | 'lt' | 'gte' | 'lte' | 'none';
  description: string;
  formula?: string;
}

export interface ContractExtractionResult {
  condicionesHacer: string[];
  condicionesNoHacer: string[];
  covenants: FinancialCovenant[];
}

export interface LoanBucket {
  label: string;
  count: number;
  balance: number;
  pct: number;
}

export interface StructuredLoanTapeAnalysis {
  totalBalance: number;
  loanCount: number;
  avgLoanSize: number;
  weightedAvgRate: number;
  delinquency: {
    current: LoanBucket;
    d1_30: LoanBucket;
    d31_60: LoanBucket;
    d61_90: LoanBucket;
    d90plus: LoanBucket;
  };
  topConcentrations: Array<{ category: string; balance: number; pct: number }>;
  riskScore: number;
  riskStatus: 'good' | 'warning' | 'critical';
  narrative: string;
  trends: Array<{ metric: string; current: number; previous: number; trend: 'up' | 'down' | 'flat' }>;
}

async function callClaude(apiKey: string, messages: any[], systemPrompt: string): Promise<string> {
  const response = await fetch('/api/claude', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apiKey,
      payload: {
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        system: systemPrompt,
        messages,
      },
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  if (data.error) throw new Error(data.error.message || 'Claude API error');
  const content = data.content?.[0]?.text;
  if (!content) throw new Error('Respuesta vacía de Claude');
  return content;
}

function extractJson(text: string): any {
  // Try direct parse first
  try { return JSON.parse(text); } catch {}
  // Try to extract JSON from markdown code block
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (match) {
    try { return JSON.parse(match[1].trim()); } catch {}
  }
  // Try to find first { ... } block
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end !== -1) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch {}
  }
  throw new Error('No se pudo extraer JSON de la respuesta de Claude.');
}

export class ClaudeService {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async extractFinancials(
    content: string | { base64: string; mimeType: string },
    _covenantNames?: string[]
  ): Promise<ExtractionResult> {
    const systemPrompt = `Eres un experto contable especializado en instituciones financieras no bancarias (IFNB) mexicanas.
Tu tarea es extraer información financiera de documentos y estructurarla en JSON.
SIEMPRE responde ÚNICAMENTE con JSON válido, sin explicaciones adicionales.
El JSON debe seguir exactamente el esquema solicitado.`;

    const userText = `Analiza el siguiente estado financiero y extrae TODOS los rubros literales que encuentres.
Luego mapéalos a las cuentas estándar.

Devuelve un JSON con esta estructura EXACTA:
{
  "period": "string (ej: '1T2025', 'Dic 2024', 'Noviembre 2024')",
  "periodDate": "string ISO YYYY-MM-DD (último día del período)",
  "rawLineItems": [
    { "name": "nombre exacto del rubro", "value": numero_sin_formato }
  ],
  "mappedData": {
    "revenue": 0,
    "cogs": 0,
    "operatingExpenses": 0,
    "ebitda": 0,
    "interestExpense": 0,
    "netIncome": 0,
    "currentAssets": 0,
    "currentLiabilities": 0,
    "totalDebt": 0,
    "totalAssets": 0,
    "equity": 0
  },
  "extraAccounts": [
    { "key": "clave_unica", "label": "Nombre del rubro", "value": 0 }
  ]
}

Reglas:
- Incluye TODOS los rubros encontrados en rawLineItems (incluso si no mapean a cuentas estándar)
- Los valores deben ser números puros (sin comas ni símbolos de moneda)
- Si un valor está entre paréntesis, es negativo
- Para IFNB: "Cartera de Crédito Neta" puede ser revenue o currentAssets dependiendo del contexto
- "Margen Financiero" o "Margen de Intereses" suele ser revenue
- "Gastos de Administración" es operatingExpenses
- "Gastos por Intereses" o "Costo de Fondeo" es interestExpense
- EBITDA = revenue - cogs - operatingExpenses (calcula si no viene explícito)
- Si no encuentras un valor, usa 0
- extraAccounts: rubros que no tienen mapeo estándar pero son relevantes

Documento a analizar:`;

    let messages: any[];
    if (typeof content === 'string') {
      messages = [{ role: 'user', content: `${userText}\n\n${content}` }];
    } else {
      messages = [{
        role: 'user',
        content: [
          { type: 'text', text: userText },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: content.mimeType,
              data: content.base64,
            },
          },
        ],
      }];
    }

    const raw = await callClaude(this.apiKey, messages, systemPrompt);
    const parsed = extractJson(raw);

    // Ensure all mappedData keys exist
    const defaultMapped: MappedData = {
      revenue: 0, cogs: 0, operatingExpenses: 0, ebitda: 0,
      interestExpense: 0, netIncome: 0, currentAssets: 0,
      currentLiabilities: 0, totalDebt: 0, totalAssets: 0, equity: 0,
    };

    return {
      period: parsed.period || 'Sin período',
      periodDate: parsed.periodDate || new Date().toISOString().slice(0, 10),
      rawLineItems: parsed.rawLineItems || [],
      mappedData: { ...defaultMapped, ...(parsed.mappedData || {}) },
      extraAccounts: parsed.extraAccounts || [],
    };
  }

  async extractCovenants(contractText: string): Promise<ContractExtractionResult> {
    const systemPrompt = `Eres un abogado especializado en contratos de crédito mexicanos e instituciones financieras.
Extraes obligaciones y covenants de contratos de crédito.
SIEMPRE responde ÚNICAMENTE con JSON válido, sin texto adicional.`;

    const messages = [{
      role: 'user',
      content: `Analiza el siguiente contrato de crédito y extrae todas las obligaciones y covenants.

Devuelve un JSON con esta estructura EXACTA:
{
  "condicionesHacer": [
    "Descripción de obligación positiva (lo que el acreditado DEBE hacer)"
  ],
  "condicionesNoHacer": [
    "Descripción de restricción (lo que el acreditado NO puede hacer)"
  ],
  "covenants": [
    {
      "name": "Nombre del covenant financiero",
      "threshold": "valor umbral (ej: '2.5x', '30%', '1.0')",
      "operator": "gt|lt|gte|lte|none",
      "description": "descripción completa del covenant",
      "formula": "fórmula si aplica (ej: 'EBITDA / Deuda Total')"
    }
  ]
}

Reglas:
- condicionesHacer: obligaciones de hacer (mantener seguros, reportar estados financieros, etc.)
- condicionesNoHacer: restricciones (no contratar deuda adicional sin autorización, etc.)
- covenants: solo ratios y métricas financieras cuantificables
- operator: 'gt' (mayor que), 'lt' (menor que), 'gte' (mayor o igual), 'lte' (menor o igual), 'none' (no aplica)
- Si el contrato no tiene una sección específica, infiere de las cláusulas
- Escribe en español

Contrato:
${contractText.slice(0, 15000)}`,
    }];

    const raw = await callClaude(this.apiKey, messages, systemPrompt);
    const parsed = extractJson(raw);
    return {
      condicionesHacer: parsed.condicionesHacer || [],
      condicionesNoHacer: parsed.condicionesNoHacer || [],
      covenants: parsed.covenants || [],
    };
  }

  async analyzeLoanTape(tapeData: any[], previousData?: any[]): Promise<StructuredLoanTapeAnalysis> {
    const systemPrompt = `Eres un analista de riesgo de crédito especializado en carteras de IFNB mexicanas.
Analizas loan tapes y generas análisis estructurados de cartera.
SIEMPRE responde ÚNICAMENTE con JSON válido.`;

    const dataStr = JSON.stringify(tapeData.slice(0, 200));
    const prevStr = previousData ? JSON.stringify(previousData.slice(0, 200)) : null;

    const messages = [{
      role: 'user',
      content: `Analiza esta cartera de crédito y genera un análisis estructurado.

Datos de la cartera actual (muestra de registros):
${dataStr}

${prevStr ? `Datos del período anterior:\n${prevStr}\n` : ''}

Devuelve un JSON con esta estructura EXACTA:
{
  "totalBalance": 0,
  "loanCount": 0,
  "avgLoanSize": 0,
  "weightedAvgRate": 0,
  "delinquency": {
    "current": { "label": "Al corriente", "count": 0, "balance": 0, "pct": 0 },
    "d1_30": { "label": "1-30 días", "count": 0, "balance": 0, "pct": 0 },
    "d31_60": { "label": "31-60 días", "count": 0, "balance": 0, "pct": 0 },
    "d61_90": { "label": "61-90 días", "count": 0, "balance": 0, "pct": 0 },
    "d90plus": { "label": ">90 días", "count": 0, "balance": 0, "pct": 0 }
  },
  "topConcentrations": [
    { "category": "nombre", "balance": 0, "pct": 0 }
  ],
  "riskScore": 50,
  "riskStatus": "good|warning|critical",
  "narrative": "Análisis narrativo en español (2-3 párrafos)",
  "trends": [
    { "metric": "nombre métrica", "current": 0, "previous": 0, "trend": "up|down|flat" }
  ]
}

- pct: porcentaje de 0 a 100
- riskScore: 0 (mejor) a 100 (peor)
- riskStatus: good (<35), warning (35-65), critical (>65)
- topConcentrations: top 5 por sector, producto u otro criterio relevante`,
    }];

    const raw = await callClaude(this.apiKey, messages, systemPrompt);
    const parsed = extractJson(raw);
    return parsed as StructuredLoanTapeAnalysis;
  }

  async generateOpinion(clientName: string, metrics: any): Promise<string> {
    const systemPrompt = `Eres un analista de riesgo de crédito institucional.
Redactas opiniones de monitoreo para el comité de crédito de una institución financiera.
Escribe en español formal y conciso.
SIEMPRE responde con un JSON: { "opinion": "texto aquí" }`;

    const messages = [{
      role: 'user',
      content: `Redacta una opinión de monitoreo para el comité de crédito sobre el cliente "${clientName}".

Métricas actuales:
${JSON.stringify(metrics, null, 2)}

La opinión debe:
1. Resumir el estado financiero actual (2-3 oraciones)
2. Destacar cumplimiento de covenants principales
3. Identificar riesgos o alertas relevantes
4. Concluir con recomendación (Mantener / Vigilancia / Revisión urgente)

Extensión: 3-4 párrafos. Tono profesional e institucional.`,
    }];

    const raw = await callClaude(this.apiKey, messages, systemPrompt);
    const parsed = extractJson(raw);
    return parsed.opinion || raw;
  }

  parseMonitoreoExcel(buffer: ArrayBuffer): any {
    // Dynamically import xlsx to parse the buffer
    // Returns raw rows as array of objects
    try {
      const XLSX = (window as any).__XLSX__;
      if (!XLSX) return null;
      const workbook = XLSX.read(new Uint8Array(buffer), { type: 'array' });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });
      return rows;
    } catch (err) {
      console.error('Error parsing Excel:', err);
      return null;
    }
  }
}
