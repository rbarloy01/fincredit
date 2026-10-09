// Reglas de negocio de cuadre de estados financieros con jerarquía (role / parent de la extracción).
//
// Regla: cada subtotal y total es igual a la suma de sus componentes directos, en TODOS los niveles, con tolerancia
// solo para redondeos de la fuente. El resultado neto también se valida contra la suma de sus hojas (todo el árbol).
// Si un renglón no cuadra se reporta cuál y por cuánto, en vez de comparar "ingresos" por nombre (que fallaba con
// estados donde el ingreso principal se llama "Comisiones cobradas", p. ej. Red Girasol 2021).

export interface HierarchyItem {
  name: string;
  value: number | null | undefined;
  statementType?: string | null;
  role?: string | null;
  parent?: string | null;
}

export interface HierarchyFailure { name: string; reported: number; childrenSum: number; gap: number }

export interface HierarchyCheck {
  top: { name: string; reported: number; leafSum: number; gap: number } | null;
  nodesChecked: number;
  failures: HierarchyFailure[];
  leaves: number;
  ok: boolean;
}

// Redondeos de la fuente: hasta $5 o 0.05% del renglón (lo que sea mayor).
export const ROUNDING_TOLERANCE = { absolute: 5, relative: 0.0005 } as const;
export const withinRounding = (gap: number, base: number) => Math.abs(gap) <= Math.max(ROUNDING_TOLERANCE.absolute, Math.abs(base) * ROUNDING_TOLERANCE.relative);

const plain = (v: string) => v.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const NET_RESULT = /resultado neto|utilidad neta|perdida neta|utilidad \(perdida\) neta|net income/;

export function checkHierarchy(all: HierarchyItem[], statementType: string): HierarchyCheck | null {
  const items = all.filter(i => i.statementType === statementType && typeof i.value === 'number' && Number.isFinite(i.value as number));
  if (!items.some(i => i.parent)) return null;
  const byParent = new Map<string, HierarchyItem[]>();
  items.forEach(i => { if (i.parent) byParent.set(i.parent, [...(byParent.get(i.parent) || []), i]); });
  const byName = new Map(items.map(i => [i.name, i]));

  const failures: HierarchyFailure[] = [];
  let nodesChecked = 0;
  byParent.forEach((children, parentName) => {
    const node = byName.get(parentName);
    if (!node) return;
    nodesChecked += 1;
    const childrenSum = children.reduce((a, c) => a + (c.value as number), 0);
    const gap = (node.value as number) - childrenSum;
    if (!withinRounding(gap, node.value as number)) failures.push({ name: parentName, reported: node.value as number, childrenSum, gap });
  });

  // Total final: resultado neto (ER) o el total sin padre que tenga componentes.
  const top = items.find(i => byParent.has(i.name) && NET_RESULT.test(plain(i.name)))
    || items.find(i => !i.parent && i.role === 'total' && byParent.has(i.name));
  let leaves = 0;
  let topResult: HierarchyCheck['top'] = null;
  if (top) {
    const seen = new Set<string>();
    const leafSum = (name: string): number => {
      if (seen.has(name)) return 0;
      seen.add(name);
      return (byParent.get(name) || []).reduce((acc, child) => {
        if (byParent.has(child.name)) return acc + leafSum(child.name);
        leaves += 1;
        return acc + (child.value as number);
      }, 0);
    };
    const sum = leafSum(top.name);
    topResult = { name: top.name, reported: top.value as number, leafSum: sum, gap: (top.value as number) - sum };
  }
  const topOk = !topResult || withinRounding(topResult.gap, topResult.reported);
  return { top: topResult, nodesChecked, failures, leaves, ok: failures.length === 0 && topOk };
}
