# Auditoría de datos financieros — FinMonitor (producción)

**Fecha:** 2026-07-23
**Alcance:** 118 clientes · 112 con estados financieros · 791 periodos analizados (100%, sin muestreo)
**Método:** lectura directa de Supabase (service role, solo lectura). Se comparó `mapped_data` contra `raw_line_items` de cada periodo. Reproducible con `set -a && source .env && set +a && npm run audit:ebitda` (script: `scripts/audit-ebitda-gap.ts`).

---

## Resumen por impacto

| # | Problema | Periodos afectados | Clientes afectados | Severidad |
|---|----------|-------------------:|-------------------:|-----------|
| 1 | **EBITDA = 0 con utilidad de operación en crudo** | 63 | 16 | 🔴 Crítica — rompe Deuda/EBITDA y DSCR |
| 2 | **Balance descuadrado** (\|Activo − (Pasivo + Capital)\| > 1%) | 35 | 17 | 🟠 Alta — distorsiona apalancamiento y capitalización |
| 3 | **Balance incompleto** (falta total de pasivo o de capital) | 109 | 31 | 🟡 Media — impide verificar el cuadre |
| 4 | **Campos core faltantes** (revenue, totalAssets, equity, totalDebt) | 0 | 0 | 🟢 Sin hallazgos |
| 5 | **Clientes sin estados financieros** | — | 6 | ℹ️ Informativo |

---

## 1. EBITDA = 0 (hallazgo sistémico) 🔴

**63 periodos en 16 clientes** tienen `mapped_data.ebitda` en 0 **a pesar de** que `raw_line_items` sí trae una línea explícita de utilidad/resultado de operación con valor distinto de cero. Detalle periodo-por-periodo en `audit-report/ebitda-gap.json`.

Clientes afectados (periodos): Ideaconv (12), KAPITAL FLEX (10), OAK LEASING (6), BESTA (5), SUPERIA (5), INVENTA LEASING (4), PEON LEASING (4), FINTRA (3), PRIORITA (2), SOLUREGIO (2), GESBER (2), OLUFIN (2), GFI APOYO (2), CAPIX (2), Red Girasol (1), iLEASING (1).

Ejemplos (valor de operación que existe en crudo pero no llega a `ebitda`):
- PRIORITA · Dic 2023 → `"UTILIDAD OPERATIVA"` = 25,503,106 · mapped ebitda = 0
- INVENTA LEASING · Jun 2024 → `"UTILIDAD DE OPERACIÓN (acumulado)"` = 37,990,480 · mapped ebitda = 0
- INVENTA LEASING · Dic 2023 → `"Resultado de operación"` = 5,802,281 · mapped ebitda = 0

### Causa raíz (dos capas)

**Capa 1 — La ingesta nunca llena `ebitda` para IFNBs.**
En `src/services/claude.ts:169` el prompt de extracción instruye:
> `EBITDA = revenue - cogs - operatingExpenses (calcula si no viene explícito)`

Ese modelo (ingreso − costo de ventas − gastos operativos) es de empresa comercial/industrial. Los estados de las IFNB/SOFOM se estructuran por **margen financiero / ingresos por intereses**, así que `revenue`, `cogs` y `operatingExpenses` se extraen en 0, y por lo tanto `ebitda = 0 − 0 − 0 = 0`. El default en `src/services/claude.ts:199-203` también arranca `ebitda` en 0. La línea "Utilidad/Resultado de Operación" queda en `raw_line_items` pero **nunca se mapea** a `mapped_data.ebitda`.

**Capa 2 — El fallback a crudo está muerto por un cortocircuito con el 0.**
`getMetric` sí tiene un fallback pensado para esto en `src/lib/financialMetrics.ts:321`:
```ts
case 'ebitda': return firstValue(m.ebitda, findConsolidatedMetricValue(stmt, 'ebitda'),
  raw(['ebitda', ...]), raw(['utilidad operacion', 'utilidad de operacion', 'resultado de operacion', ...]));
```
Pero `firstValue` (`src/lib/financialMetrics.ts:285-288`) devuelve el primer valor que **no sea `null`/`undefined`**:
```ts
const found = values.find(value => value !== null && value !== undefined);
```
Como `m.ebitda === 0` es un número (0 ≠ null), `firstValue` retorna **0 de inmediato** y el fallback a `"utilidad de operación"` nunca se ejecuta. Es código muerto mientras el mapped ebitda venga en 0.

**Consumidores que además leen `m.ebitda` directo (sin pasar por `getMetric`)** y por eso muestran Deuda/EBITDA y DSCR en blanco/erróneos:
- `src/components/covenants/CovenantPanel.tsx:45` → `value = m.ebitda !== 0 ? m.totalDebt / m.ebitda : null;`
- `src/lib/export.ts:2251` → `if (...ebitda...) return m.ebitda ? m.totalDebt / m.ebitda : null;`
- `src/lib/export.ts:1241` → `latest?.mappedData.ebitda ?? null`

### Recomendación de fix (por orden de menor riesgo / mayor impacto)

1. **Fix puntual, 1 línea, cubre todo lo que usa métricas — `src/lib/financialMetrics.ts:321`.** Tratar `m.ebitda === 0` como ausente para que el fallback a "utilidad de operación" se active. Introducir un helper y usarlo:
   ```ts
   const nz = (v: number | undefined | null) => (typeof v === 'number' && v !== 0 ? v : null);
   case 'ebitda': return firstValue(nz(m.ebitda), findConsolidatedMetricValue(stmt, 'ebitda'),
     raw(['ebitda', ...]), raw(['utilidad operacion', 'utilidad de operacion', 'resultado de operacion', ...]));
   ```
   Con esto `getMetric`, `standardRatios` y todo lo que dependa de ellos recuperan el EBITDA desde el crudo automáticamente, sin tocar datos en Supabase.
2. **Enrutar los consumidores directos** (`CovenantPanel.tsx:45`, `export.ts:2251`, `export.ts:1241`) a través de `getMetric(stmt, 'ebitda')` en lugar de leer `m.ebitda`, para que hereden el mismo fallback.
3. **Corregir la raíz en la ingesta — `src/services/claude.ts:169`.** Indicar al modelo que, para IFNB/SOFOM, mapee directamente la línea "Utilidad de Operación" / "Resultado de Operación" a `mappedData.ebitda`, en vez de calcular `revenue − cogs − operatingExpenses`. Así los estados nuevos ya entran correctos. (Los ya cargados quedan resueltos por el fix #1 sin necesidad de mutar la base.)

---

## 2. Balance descuadrado 🟠

**35 periodos en 17 clientes** con \|Activo − (Pasivo + Capital)\| relativo > 1%. Se usó el total de activo (mapped, con respaldo en la línea cruda "Total activo"), el total de pasivo y el capital contable tomados **solo de líneas de total explícitas en crudo** — excluyendo deliberadamente la línea combinada "Pasivo y Capital" (que iguala al activo) y sin usar el fallback a `totalDebt` de `getMetric('totalLiabilities')`, que fabricaría descuadres falsos.

Clientes ordenados por peor descuadre (periodos, máximo relativo):

| Cliente | Periodos | Máx. descuadre |
|---------|---------:|---------------:|
| R PARDO | 1 | 77.1% |
| IMPULSORA RECREA | 2 | 44.6% |
| PREVOL | 4 | 30.4% |
| SOLUCIONES CAPITAL X | 2 | 24.1% |
| PROQUATRO / YUHU | 1 | 16.6% |
| SB LEASING | 2 | 14.4% |
| NOGALEROS DEL NOROESTE | 5 | 10.5% |
| FINANCIERA ALIADOS | 1 | 9.7% |
| Red Girasol | 3 | 7.1% |
| CRESER | 2 | 6.6% |
| DEALCORP | 1 | 5.9% |
| Ideaconv | 2 | 5.7% |
| OMNICREDITO | 2 | 3.3% |
| PEON LEASING | 1 | 2.2% |
| OAK LEASING | 4 | 1.8% |
| CREDIPLATA | 1 | 1.8% |
| FLIEBEN 3 | 1 | 1.7% |

Los casos > 15% (R PARDO, IMPULSORA RECREA, PREVOL, SOLUCIONES CAPITAL X, PROQUATRO/YUHU) apuntan a una línea mal extraída u OCR incorrecto en el periodo y deben revisarse manualmente. Los < 5% suelen ser diferencias de redondeo/reservas menores. Detalle por periodo en `audit-report/_audit-data.json` → `balanceIssues`.

---

## 3. Balance incompleto 🟡

**109 periodos en 31 clientes** tienen total de activo pero **falta el total de pasivo o el total de capital** como línea identificable, por lo que no se puede verificar el cuadre. No es un descuadre confirmado, pero sí una laguna de extracción. Clientes: ABONITOS, AGROFIRME, ALVOS, AMIFIN, ASTRO CAPITAL, AVIVA, BC CAPITAL / CARPENTUM, CAPITAL TECH, CAPIX, CREIZER, CRESER, FINAPRO, FINTRA, FLIEBEN 3, FLIEBEN CAPITAL, FONDIMEX, FRONT CAPITAL, GESBER, GO TO CASH, GRUPALIA, ICP, INVENTA LEASING, META KAMPO / TIVEG, NEGOCIOS Y PROYECTOS, OLUFIN, PRETMEX, PROQUATRO / YUHU, Red Girasol, TPR3STAMOS, VENTUS, WOLF (PERALTA SOLUCIONES).

---

## 4. Campos core faltantes 🟢

**Sin hallazgos.** En los 791 periodos, cuando `revenue`, `totalAssets`, `equity` o `totalDebt` venían en 0/null en `mapped_data`, tampoco había un valor recuperable en `raw_line_items` (vía el fallback de `getMetric`). Es decir, el problema de mapeo es **específico de `ebitda`**; los demás campos core se mapean correctamente. Esto refuerza que la causa raíz es la fórmula `revenue − cogs − opex` del prompt, no una falla general de extracción.

---

## 5. Clientes sin estados financieros ℹ️

6 de 118 clientes no tienen ningún estado financiero cargado: **ATTENDO, AVANCE FI, MEND, VONTO LOGISTICS, YOFÍO, APALANCAMIENTO EMPRESARIAL.**

---

## Entregables

- `audit-report/ebitda-gap.json` — 63 filas: `{client, clientId, period, periodDate, mappedEbitda, rawOperatingProfitFound, rawOperatingLine}`.
- `audit-report/_audit-data.json` — datos completos: descuadres/incompletos por periodo, listas de clientes y totales.
- `audit-report/audit-summary.md` — este documento.
- `scripts/audit-ebitda-gap.ts` — script reproducible (`npm run audit:ebitda`).
