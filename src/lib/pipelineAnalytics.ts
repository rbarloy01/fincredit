// Replicates the KPIs from the team's external "UWBR" / "Dashboard Ejecutivo" sheet
// natively in FinMonitor, computed from real client + CRM activity data instead of
// a manually maintained spreadsheet snapshot.
import { Client, CrmActivity } from '../db/index';
import { LineMovement, computeLineBalance } from './lineLedger';
import { isClientMonitored } from './clientStatus';
import { CRM_STAGES, CrmStage, currentStage, isOpenDealStage } from './crmPipeline';

// Probability of close per stage, as configured by the team (Configuración!L:M).
export const STAGE_PROBABILITY: Record<CrmStage, number> = {
  '1. Contacto': 0.15,
  '2. Term Sheet': 0.35,
  '3. Checklist': 0.5,
  '4. Análisis': 0.6,
  '5. Due Diligence': 0.8,
  '6. Contrato': 0.95,
  '7. Disposición': 1,
  Monitoring: 1,
  Dormant: 0,
  Terminado: 0,
};

export interface UnderwritingMeta {
  folio: string;
  monto: number | null;
  montoAjustado: number | null;
  categoria: string;
  prioridad: string;
  etapaActual: string;
  diasEnEtapa: number | null;
  probCierre: string;
  primerContacto: string;
  fechaEstComite: string; // ISO date, o '' si no hay fecha propuesta
  analista: string;
  ultimaActualizacion: string;
  motivoRetraso: string;
  estatus: string;
}

export interface MonitoringLineMeta {
  contrato: string;
  monto: number | null;
  saldoActual: number | null;
  pctUtilizacion: number | null;
  concentracionPortafolio: number | null;
  estatus: string;
  analista: string;
  ultimaActualizacion: string;
  movimientos?: LineMovement[];
}

export interface HistorialMeta {
  folio: string;
  monto: number | null;
  categoria: string;
  prioridad: string;
  etapaDondeQuedo: string;
  diasEnProceso: number | null;
  analista: string;
  resultado: string;
  motivo: string;
  reactivable: string;
  fechaEstimadaReactivacion: string;
  dealVelocityDias: number | null;
}

export interface MasterOrgPipelineMeta {
  underwriting: UnderwritingMeta | null;
  monitoring: MonitoringLineMeta[];
  // Un cliente puede tener más de un desenlace histórico (ej. rechazado una vez,
  // aprobado en un reingreso posterior) — una lista evita perder esos casos.
  historial: HistorialMeta[];
}

export interface StageCycleTime {
  stage: CrmStage;
  avgDays: number;
  minDays: number;
  maxDays: number;
  n: number;
}

export interface PipelineSummary {
  underwriting: {
    montoTotal: number;
    montoAjustado: number;
    deals: number;
    nuevosProspectosTrimestre: number;
    porCategoria: { categoria: string; count: number; monto: number }[];
    porEtapa: { stage: CrmStage; count: number; monto: number }[];
  };
  monitoring: {
    saldoVigente: number;
    montoOriginal: number;
    creditosActivos: number;
    pctUtilizacionPromedio: number | null;
    porEstatus: { estatus: string; count: number }[];
    clientesIncumplimiento: { clientId: string; name: string; estatus: string }[];
  };
  comite: {
    casos: number;
    proximaFecha: string | null;
    deals: { clientId: string; name: string; fechaEstComite: string }[];
  };
  eficiencia: {
    porResultado: { resultado: string; count: number }[];
    dormantTrimestre: number;
    dealVelocityPromedioDias: number | null;
    motivosNoCierre: { motivo: string; count: number }[];
  };
  cicloVidaPorEtapa: StageCycleTime[];
}

// Solo se cuenta como Aprobado/Cerrado/Rechazado cuando el Resultado del sheet lo dice
// explícitamente. Cualquier otra cosa (vacío, "En proceso", texto no reconocido) se
// trata como Dormant — un caso histórico sin desenlace claro no es lo mismo que uno
// que sabemos que se cerró o se rechazó.
const RESULTADO_BUCKETS = ['Aprobado', 'Cerrado', 'Rechazado por Axcess', 'Rechazado por cliente'] as const;
function resultadoBucket(raw: string): string {
  const match = RESULTADO_BUCKETS.find(b => b === raw);
  return match || 'Dormant';
}

function quarterStart(now: Date): number {
  const q = Math.floor(now.getMonth() / 3);
  return new Date(now.getFullYear(), q * 3, 1).getTime();
}

const MAX_REASONABLE_CYCLE_DAYS = 3650;

function usableDurationDays(value: number | null | undefined): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= 0
    && value <= MAX_REASONABLE_CYCLE_DAYS;
}

// KNOWN LIMITATION: a client mid-renewal can have an active Underwriting deal for a
// new facility while an older facility from the same client is still being logged
// under `phase: 'Monitoring'`. currentStage() tracks one stage per client (from its
// most recent activity), so such a client can show as 'Monitoring' here and drop out
// of the Underwriting pipeline count even while that deal is genuinely still open.
// Fixing this needs per-deal (not per-client) stage tracking, which the CRM data
// model doesn't have today.

export function computeStageCycleTimes(activitiesByClient: Record<string, CrmActivity[]>): StageCycleTime[] {
  const durations = new Map<CrmStage, number[]>();
  for (const activities of Object.values(activitiesByClient)) {
    const staged = activities
      .filter(a => a.nextStage && (CRM_STAGES as readonly string[]).includes(a.nextStage))
      .map(a => ({ stage: a.nextStage as CrmStage, at: new Date(a.createdAt).getTime() }))
      .filter(s => Number.isFinite(s.at))
      .sort((a, b) => a.at - b.at);
    for (let i = 1; i < staged.length; i++) {
      const prevStage = staged[i - 1].stage;
      const days = (staged[i].at - staged[i - 1].at) / 86_400_000;
      if (usableDurationDays(days)) (durations.get(prevStage) || durations.set(prevStage, []).get(prevStage)!).push(days);
    }
  }
  return CRM_STAGES.filter(s => isOpenDealStage(s))
    .map(stage => {
      const values = durations.get(stage) || [];
      if (!values.length) return null;
      return {
        stage,
        avgDays: values.reduce((a, b) => a + b, 0) / values.length,
        minDays: Math.min(...values),
        maxDays: Math.max(...values),
        n: values.length,
      };
    })
    .filter((s): s is NonNullable<typeof s> => s !== null);
}

export function buildPipelineSummary(
  clients: Client[],
  activitiesByClient: Record<string, CrmActivity[]>,
  pipelineMetaByClient: Record<string, MasterOrgPipelineMeta>,
  now: Date = new Date(),
): PipelineSummary {
  const qStart = quarterStart(now);

  const uwByCategoria = new Map<string, { count: number; monto: number }>();
  const uwByEtapa = new Map<CrmStage, { count: number; monto: number }>();
  let montoTotal = 0;
  let montoAjustado = 0;
  let deals = 0;
  let nuevosProspectosTrimestre = 0;

  let saldoVigente = 0;
  let montoOriginal = 0;
  let creditosActivos = 0;
  const monByEstatus = new Map<string, number>();
  const clientesIncumplimiento: { clientId: string; name: string; estatus: string }[] = [];

  const porResultado = new Map<string, number>();
  let dormantTrimestre = 0;
  const dealVelocities: number[] = [];
  const motivos = new Map<string, number>();
  const comiteDeals: { clientId: string; name: string; fechaEstComite: string }[] = [];

  for (const client of clients) {
    const meta = pipelineMetaByClient[client.id];
    const stage = currentStage(activitiesByClient[client.id] || []);

    if (meta?.underwriting && isOpenDealStage(stage)) {
      const uw = meta.underwriting;
      deals += 1;
      const monto = uw.monto || 0;
      montoTotal += monto;
      montoAjustado += monto * STAGE_PROBABILITY[stage];

      const cat = uw.categoria || 'Sin categoría';
      const catAgg = uwByCategoria.get(cat) || { count: 0, monto: 0 };
      catAgg.count += 1;
      catAgg.monto += monto;
      uwByCategoria.set(cat, catAgg);

      const etapaAgg = uwByEtapa.get(stage) || { count: 0, monto: 0 };
      etapaAgg.count += 1;
      etapaAgg.monto += monto;
      uwByEtapa.set(stage, etapaAgg);

      if (uw.fechaEstComite) {
        const t = new Date(uw.fechaEstComite).getTime();
        if (Number.isFinite(t) && t >= now.getTime()) {
          comiteDeals.push({ clientId: client.id, name: client.name, fechaEstComite: uw.fechaEstComite });
        }
      }
    }

    if (client.createdAt && new Date(client.createdAt).getTime() >= qStart) {
      nuevosProspectosTrimestre += 1;
    }

    // Dormant / closed clients don't count as active credits and can't carry an "incumplimiento" status.
    for (const line of isClientMonitored(client) ? meta?.monitoring || [] : []) {
      creditosActivos += 1;
      saldoVigente += computeLineBalance(line).saldo;
      montoOriginal += line.monto || 0;
      const est = line.estatus || 'Sin estatus';
      monByEstatus.set(est, (monByEstatus.get(est) || 0) + 1);
      if (est && est !== 'Cumplimiento' && est !== 'Sin estatus') {
        clientesIncumplimiento.push({ clientId: client.id, name: client.name, estatus: est });
      }
    }

    for (const h of meta?.historial || []) {
      const bucket = resultadoBucket(h.resultado);
      porResultado.set(bucket, (porResultado.get(bucket) || 0) + 1);
      if (bucket === 'Dormant') {
        // "trimestral" en el sheet original = entradas nuevas a Historial este trimestre;
        // aproximamos con la fecha de alta del cliente en FinMonitor.
        if (client.createdAt && new Date(client.createdAt).getTime() >= qStart) dormantTrimestre += 1;
      }
      if (usableDurationDays(h.dealVelocityDias)) dealVelocities.push(h.dealVelocityDias);
      if (h.motivo) motivos.set(h.motivo, (motivos.get(h.motivo) || 0) + 1);
    }
  }

  comiteDeals.sort((a, b) => a.fechaEstComite.localeCompare(b.fechaEstComite));

  return {
    underwriting: {
      montoTotal,
      montoAjustado,
      deals,
      nuevosProspectosTrimestre,
      porCategoria: Array.from(uwByCategoria.entries()).map(([categoria, v]) => ({ categoria, ...v })),
      porEtapa: CRM_STAGES.filter(s => isOpenDealStage(s))
        .map(stage => ({ stage, ...(uwByEtapa.get(stage) || { count: 0, monto: 0 }) }))
        .filter(e => e.count > 0),
    },
    monitoring: {
      saldoVigente,
      montoOriginal,
      creditosActivos,
      // Ponderado por saldo (no promedio simple de %), para que cuadre con
      // saldoVigente/montoOriginal igual que el Dashboard Ejecutivo del sheet.
      pctUtilizacionPromedio: montoOriginal > 0 ? saldoVigente / montoOriginal : null,
      porEstatus: Array.from(monByEstatus.entries()).map(([estatus, count]) => ({ estatus, count })),
      clientesIncumplimiento,
    },
    comite: {
      casos: comiteDeals.length,
      proximaFecha: comiteDeals[0]?.fechaEstComite || null,
      deals: comiteDeals,
    },
    eficiencia: {
      porResultado: Array.from(porResultado.entries()).map(([resultado, count]) => ({ resultado, count })),
      dormantTrimestre,
      dealVelocityPromedioDias: dealVelocities.length ? dealVelocities.reduce((a, b) => a + b, 0) / dealVelocities.length : null,
      motivosNoCierre: Array.from(motivos.entries())
        .map(([motivo, count]) => ({ motivo, count }))
        .sort((a, b) => b.count - a.count),
    },
    cicloVidaPorEtapa: computeStageCycleTimes(activitiesByClient),
  };
}
