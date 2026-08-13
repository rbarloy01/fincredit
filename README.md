# Financial Monitor Pipeline

Scripts para indexar estados financieros, extraer cuentas desde PDFs, mapear conceptos y generar un workbook de monitoreo.

## Corrida rapida

Produccion:

```bash
scripts/run_finmonitor_prod.sh
```

Para trabajar con archivos reales en la carpeta de clientes:

```bash
python3 scripts/financial_monitor_pipeline.py \
  --clients-root "/Users/syscap/Library/CloudStorage/GoogleDrive-rbarron@syscap.com.mx/Shared drives/Axcess - Crédito y Riesgo/1. Clientes/3. Cerrados, Dormant & Rechazados" \
  --clients Ventus \
  --facility Ventus-F1 \
  --max-documents 20 \
  --skip-credit-evidence \
  --output outputs/financial_monitor/financial_monitor_pipeline.xlsx
```

Para solo inventariar la carpeta staging de Drive:

```bash
python3 scripts/financial_monitor_pipeline.py \
  --clients-root "/Users/syscap/Library/CloudStorage/GoogleDrive-rbarron@syscap.com.mx/My Drive/EEFF_Covenants_Source" \
  --clients Ventus \
  --skip-credit-evidence \
  --output outputs/financial_monitor/financial_monitor_staging.xlsx
```

## Performance

- La extraccion de PDFs usa cache persistente en `outputs/.cache/pdf_accounts`.
- Usa `--refresh-cache` si cambiaste los PDFs o quieres forzar una nueva extraccion.
- Usa `--skip-credit-evidence` durante iteraciones rapidas; el escaneo de evidencia crediticia recorre mas carpetas de Drive.
- Usa `--facility <id o nombre>` para aislar una sola facility y sus covenants en el workbook. El filtro usa `facility_id`, `facility_name` o `facility_covenants` desde `config/client_metadata_template.tsv`.
- El perfil `--profile prod` usa limites conservadores para evitar que un PDF pesado detenga toda la corrida.
- El workbook abre en modo CRM ligero: `Inicio` resume estado/alertas, `CRM Clientes` conserva seguimiento, y `Razones`, `QA`, `Documentos` y `Auditoria` quedan visibles para revision; las hojas raw se ocultan para no ensuciar la vista principal.

## CRM

- `config/client_metadata_template.tsv` guarda datos permanentes del cliente: producto, credito, contrato y notas base.
- `config/client_followups.tsv` guarda el seguimiento operativo persistente: responsable, proxima accion, fecha de actualizacion y notas de seguimiento. El pipeline lo recarga en cada corrida para que el CRM no pierda esos campos al regenerarse.
- Para evitar usar Excel como interfaz diaria, abre el CRM local:

```bash
python3 scripts/crm_server.py
```

Luego entra a `http://127.0.0.1:8765`. La vista web lee `outputs/financial_monitor/financial_monitor_pipeline.xlsx`, guarda cambios operativos en `config/client_followups.tsv` y puede reprocesar con `scripts/run_finmonitor_prod.sh`.

## Fuentes

El pipeline acepta dos estructuras:

- Carpeta tradicional de cliente con `1. Data Room/3. Información Financiera/1. Estados Financieros`.
- Carpeta plana por cliente, como `EEFF_Covenants_Source/Ventus`, incluyendo links `.webloc` para inventario.

## AI Orchestrator MVP

Este repo incluye un MVP aislado para que una app llame a un solo orchestrator y este decida que provider/modelo usar.

Arquitectura:

```text
Tu app -> scripts/run_ai_orchestrator.py -> ai_orchestrator -> provider OpenAI-compatible
                                         -> memory/project-memory.md
                                         -> memory/agents/*.md
                                         -> memory/runs/*.md
```

Providers configurados en `config/ai_orchestrator.example.json`:

- `openrouter`: gateway multi-modelo.
- `bytez`: API OpenAI-compatible de Bytez.
- `nvidia_nim`: NVIDIA NIM usando `/v1/chat/completions`.
- `local_vllm`: servidor local compatible, por ejemplo vLLM.

Variables necesarias:

```bash
cp .env.example .env
export OPENROUTER_API_KEY="..."
export BYTEZ_API_KEY="..."
export NVIDIA_NIM_API_KEY="..."
```

Prueba:

```bash
python3 scripts/run_ai_orchestrator.py "Disena una arquitectura de agentes para mi app"
```

Ver exactamente que provider/modelo usaria sin llamar APIs:

```bash
python3 scripts/run_ai_orchestrator.py --dry-run --task default "Prueba de routing"
```

Cambiar el modelo para una corrida:

```bash
python3 scripts/run_ai_orchestrator.py \
  --provider openrouter \
  --model "openrouter/auto" \
  "Disena una arquitectura de agentes para mi app"
```

Cambiar solo un agente:

```bash
python3 scripts/run_ai_orchestrator.py \
  --agent-provider worker=bytez \
  --agent-model worker="Qwen/Qwen3-4B" \
  --agent-provider reviewer=openrouter \
  --agent-model reviewer="openrouter/auto" \
  "Revisa este plan"
```

Rutas disponibles:

```bash
python3 scripts/run_ai_orchestrator.py --task cheap "Resume esta idea"
python3 scripts/run_ai_orchestrator.py --task review "Revisa este plan"
```

Notas:

- Sin llaves reales, el runner valida estructura pero no puede llamar providers externos.
- Bytez puede necesitar `BYTEZ_PROVIDER_KEY` cuando el modelo elegido usa un proveedor cerrado detrás.
- Para usar modelos locales, levanta un endpoint compatible con OpenAI en `http://localhost:8000/v1` y ajusta `LOCAL_LLM_API_KEY`.
- Tambien puedes fijar modelos por variable de entorno: `AI_MODEL_PLANNER`, `AI_MODEL_WORKER`, `AI_MODEL_REVIEWER`.
- Si cambias a un modelo de otro proveedor, cambia tambien el provider con `--provider`, `--agent-provider`, `AI_PROVIDER_PLANNER`, `AI_PROVIDER_WORKER` o `AI_PROVIDER_REVIEWER`.
