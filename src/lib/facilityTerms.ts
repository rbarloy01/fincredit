// Términos económicos de una facility (contrato): plazo, disposición mínima, plazo de pago, tasa ordinaria
// (fija o referencia + sobretasa, con piso / techo), moratoria y comisiones. Se capturan a mano o se llenan con la
// extracción del contrato; se guardan por cliente en client_settings (sin migración).

export const facilityTermsKey = (clientId: string) => `finmonitor_transaction_terms_${clientId}`;

export type RateType = 'fija' | 'variable';
export const RATE_REFERENCES = ['TIIE 28', 'TIIE 91', 'TIIE de fondeo', 'SOFR', 'CETES 28', 'Otra'] as const;

export interface FacilityFee { id: string; concepto: string; valor: string; base: string }

export interface FacilityTerms {
  plazoMeses: string;              // plazo total del crédito / línea
  disposicionMinima: string;       // monto mínimo por disposición
  plazoDisposicionMeses: string;   // plazo de pago de cada disposición
  periodicidadPago: string;        // mensual, trimestral, al vencimiento…
  tasaTipo: RateType;
  tasaFija: string;                // % anual (fija)
  referencia: string;              // TIIE 28, SOFR… (variable)
  referenciaValor: string;         // valor vigente de la referencia, % (para calcular la tasa efectiva)
  sobretasa: string;               // puntos porcentuales sobre la referencia
  piso: string;                    // % anual mínimo
  techo: string;                   // % anual máximo
  moratorioTexto: string;          // como lo dice el contrato ("2 veces la tasa ordinaria")
  moratorioFactor: string;         // veces la ordinaria
  moratorioTasa: string;           // % anual fijo, si aplica
  comisiones: FacilityFee[];
  notas: string;
  fuente: 'manual' | 'contrato';
  updatedAt: string;
}

export type FacilityTermsMap = Record<string, FacilityTerms>;

export const emptyFacilityTerms = (): FacilityTerms => ({
  plazoMeses: '', disposicionMinima: '', plazoDisposicionMeses: '', periodicidadPago: '',
  tasaTipo: 'fija', tasaFija: '', referencia: 'TIIE 28', referenciaValor: '', sobretasa: '', piso: '', techo: '',
  moratorioTexto: '', moratorioFactor: '', moratorioTasa: '', comisiones: [], notas: '', fuente: 'manual', updatedAt: '',
});

const num = (v: string | number | null | undefined): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[%\s,$]/g, ''));
  return Number.isFinite(n) ? n : null;
};

// Tasa ordinaria efectiva en % anual: fija, o referencia + sobretasa acotada por piso y techo. null si falta un dato.
export function effectiveRate(t: FacilityTerms): { rate: number | null; note: string } {
  if (t.tasaTipo === 'fija') {
    const r = num(t.tasaFija);
    return { rate: r, note: r === null ? 'Falta la tasa fija' : 'Tasa fija' };
  }
  const ref = num(t.referenciaValor); const spread = num(t.sobretasa) ?? 0;
  if (ref === null) return { rate: null, note: `Captura el valor vigente de ${t.referencia || 'la referencia'} para calcular la tasa` };
  let rate = ref + spread;
  const floor = num(t.piso); const cap = num(t.techo);
  let note = `${t.referencia} ${ref}% + ${spread} pp`;
  if (floor !== null && rate < floor) { rate = floor; note += ` → aplica piso ${floor}%`; }
  if (cap !== null && rate > cap) { rate = cap; note += ` → aplica techo ${cap}%`; }
  return { rate, note };
}

// Moratoria en % anual a partir de la ordinaria efectiva (factor) o de la tasa fija capturada.
export function effectiveDefaultRate(t: FacilityTerms): number | null {
  const fixed = num(t.moratorioTasa);
  if (fixed !== null) return fixed;
  const factor = num(t.moratorioFactor); const ord = effectiveRate(t).rate;
  return factor !== null && ord !== null ? ord * factor : null;
}

// Lo que extrae la IA del contrato, normalizado a FacilityTerms (los campos que no vengan se quedan vacíos).
export function termsFromExtraction(x: any): FacilityTerms {
  const t = emptyFacilityTerms();
  if (!x || typeof x !== 'object') return t;
  const s = (v: unknown) => (v === null || v === undefined ? '' : String(v).trim());
  t.plazoMeses = s(x.plazoMeses); t.disposicionMinima = s(x.disposicionMinima); t.plazoDisposicionMeses = s(x.plazoDisposicionMeses);
  t.periodicidadPago = s(x.periodicidadPago);
  t.tasaTipo = x.tasaTipo === 'variable' ? 'variable' : 'fija';
  t.tasaFija = s(x.tasaFija); t.referencia = s(x.referencia) || (t.tasaTipo === 'variable' ? 'TIIE 28' : ''); t.sobretasa = s(x.sobretasa);
  t.piso = s(x.piso); t.techo = s(x.techo);
  t.moratorioTexto = s(x.moratorioTexto); t.moratorioFactor = s(x.moratorioFactor); t.moratorioTasa = s(x.moratorioTasa);
  t.comisiones = Array.isArray(x.comisiones) ? x.comisiones.map((c: any, i: number) => ({ id: `c${i}-${Date.now()}`, concepto: s(c?.concepto), valor: s(c?.valor), base: s(c?.base) })).filter((c: FacilityFee) => c.concepto) : [];
  t.notas = s(x.notas);
  t.fuente = 'contrato';
  t.updatedAt = new Date().toISOString();
  return t;
}
