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
- El perfil `--profile prod` usa limites conservadores para evitar que un PDF pesado detenga toda la corrida.

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

Rutas disponibles:

```bash
python3 scripts/run_ai_orchestrator.py --task cheap "Resume esta idea"
python3 scripts/run_ai_orchestrator.py --task review "Revisa este plan"
```

Notas:

- Sin llaves reales, el runner valida estructura pero no puede llamar providers externos.
- Bytez puede necesitar `BYTEZ_PROVIDER_KEY` cuando el modelo elegido usa un proveedor cerrado detrás.
- Para usar modelos locales, levanta un endpoint compatible con OpenAI en `http://localhost:8000/v1` y ajusta `LOCAL_LLM_API_KEY`.
