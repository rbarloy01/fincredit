import { GoogleGenAI, Type } from "@google/genai";
import { ExtractionResult, Company, FinancialStatement, ContractExtractionResult, LoanTapeSnapshot } from "../types";
import { AiSettings, DEFAULT_GEMINI_MODEL, loadAiSettings } from "../types/ai";
import * as XLSX from "xlsx";

// ─── Schemas ──────────────────────────────────────────────────────────────────

const extractionSchema = {
  type: Type.OBJECT,
  properties: {
    period: { type: Type.STRING, description: "The reporting period, e.g., FY2023 or Q2 2024." },
    data: {
      type: Type.OBJECT,
      properties: {
        revenue: { type: Type.NUMBER },
        cogs: { type: Type.NUMBER },
        operatingExpenses: { type: Type.NUMBER },
        ebitda: { type: Type.NUMBER },
        interestExpense: { type: Type.NUMBER },
        netIncome: { type: Type.NUMBER },
        currentAssets: { type: Type.NUMBER },
        currentLiabilities: { type: Type.NUMBER },
        totalDebt: { type: Type.NUMBER },
        totalAssets: { type: Type.NUMBER },
        equity: { type: Type.NUMBER },
      },
      required: [
        "revenue", "cogs", "operatingExpenses", "ebitda",
        "interestExpense", "netIncome", "currentAssets",
        "currentLiabilities", "totalDebt", "totalAssets", "equity"
      ]
    },
    rawLineItems: {
      type: Type.ARRAY,
      description: "Solo líneas contables explícitas de Balance General o Estado de Resultados. Omitir flujo de efectivo, covenants, razones, notas e indicadores auxiliares.",
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          value: { type: Type.NUMBER },
          source: { type: Type.STRING },
          statementType: { type: Type.STRING, enum: ["balance_general", "estado_resultados"] },
          sectionPath: { type: Type.STRING }
        },
        required: ["name", "value", "statementType"]
      }
    },
    mappingSuggestions: {
      type: Type.ARRAY,
      description: "Sugerencias de mapeo. El usuario debe aprobarlas antes del cálculo final.",
      items: {
        type: Type.OBJECT,
        properties: {
          rawName: { type: Type.STRING },
          suggestedAccount: { type: Type.STRING },
          reason: { type: Type.STRING }
        },
        required: ["rawName", "suggestedAccount"]
      }
    },
    covenantValues: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          value: { type: Type.STRING }
        },
        required: ["name", "value"]
      }
    }
  },
  required: ["period", "data"]
};

const contractSchema = {
  type: Type.OBJECT,
  properties: {
    condicionesHacer: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
    condicionesNoHacer: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
    covenants: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          threshold: { type: Type.STRING },
          description: { type: Type.STRING }
        },
        required: ["name", "threshold", "description"]
      }
    }
  },
  required: ["condicionesHacer", "condicionesNoHacer", "covenants"]
};

const loanTapeAnalysisSchema = {
  type: Type.OBJECT,
  properties: {
    overallStatus: { type: Type.STRING },
    riskScore: { type: Type.NUMBER },
    executiveSummary: { type: Type.STRING },
    trendDirection: { type: Type.STRING },
    metrics: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          latestValue: { type: Type.STRING },
          previousValue: { type: Type.STRING },
          change: { type: Type.STRING },
          trend: { type: Type.STRING },
          status: { type: Type.STRING },
          contractLimit: { type: Type.STRING },
          congruent: { type: Type.BOOLEAN }
        },
        required: ["name", "latestValue", "trend", "status", "congruent"]
      }
    },
    findings: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          severity: { type: Type.STRING },
          category: { type: Type.STRING },
          title: { type: Type.STRING },
          detail: { type: Type.STRING },
          recommendation: { type: Type.STRING }
        },
        required: ["severity", "category", "title", "detail"]
      }
    },
    congruencyChecks: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          item: { type: Type.STRING },
          contractRequirement: { type: Type.STRING },
          actualValue: { type: Type.STRING },
          status: { type: Type.STRING }
        },
        required: ["item", "actualValue", "status"]
      }
    }
  },
  required: ["overallStatus", "riskScore", "executiveSummary", "trendDirection", "metrics", "findings", "congruencyChecks"]
};

// ─── Public Types ─────────────────────────────────────────────────────────────

export interface MonitoreoCovenantRow {
  covenantName: string;
  values: Record<string, string>;
}

export interface MonitoreoExtraction {
  periods: string[];
  rows: MonitoreoCovenantRow[];
}

export interface LoanTapeMetric {
  name: string;
  latestValue: string;
  previousValue?: string;
  change?: string;
  trend: 'up' | 'down' | 'stable';
  status: 'good' | 'warning' | 'critical';
  contractLimit?: string;
  congruent: boolean;
}

export interface LoanTapeFinding {
  severity: 'critical' | 'warning' | 'info';
  category: string;
  title: string;
  detail: string;
  recommendation?: string;
}

export interface CongruencyCheck {
  item: string;
  contractRequirement?: string;
  actualValue: string;
  status: 'pass' | 'fail' | 'warning' | 'unknown';
}

export interface StructuredLoanTapeAnalysis {
  overallStatus: 'CUMPLE' | 'ALERTA' | 'INCUMPLIMIENTO';
  riskScore: number;
  executiveSummary: string;
  trendDirection: 'MEJORA' | 'ESTABLE' | 'DETERIORO';
  metrics: LoanTapeMetric[];
  findings: LoanTapeFinding[];
  congruencyChecks: CongruencyCheck[];
  generatedAt: string;
}

// ─── Shared contract prompt ───────────────────────────────────────────────────

const CONTRACT_EXTRACTION_INSTRUCTIONS = `Eres un experto legal en contratos de crédito corporativo mexicano (Créditos Simples, Créditos Revolventes) con 20 años de experiencia. 
Tu tarea es extraer EXHAUSTIVAMENTE y SIN OMITIR NADA las siguientes tres categorías del documento. 
Es CRÍTICO que no pierdas ninguna obligación — los analistas dependen de este extracto para el monitoreo de cumplimiento.

CATEGORÍA 1 — OBLIGACIONES DE HACER (Affirmative Covenants)
Son compromisos POSITIVOS que el acreditado SE OBLIGA a realizar, mantener o permitir.
Busca variantes: "El Acreditado se obliga a", "El Deudor deberá", "Obligaciones de Hacer", "Compromisos Afirmativos", "Affirmative Covenants", "Condiciones Afirmativas", "El Fideicomitente deberá", "La Empresa se compromete a", "Mantenimiento de".
Verbos clave: Mantener, Conservar, Entregar, Proporcionar, Notificar, Informar, Permitir, Presentar, Celebrar, Contratar, Obtener, Asegurar, Cumplir, Pagar.
REGLAS: Extrae CADA sub-inciso (a), (b), (c), (i), (ii) como elemento SEPARADO con texto COMPLETO. Incluye referencia de cláusula si está disponible (ej. "Cláusula Décima: Mantener...").

CATEGORÍA 2 — OBLIGACIONES DE NO HACER (Negative Covenants)
Son RESTRICCIONES — cosas que el acreditado NO puede hacer sin autorización.
Busca variantes: "El Acreditado no podrá", "Obligaciones de No Hacer", "Queda prohibido", "Negative Covenants", "Restricciones", "Compromisos Negativos", "El Deudor se abstendrá de", "Sin el previo consentimiento", "No podrá llevar a cabo", "Se prohíbe", "No deberá".
Verbos negados: No vender, No gravar, No fusionarse, No distribuir dividendos, No modificar estatutos, No contratar deuda adicional.
REGLAS: mismas que Categoría 1.

CATEGORÍA 3 — COVENANTS FINANCIEROS
Métricas financieras con umbrales numéricos específicos.
Busca: "Razones Financieras", "Covenants Financieros", "Índices Financieros", "Niveles de Mantenimiento", "Financial Covenants", "Pruebas Financieras", "Cobertura de Intereses", "Apalancamiento".
Para cada uno: nombre corto, umbral exacto con operador (ej. "≤ 3.5x"), descripción de cálculo.

INSTRUCCIONES FINALES:
- Recorre el documento COMPLETO incluyendo TODOS los anexos, apéndices y exhibiciones.
- Si no hay elementos en alguna categoría, devuelve [].
- NO inventes ni inferas — solo extrae lo explícito.
- NO combines múltiples obligaciones en un solo elemento.
- Si encuentras tablas de covenants, léeleas con cuidado.`;

// ─── Helper ───────────────────────────────────────────────────────────────────

function cellStr(val: unknown): string {
  if (val === null || val === undefined) return '';
  return String(val).trim();
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class GeminiService {
  private ai: GoogleGenAI;
  private settings: AiSettings;
  private model: string;

  constructor(settings?: AiSettings) {
    this.settings = settings || loadAiSettings();
    this.model = this.normalizeModel(this.settings.model);
    this.ai = new GoogleGenAI({ apiKey: this.settings.geminiApiKey || process.env.API_KEY || process.env.GEMINI_API_KEY || '' });
  }

  private normalizeModel(model?: string): string {
    if (this.settings.provider === 'gemini') {
      if (!model || model.includes('preview') || model.startsWith('gemini-3')) return DEFAULT_GEMINI_MODEL;
      return model;
    }
    return model || '';
  }

  private async generateContent(request: any): Promise<{ text?: string }> {
    const payload = { ...request, model: this.model || request.model };

    if (this.settings.provider === 'openai') {
      return this.generateOpenAiContent(payload);
    }

    if (this.settings.provider === 'custom') {
      if (!this.settings.customEndpoint) {
        throw new Error('AI_ENDPOINT no configurado.');
      }
      const response = await fetch(this.settings.customEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: this.settings.provider, model: this.model, request: payload }),
      });
      if (!response.ok) throw new Error(`AI endpoint error ${response.status}`);
      const json = await response.json();
      return { text: json.text || json.output || JSON.stringify(json) };
    }

    return this.generateGeminiContent(payload);
  }

  private async generateGeminiContent(request: any): Promise<{ text?: string }> {
    if (!this.settings.geminiApiKey && !process.env.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY no configurado.');
    }

    const response = await fetch('/api/gemini', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey: this.settings.geminiApiKey,
        model: this.model || DEFAULT_GEMINI_MODEL,
        payload: {
          contents: Array.isArray(request.contents) ? request.contents : [{ role: 'user', parts: this.toGeminiParts(request.contents) }],
          generationConfig: request.config ? {
            responseMimeType: request.config.responseMimeType,
            responseSchema: request.config.responseSchema,
          } : undefined,
        },
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Gemini error ${response.status}: ${detail}`);
    }

    const json = await response.json();
    return { text: json.candidates?.[0]?.content?.parts?.map((part: any) => part.text || '').join('') || json.text || '' };
  }

  private toGeminiParts(contents: any): any[] {
    if (typeof contents === 'string') return [{ text: contents }];
    if (Array.isArray(contents?.parts)) return contents.parts;
    return [{ text: JSON.stringify(contents) }];
  }

  private async generateOpenAiContent(request: any): Promise<{ text?: string }> {
    if (!this.settings.openaiApiKey) {
      throw new Error('OPENAI_API_KEY no configurado.');
    }

    const response = await fetch('/api/openai/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey: this.settings.openaiApiKey,
        payload: {
          model: this.model || 'gpt-5',
          input: this.toOpenAiInput(request.contents),
          instructions: this.schemaInstruction(request.config?.responseSchema),
        },
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`OpenAI error ${response.status}: ${detail}`);
    }

    const json = await response.json();
    return { text: json.output_text || this.extractOpenAiOutputText(json) };
  }

  private toOpenAiInput(contents: any): any {
    if (typeof contents === 'string') return contents;
    const parts = contents?.parts;
    if (!Array.isArray(parts)) return JSON.stringify(contents);

    return [{
      role: 'user',
      content: parts.map((part: any) => {
        if (part.text) return { type: 'input_text', text: part.text };
        if (part.inlineData) {
          return {
            type: 'input_image',
            image_url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`,
          };
        }
        return { type: 'input_text', text: JSON.stringify(part) };
      }),
    }];
  }

  private schemaInstruction(schema?: unknown): string {
    if (!schema) return 'Return valid JSON only when the user asks for JSON.';
    return `Return valid JSON only. Match this schema as closely as possible without inventing facts: ${JSON.stringify(schema)}`;
  }

  private extractOpenAiOutputText(json: any): string {
    const output = Array.isArray(json.output) ? json.output : [];
    for (const item of output) {
      const content = Array.isArray(item.content) ? item.content : [];
      const text = content.find((c: any) => c.type === 'output_text')?.text;
      if (text) return text;
    }
    return JSON.stringify(json);
  }

  private sanitizeFinancialExtraction(parsed: any): ExtractionResult {
    const allowed = new Set(['balance_general', 'estado_resultados']);
    const rawLineItems = (parsed.rawLineItems || [])
      .filter((item: any) => allowed.has(item.statementType || item.type))
      .map((item: any) => ({
        ...item,
        name: String(item.name || '').trim(),
        value: Number(item.value),
        statementType: item.statementType || item.type,
        sectionPath: item.sectionPath || null,
      }))
      .filter((item: any) => item.name && Number.isFinite(item.value));

    return {
      ...parsed,
      rawLineItems,
      mappingSuggestions: [],
      covenantValues: [],
    } as ExtractionResult;
  }

  // ── Financial / PDF extraction ────────────────────────────────────────────

  async extractFromImage(base64Data: string, mimeType: string, covenantsToMatch?: string[]): Promise<ExtractionResult> {
    const response = await this.generateContent({
      model: 'gemini-3-flash-preview',
      contents: {
        parts: [
          { inlineData: { data: base64Data, mimeType } },
          {
            text: `Eres un extractor financiero experto en estados financieros mexicanos (PCGA y NIIF).

TAREA: Extrae con MÁXIMA PRECISIÓN solo Balance General y Estado de Resultados.

INSTRUCCIONES:
1. Identifica el período: usa "MMM-YY" para meses (ej. "Nov-24"), "QN YYYY" para trimestres, "FY YYYY" para años.
2. Extrae valores numéricos en su unidad original. Infiere la escala (pesos, miles, millones) del encabezado del documento.
3. Si un valor no aparece, devuelve 0. NO estimes.
4. Devuelve rawLineItems únicamente con cuentas explícitas de Balance General o Estado de Resultados, tal como aparecen.
5. Cada rawLineItem debe tener statementType: "balance_general" o "estado_resultados".
6. Omite flujo de efectivo, covenants, razones financieras, KPIs, notas, comentarios, contratos, aging operativo, reportes de monitoreo y cualquier tabla auxiliar.
7. No generes mappingSuggestions ni covenantValues.
8. Busca en TODAS las páginas y tablas del documento, pero solo conserva Balance General y Estado de Resultados.

Devuelve JSON válido.`
          }
        ],
      },
      config: { responseMimeType: "application/json", responseSchema: extractionSchema },
    });
    return this.sanitizeFinancialExtraction(JSON.parse(response.text || '{}'));
  }

  async extractFromText(text: string, covenantsToMatch?: string[]): Promise<ExtractionResult> {
    const response = await this.generateContent({
      model: 'gemini-3-flash-preview',
      contents: `Eres un extractor financiero experto. Extrae solo cuentas explícitas de Balance General y Estado de Resultados con máxima precisión. No inventes valores. Omite flujo de efectivo, covenants, razones financieras, KPIs, notas, contratos, reportes de monitoreo y tablas auxiliares. Devuelve rawLineItems solo con statementType "balance_general" o "estado_resultados". No generes mappingSuggestions ni covenantValues. Si una clave estándar no aparece usa 0.\n\nTEXTO:\n${text}`,
      config: { responseMimeType: "application/json", responseSchema: extractionSchema },
    });
    return this.sanitizeFinancialExtraction(JSON.parse(response.text || '{}'));
  }

  // ── Contract extraction ───────────────────────────────────────────────────

  async extractContractData(base64Data: string, mimeType: string): Promise<ContractExtractionResult> {
    const response = await this.generateContent({
      model: 'gemini-3-flash-preview',
      contents: {
        parts: [
          { inlineData: { data: base64Data, mimeType } },
          { text: CONTRACT_EXTRACTION_INSTRUCTIONS }
        ],
      },
      config: { responseMimeType: "application/json", responseSchema: contractSchema },
    });
    const result = JSON.parse(response.text || '{}');
    return {
      condicionesHacer: result.condicionesHacer || [],
      condicionesNoHacer: result.condicionesNoHacer || [],
      covenants: result.covenants || []
    };
  }

  async extractContractFromText(text: string): Promise<ContractExtractionResult> {
    const response = await this.generateContent({
      model: 'gemini-3-flash-preview',
      contents: `${CONTRACT_EXTRACTION_INSTRUCTIONS}\n\nTEXTO DEL CONTRATO:\n${text}`,
      config: { responseMimeType: "application/json", responseSchema: contractSchema },
    });
    const result = JSON.parse(response.text || '{}');
    return {
      condicionesHacer: result.condicionesHacer || [],
      condicionesNoHacer: result.condicionesNoHacer || [],
      covenants: result.covenants || []
    };
  }

  // ── Suggestions ───────────────────────────────────────────────────────────

  async suggestConditions(industry: string, type: 'hacer' | 'no hacer'): Promise<string[]> {
    const response = await this.generateContent({
      model: 'gemini-3-flash-preview',
      contents: `Suggest 5 standard commercial loan obligations (obligaciones de ${type}) for a company in the ${industry} industry. Return only a JSON array of strings.`,
      config: { responseMimeType: "application/json", responseSchema: { type: Type.ARRAY, items: { type: Type.STRING } } },
    });
    return JSON.parse(response.text || '[]') as string[];
  }

  async suggestCovenants(industry: string): Promise<ContractExtractionResult['covenants']> {
    const response = await this.generateContent({
      model: 'gemini-3-flash-preview',
      contents: `Suggest 3 standard financial covenants for a company in the ${industry} industry. Include name, threshold (e.g. > 1.5x), and a brief description.`,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              name: { type: Type.STRING },
              threshold: { type: Type.STRING },
              description: { type: Type.STRING }
            },
            required: ["name", "threshold", "description"]
          }
        }
      },
    });
    return JSON.parse(response.text || '[]') as ContractExtractionResult['covenants'];
  }

  // ── Opinion ───────────────────────────────────────────────────────────────

  async generateOpinion(company: Company, statement: FinancialStatement): Promise<string> {
    const manualCovenants = company.manualCovenantData
      .filter(d => d.month === statement.period)
      .map(d => {
        const cov = company.covenants.find(c => c.id === d.covenantId);
        return `${cov?.name}: ${d.value} (${d.status === 'good' ? 'CUMPLE' : d.status === 'warning' ? 'ALERTA' : 'NO CUMPLE'})`;
      }).join(', ');
    const paymentStatus = company.paymentHistory.find(p => p.month === statement.period);
    const payments = paymentStatus ? `Principal: ${paymentStatus.principalStatus}, Intereses: ${paymentStatus.interestStatus}` : 'No disponible';
    const nonCompliantDocs = company.documentation.filter(d => !d.isCompliant).map(d => d.name).join(', ');
    const nonCompliantHacer = company.condicionesHacer.filter(d => !d.isCompliant).map(d => d.name).join(', ');
    const nonCompliantNoHacer = company.condicionesNoHacer.filter(d => !d.isCompliant).map(d => d.name).join(', ');
    const aforoActual = company.aforoHistory[company.aforoHistory.length - 1];
    const aforoStatus = aforoActual ? `${aforoActual.value} (${aforoActual.status === 'good' ? 'CUMPLE' : aforoActual.status === 'warning' ? 'ALERTA' : 'NO CUMPLE'})` : 'No disponible';

    const response = await this.generateContent({
      model: 'gemini-3-flash-preview',
      contents: `Actúa como Analista Senior de Riesgo. Escribe resumen profesional del monitoreo de "${company.name}" en ESPAÑOL. Tono ejecutivo, directo. Empieza con saludo formal.

DATOS (Periodo ${statement.period}):
- Exposición: $${company.currentDue.toLocaleString()} de $${company.totalCreditValue.toLocaleString()}
- Pagos: ${payments} | Atraso: ${company.delinquencyDays}d | Meses atraso 12m: ${company.delinquencyMonths12}
- Aforo req. ${company.aforoRequerido}: ${aforoStatus}
- Covenants: ${manualCovenants || 'Sin registros'}
- Doc incumplida: ${nonCompliantDocs || 'Al corriente'}
- Condiciones incumplidas: ${[nonCompliantHacer, nonCompliantNoHacer].filter(Boolean).join(', ') || 'Todas cumplen'}
- Apalancamiento: ${(statement.data.totalDebt / (statement.data.ebitda || 1)).toFixed(2)}x
- DSCR: ${(statement.data.ebitda / (statement.data.interestExpense || 1)).toFixed(2)}x`,
    });
    return response.text || "Resumen de análisis no disponible.";
  }

  // ── Loan Tape ─────────────────────────────────────────────────────────────

  async extractTapeSummary(dataSummaryText: string): Promise<Partial<LoanTapeSnapshot>> {
    const tapeSchema = {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING }, date: { type: Type.STRING },
        totalPoolBalance: { type: Type.NUMBER }, loanCount: { type: Type.NUMBER },
        avgBalance: { type: Type.NUMBER }, avgApr: { type: Type.NUMBER },
        weightedAvgLife: { type: Type.NUMBER }, delinquency30Plus: { type: Type.NUMBER },
        delinquency60Plus: { type: Type.NUMBER }, delinquency90Plus: { type: Type.NUMBER }
      },
      required: ["totalPoolBalance", "loanCount", "avgApr"]
    };
    const response = await this.generateContent({
      model: 'gemini-3-flash-preview',
      contents: `Analiza este Loan Tape y extrae métricas clave:\n\n${dataSummaryText}`,
      config: { responseMimeType: "application/json", responseSchema: tapeSchema },
    });
    return JSON.parse(response.text || '{}');
  }

  /**
   * Structured loan tape analysis — returns rich analytical JSON.
   * Replaces the old plain-text analyzeLoanTapeCongruency.
   */
  async analyzeLoanTapeStructured(
    snapshots: LoanTapeSnapshot[],
    contractSummary: string,
    monitoreoRows?: MonitoreoCovenantRow[]
  ): Promise<StructuredLoanTapeAnalysis> {
    const snapshotsData = snapshots.map(s => ({
      periodo: s.name,
      fecha: s.date,
      saldo_cartera: s.totalPoolBalance,
      num_creditos: s.loanCount,
      saldo_promedio: s.avgBalance,
      apr_promedio: s.avgApr,
      mora_30_plus: s.delinquency30Plus,
      mora_60_plus: s.delinquency60Plus,
      mora_90_plus: s.delinquency90Plus,
    }));

    const monitoreoSection = monitoreoRows && monitoreoRows.length > 0
      ? `\n\nCOVENANTS DEL EXCEL MONITOREO:\n${monitoreoRows.map(r =>
          `• ${r.covenantName}: ${Object.entries(r.values).map(([k, v]) => `${k}=${v}`).join(', ')}`
        ).join('\n')}`
      : "";

    const response = await this.generateContent({
      model: 'gemini-3-flash-preview',
      contents: `Eres un Auditor de Riesgos Senior en estructuras de crédito y loan tapes.

TÉRMINOS DEL CONTRATO:
${contractSummary}

SNAPSHOTS DE LOAN TAPE (cronológicos):
${JSON.stringify(snapshotsData, null, 2)}
${monitoreoSection}

INSTRUCCIONES:
1. MÉTRICAS: Para cada métrica (Pool Balance, Loan Count, APR Promedio, Mora 30+, Mora 60+, Mora 90+):
   - latestValue y previousValue si hay múltiples períodos
   - change: delta entre períodos con signo y unidad
   - trend: 'up'=sube, 'down'=baja, 'stable'=<2% cambio
   - status: 'good'=dentro parámetros, 'warning'=cerca del límite, 'critical'=supera umbral
   - NOTA: Para Pool Balance y Loan Count, subir es positivo. Para mora, subir es negativo.
   - congruent: ¿dentro de límites contractuales?
2. HALLAZGOS: 3-6 hallazgos específicos con evidencia numérica. Prioriza incumplimientos (critical), tendencias de deterioro (warning), mejoras (info).
3. CONGRUENCIA: Verifica cada requisito contractual vs datos del loan tape.
4. RESUMEN: 1-2 oraciones para un comité de crédito.
5. RIESGO: Score 0-100.`,
      config: { responseMimeType: "application/json", responseSchema: loanTapeAnalysisSchema },
    });

    const raw = JSON.parse(response.text || '{}');
    return { ...raw, generatedAt: new Date().toISOString() } as StructuredLoanTapeAnalysis;
  }

  // ── Monitoreo Excel Parser ────────────────────────────────────────────────

  parseMonitoreoExcel(fileArrayBuffer: ArrayBuffer): MonitoreoExtraction {
    const wb = XLSX.read(fileArrayBuffer, { type: 'array', cellDates: false });
    const sheetName = wb.SheetNames.find(n => n.toLowerCase().includes('monitoreo')) ?? wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];
    if (!ws) throw new Error(`No se encontró la hoja "Monitoreo" en el archivo.`);

    const raw: unknown[][] = XLSX.utils.sheet_to_json(ws, {
      header: 1, defval: '', blankrows: false,
    }) as unknown[][];

    if (raw.length < 2) throw new Error('La hoja Monitoreo está vacía.');

    const looksLikePeriod = (value: string) =>
      /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|ene|abr|ago|dic)[-\s]?\d{2,4}$/i.test(value);

    const blockRows: MonitoreoCovenantRow[] = [];
    const allPeriods = new Set<string>();
    let currentMetric = '';

    for (let r = 0; r < raw.length; r++) {
      const row = raw[r].map(cellStr);
      const nonEmpty = row.filter(Boolean);
      if (nonEmpty.length === 0) continue;

      const periodCols = row
        .map((label, idx) => ({ label, idx }))
        .filter(col => looksLikePeriod(col.label));

      if (periodCols.length >= 2) {
        for (let rr = r + 1; rr < raw.length; rr++) {
          const dataRow = raw[rr].map(cellStr);
          const label = dataRow[0] || dataRow[1];
          const hasValues = periodCols.some(col => dataRow[col.idx]);
          const nextPeriods = dataRow.filter(looksLikePeriod).length >= 2;
          if (!label && !hasValues) break;
          if (nextPeriods) break;
          if (hasValues && label) {
            const values: Record<string, string> = {};
            for (const { idx, label: period } of periodCols) {
              values[period] = dataRow[idx] || '';
              allPeriods.add(period);
            }
            blockRows.push({
              covenantName: currentMetric ? `${currentMetric} - ${label}` : label,
              values,
            });
          }
        }
        continue;
      }

      if (nonEmpty.length <= 2) {
        currentMetric = nonEmpty.join(' ').replace(/^#REF!\s*/i, '').trim();
      }
    }

    if (blockRows.length > 0) {
      return { periods: Array.from(allPeriods), rows: blockRows };
    }

    let headerRowIdx = 0;
    for (let r = 0; r < Math.min(10, raw.length); r++) {
      if (raw[r].filter(c => cellStr(c) !== '').length >= 2) { headerRowIdx = r; break; }
    }

    const headerRow = raw[headerRowIdx];
    let nameColIdx = 0;
    const col0IsIndex = raw.slice(headerRowIdx + 1, headerRowIdx + 6)
      .map(r => cellStr(r[0])).every(v => v === '' || /^\d+$/.test(v));
    if (col0IsIndex && headerRow.length > 1) nameColIdx = 1;

    const periodCols: { idx: number; label: string }[] = [];
    for (let c = nameColIdx + 1; c < headerRow.length; c++) {
      const label = cellStr(headerRow[c]);
      if (label) periodCols.push({ idx: c, label });
    }
    if (periodCols.length === 0) throw new Error('No se encontraron columnas de período.');

    const rows: MonitoreoCovenantRow[] = [];
    for (let r = headerRowIdx + 1; r < raw.length; r++) {
      const covenantName = cellStr(raw[r][nameColIdx]);
      if (!covenantName) continue;
      const values: Record<string, string> = {};
      for (const { idx, label } of periodCols) values[label] = cellStr(raw[r][idx]);
      rows.push({ covenantName, values });
    }

    return { periods: periodCols.map(p => p.label), rows };
  }
}
