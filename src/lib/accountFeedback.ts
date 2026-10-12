// Retroalimentación del analista a las cuentas de los estados financieros, por cliente.
// "Para este cliente, el capital contable es la cuenta X" (o "la cartera es 'Instrumentos financieros para cobrar
// principal e interés'"). Se guarda por cliente en client_settings y manda sobre el mapeo automático en TODOS sus
// periodos que traigan una cuenta con ese nombre. getMetric la consulta antes que cualquier regla.

import { db } from '../db/index';

export const accountFeedbackKey = (clientId: string) => `finmonitor_account_feedback_${clientId}`;

// concepto (clave de getMetric) → nombres de cuenta normalizados que lo representan para este cliente
export type AccountFeedback = Record<string, string[]>;

export const normalizeAccountName = (name: string) =>
  name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

// Caché en memoria (getMetric es síncrono): se hidrata al abrir el cliente.
const cache = new Map<string, AccountFeedback>();
let version = 0;
export const accountFeedbackVersion = () => version;

export function setAccountFeedbackCache(clientId: string, feedback: AccountFeedback) {
  cache.set(clientId, feedback || {});
  version += 1;
}

export function accountFeedbackFor(clientId: string | undefined): AccountFeedback | undefined {
  return clientId ? cache.get(clientId) : undefined;
}

export async function loadAccountFeedback(clientId: string): Promise<AccountFeedback> {
  const fb = await db.getClientSetting<AccountFeedback>(clientId, accountFeedbackKey(clientId), {}).catch(() => ({} as AccountFeedback));
  setAccountFeedbackCache(clientId, fb);
  return fb;
}

export async function saveAccountFeedback(clientId: string, concept: string, accountNames: string[]): Promise<AccountFeedback> {
  const current = await db.getClientSetting<AccountFeedback>(clientId, accountFeedbackKey(clientId), {}).catch(() => ({} as AccountFeedback));
  const next = { ...current };
  const names = Array.from(new Set(accountNames.map(normalizeAccountName).filter(Boolean)));
  if (names.length) next[concept] = names; else delete next[concept];
  await db.setClientSetting(clientId, accountFeedbackKey(clientId), next);
  setAccountFeedbackCache(clientId, next);
  return next;
}

// Valor del concepto según la corrección del analista: suma de las cuentas indicadas presentes en el estado
// (una o varias, p. ej. préstamos de corto + largo plazo). null si el cliente no tiene corrección o el estado no
// trae ninguna de esas cuentas (entonces sigue el mapeo automático).
export function feedbackValue(
  clientId: string | undefined,
  items: Array<{ name: string; value: number | null | undefined }>,
  concept: string,
): number | null {
  const names = accountFeedbackFor(clientId)?.[concept];
  if (!names?.length) return null;
  const hits = items.filter(i => typeof i.value === 'number' && names.includes(normalizeAccountName(i.name)));
  if (!hits.length) return null;
  return hits.reduce((a, i) => a + (i.value as number), 0);
}
