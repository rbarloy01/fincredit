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
