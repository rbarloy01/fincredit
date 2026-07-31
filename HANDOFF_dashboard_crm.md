# Handoff — Dashboard global + CRM (para sesión nueva)

FinMonitor / FinAnalyzer — `/Users/syscap/Documents/New project`. Vite+React+TS+Supabase.
Prod: https://finmonitor-base.vercel.app · deploy `vercel --prod --yes` (los push NO auto-despliegan).
Verificación sin login: Node harness (esbuild + stubs) o REST directo con el service key.
`.env` → `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` (usar `set -a && source .env && set +a`).

## Tarea A — Dashboard GLOBAL de portafolio (no existe)
Hoy solo hay panel por-cliente (Underwriting/monitoreo). Falta un **home** con la vista de toda la cartera. KPIs sugeridos:
- Clientes en **breach de covenant hoy** (usar la evaluación de covenants ya existente en `financialMetrics`/`CovenantPanel`).
- **Cartera monitoreada** total y por estatus/semáforo.
- **EEFF / documentos vencidos** (por calendario de reporte del cliente).
- **Vencimientos próximos** (loan tapes / transacciones).
- Distribución de riesgo (usar `creditRiskModel` — OJO: es heurístico, ya lleva disclaimers; mostrarlo como señal, no PD validado).
- Lista de **alertas / watchlist**.
Dónde: nueva ruta/pantalla en `src/App.tsx` (router por strings: clients, client_detail, settings...). Datos: `clients` + `financial_statements` + `covenants` + `loan_tapes`.

## Tarea B — Mejorar el CRM (ya existe)
Componentes: `src/components/crm/CrmDashboardPage.tsx` (tabla por-cliente con estatus de monitoreo + estatus/urgencia de actividad), `CrmPanel.tsx`.
Esquema (migraciones `database/20260706_crm_relationship_layer.sql` + `20260706_crm_sheet_fields.sql`):
- **crm_contacts**: por cliente — name/title/department/email/phone, `influence` (low/medium/high/decision_maker), `relationship` (champion/neutral/risk), is_primary, notes.
- **crm_activities**: call/meeting/email/task/note/review — phase, record_type, next_stage, contact_name, analyst_name, subject, quick_note, next_step, detail, `status` (planned/done/canceled), `priority`, due_at, completed_at, owner_id.
El diseño actual parece calcado de un tracker tipo Google Sheet (campos phase/record_type/next_stage).
**PRIMERO preguntar al usuario qué significa "mejor CRM"** (opciones probables): pipeline/kanban por `phase`, recordatorios de seguimiento (due_at), timeline de actividad por cliente, mapa de contactos por influencia, o enganchar el CRM con las alertas de monitoreo/covenants.
El usuario pidió **jalar contexto de conversaciones previas**: revisar sesiones `local_e9a420f3-...` ("Sistema de gestión de cartera de crédito") y `local_e69ab168-...` ("Bucket not found error in benchmark", 2026-07-23) con las tools `mcp__ccd_session_mgmt__search_session_transcripts` / `list_events`.

## Contexto reciente (ya hecho, no rehacer)
- **Cambio de contraseña self-service** desplegado (`auth.changePassword` + tarjeta en Configuración para todos).
- **Excel**: Balance General jerárquico (subtotales/total = `=SUM` reales vía role/parent + heurístico de fallback), análisis vertical vs total final, y celdas numéricas vacías ahora **blanco real** (no texto `''`) para poder sumar. EBITDA=0 arreglado (getMetric fallback + prompt).
- **Prompt de extracción** endurecido (`src/prompts/financials.md`): role/parent + auto-verificación de cuadre + reglas de signo + leer por imagen.
- **Re-extracción por imagen** (pipeline: Drive PDF → Read por imagen → role/parent → verificar cuadre → Supabase). Hechos: ASTRO, Ideaconv(8), KAPITAL FLEX/CUMPLO Y AVANZO(2), COFINE(4), CAPEM/Grupo Olinx(3), AFIX(4, con EBITDA pero SIN role/parent). Pendiente: ICP + más tandas. Subagentes: usar prompt "hazlo TODO tú, NO anides subagentes, escribe y CONFIRMA el id". Drive: carpetas de cliente bajo `1zoTjpI7_ZhRRw4Oq0Cq2-Zr23I-fjnw_` (activas) y "2. Dormant" `1v1AZJHUmz0zMkFl41GSxM-7k7NcvByLW`; cada una `<cliente>/1. Data Room/3. Información Financiera/*.pdf`.

## Pendiente del usuario (Supabase SQL editor)
Correr `database/20260716_institutional_liabilities.sql` y `20260718_company_default_assessments.sql` (aún no existen en prod).
