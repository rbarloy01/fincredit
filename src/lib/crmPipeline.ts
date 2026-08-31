// Shared CRM pipeline helpers: stage derivation + follow-up (reminder) bucketing.
// Pure functions; "now" is injected for testability.
import { CrmActivity } from '../db/index';

export const CRM_STAGES = [
  '1. Contacto',
  '2. Term Sheet',
  '3. Checklist',
  '4. Análisis',
  '5. Due Diligence',
  '6. Contrato',
  '7. Disposición',
  'Monitoring',
] as const;

export type CrmStage = (typeof CRM_STAGES)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

function ts(value?: string): number {
  if (!value) return 0;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : 0;
}

// A client's current pipeline stage = the most recently recorded stage signal.
// Most activities log it as `nextStage` (the stage the deal is moving into),
// but once a deal is disbursed its log simply switches to logging with
// `phase: 'Monitoring'` going forward, with no explicit "next stage" activity
// ever recorded — so that phase tag is treated as its own signal too.
// Falls back to the first stage.
export function currentStage(activities: CrmActivity[] = []): CrmStage {
  const signals = activities
    .map(a => {
      if (a.nextStage && (CRM_STAGES as readonly string[]).includes(a.nextStage)) {
        return { stage: a.nextStage as CrmStage, createdAt: a.createdAt };
      }
      if (a.phase === 'Monitoring') {
        return { stage: 'Monitoring' as CrmStage, createdAt: a.createdAt };
      }
      return null;
    })
    .filter((s): s is NonNullable<typeof s> => s !== null)
    .sort((a, b) => ts(b.createdAt) - ts(a.createdAt));
  return signals[0]?.stage || CRM_STAGES[0];
}

export function groupClientsByStage<T extends { id: string }>(
  clients: T[],
  activitiesByClient: Record<string, CrmActivity[]>,
): Record<CrmStage, T[]> {
  const groups = Object.fromEntries(CRM_STAGES.map(s => [s, [] as T[]])) as Record<CrmStage, T[]>;
  for (const client of clients) {
    const stage = currentStage(activitiesByClient[client.id] || []);
    groups[stage].push(client);
  }
  return groups;
}

export type ReminderBucket = 'vencidas' | 'hoy' | 'semana' | 'proximas' | 'sin_fecha';

export const REMINDER_BUCKETS: { key: ReminderBucket; label: string }[] = [
  { key: 'vencidas', label: 'Vencidas' },
  { key: 'hoy', label: 'Hoy' },
  { key: 'semana', label: 'Esta semana' },
  { key: 'proximas', label: 'Próximas' },
  { key: 'sin_fecha', label: 'Sin fecha' },
];

export function reminderBucket(dueAt: string | undefined, now: Date): ReminderBucket {
  if (!dueAt) return 'sin_fecha';
  const due = new Date(dueAt);
  if (Number.isNaN(due.getTime())) return 'sin_fecha';
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const endOfToday = startOfToday + DAY_MS - 1;
  const endOfWeek = startOfToday + 7 * DAY_MS;
  const t = due.getTime();
  if (t < startOfToday) return 'vencidas';
  if (t <= endOfToday) return 'hoy';
  if (t <= endOfWeek) return 'semana';
  return 'proximas';
}

export interface OpenReminder {
  activity: CrmActivity;
  clientId: string;
  bucket: ReminderBucket;
  daysUntil: number; // negative = overdue
}

export function collectOpenReminders(
  activitiesByClient: Record<string, CrmActivity[]>,
  now: Date,
): OpenReminder[] {
  const out: OpenReminder[] = [];
  for (const [clientId, activities] of Object.entries(activitiesByClient)) {
    for (const activity of activities) {
      if (activity.status !== 'planned') continue;
      const bucket = reminderBucket(activity.dueAt, now);
      const daysUntil = activity.dueAt
        ? Math.ceil((new Date(activity.dueAt).getTime() - now.getTime()) / DAY_MS)
        : Number.POSITIVE_INFINITY;
      out.push({ activity, clientId, bucket, daysUntil });
    }
  }
  const priorityRank = { high: 0, normal: 1, low: 2 } as const;
  return out.sort((a, b) => {
    const da = a.daysUntil === Number.POSITIVE_INFINITY ? Number.MAX_SAFE_INTEGER : a.daysUntil;
    const dbt = b.daysUntil === Number.POSITIVE_INFINITY ? Number.MAX_SAFE_INTEGER : b.daysUntil;
    return da - dbt || priorityRank[a.activity.priority] - priorityRank[b.activity.priority];
  });
}
