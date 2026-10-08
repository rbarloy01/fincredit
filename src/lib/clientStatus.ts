// Only clients with status "activo" are monitored. Dormant (inactive/lost) and closed (terminated) clients must never be
// flagged as breached, overdue or at risk — and nobody can mark them as such — so every alert path asks this first.
import type { ClientStatus } from '../db/index';

export const isClientMonitored = (client?: { status?: ClientStatus | null } | null): boolean => !client?.status || client.status === 'activo';

export const clientStatusLabel = (status?: ClientStatus | null): string => (status === 'dormant' ? 'Dormant' : status === 'cerrado' ? 'Cerrado' : 'Activo');

export const MONITORING_PAUSED_TEXT = 'Sin monitoreo: el cliente no está activo, así que no se evalúan ni se pueden marcar incumplimientos, vencimientos de EEFF o contratos.';
