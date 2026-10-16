// Vida de una facility: estatus de cada disposición, uso de la línea (revolvente vs simple) y ventana de vigencia.
//
// Reglas:
//  R1. Cada disposición es vigente, pagada o terminada. Si no tiene estatus capturado, se infiere de la nota
//      ("Pagado", "Liquidada" → pagada; "Terminada", "Cancelada" → terminada); si no, vigente.
//  R2. Línea REVOLVENTE (revolvente, factoraje, flex, cuenta corriente): lo dispuesto se libera al pagarse.
//        saldo vigente = Σ disposiciones vigentes;  disponible = autorizado − saldo vigente.
//      La suma histórica de disposiciones puede superar el autorizado sin ser un exceso.
//  R3. Línea SIMPLE: cada disposición consume la línea para siempre.
//        disponible = autorizado − Σ todas las disposiciones;  saldo vigente = Σ disposiciones vigentes.
//  R4. Vigencia: inicio = primera fecha entre firma, disposición inicial y disposiciones.
//      Fin = el último vencimiento (contrato o disposiciones) o, si se terminó, la última fecha de cierre/vencimiento.
//      Terminada = etapa "Terminado" en el pipeline de la facility.
//  R5. Los covenants de una facility se miden con los estados financieros cuyo corte cae dentro de su vigencia
//      (del mes de inicio al mes de fin). Una facility ya terminada se "remonta" a esos periodos.

import { parseFinancialNumber } from './numberParsing';

export type DispositionStatus = 'vigente' | 'pagada' | 'terminada';

export interface FacilityDisposition {
  id: string;
  date: string;
  maturityDate?: string;
  amount: string;
  currency: string;
  notes: string;
  status?: DispositionStatus;
  closedAt?: string;          // fecha en que se pagó / terminó
}

export interface FacilityLike {
  creditType?: string;
  originalAmount?: number;
  signedAt?: string;
  date?: string;
  maturityAt?: string;
}

const norm = (s: unknown) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

export const DISPOSITION_STATUS_LABEL: Record<DispositionStatus, string> = { vigente: 'Vigente', pagada: 'Pagada', terminada: 'Terminada' };

export function dispositionStatus(d: Pick<FacilityDisposition, 'status' | 'notes'>): DispositionStatus {
  if (d.status) return d.status;
  const n = norm(d.notes);
  if (/pagad|liquidad|amortizad|cubiert/.test(n)) return 'pagada';
  if (/terminad|cancelad|cerrad/.test(n)) return 'terminada';
  return 'vigente';
}

export const isRevolvingFacility = (creditType?: string) => /revolv|factoraje|flex|cuenta corriente/.test(norm(creditType));

export interface FacilityUsage {
  revolving: boolean;
  authorized: number;
  disbursedTotal: number;     // Σ histórica de disposiciones
  outstanding: number;        // Σ disposiciones vigentes
  available: number;          // lo que aún se puede disponer
  utilization: number | null; // saldo vigente ÷ autorizado
  openCount: number;
  closedCount: number;
  overAuthorized: boolean;    // exceso real sobre la línea
}

export function facilityUsage(tx: FacilityLike, items: FacilityDisposition[]): FacilityUsage {
  const revolving = isRevolvingFacility(tx.creditType);
  const authorized = tx.originalAmount || 0;
  const amt = (d: FacilityDisposition) => parseFinancialNumber(d.amount) || 0;
  const open = items.filter(d => dispositionStatus(d) === 'vigente');
  const disbursedTotal = items.reduce((s, d) => s + amt(d), 0);
  const outstanding = open.reduce((s, d) => s + amt(d), 0);
  const used = revolving ? outstanding : disbursedTotal;
  return {
    revolving,
    authorized,
    disbursedTotal,
    outstanding,
    available: Math.max(0, authorized - used),
    utilization: authorized > 0 ? outstanding / authorized : null,
    openCount: open.length,
    closedCount: items.length - open.length,
    overAuthorized: authorized > 0 && used > authorized + 0.5,
  };
}

export type FacilityLifeStatus = 'vigente' | 'vencida' | 'terminada' | 'sin-fecha';

export interface FacilityLife {
  start: string | null;
  end: string | null;
  status: FacilityLifeStatus;
  terminated: boolean;
}

export function facilityLife(tx: FacilityLike, items: FacilityDisposition[], pipelineStage?: string, today = new Date().toISOString().slice(0, 10)): FacilityLife {
  const valid = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}/.test(s);
  const starts = [tx.signedAt, tx.date, ...items.map(d => d.date)].filter(valid) as string[];
  const start = starts.sort()[0] || null;
  const terminated = norm(pipelineStage) === 'terminado';
  const ends = [tx.maturityAt, ...items.map(d => d.maturityDate), ...(terminated ? items.map(d => d.closedAt) : [])].filter(valid) as string[];
  const end = ends.sort().at(-1)?.slice(0, 10) || null;
  const status: FacilityLifeStatus = terminated ? 'terminada' : !end ? 'sin-fecha' : end < today ? 'vencida' : 'vigente';
  return { start: start?.slice(0, 10) || null, end, status, terminated };
}

const monthStart = (d: string) => `${d.slice(0, 7)}-01`;
const monthEnd = (d: string) => { const [y, m] = d.slice(0, 7).split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };

// Estados cuyo corte cae dentro de la vigencia (mes de inicio … mes de fin). Una facility vigente no tiene tope.
export function statementsDuringLife<T extends { periodDate: string }>(statements: T[], life: Pick<FacilityLife, 'start' | 'end' | 'status'>): T[] {
  const from = life.start ? monthStart(life.start) : null;
  const to = life.end && life.status !== 'vigente' && life.status !== 'sin-fecha' ? monthEnd(life.end) : null;
  return statements.filter(s => (!from || s.periodDate >= from) && (!to || s.periodDate <= to));
}
