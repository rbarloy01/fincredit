# Project Memory

## Goal
Construir un orchestrator propio para que la app use muchos modelos/proveedores sin acoplarse a uno solo.

## Current State
MVP local con memoria markdown y providers OpenAI-compatible.

## Decisions
- La app debe llamar al orchestrator, no directamente a OpenAI, Claude, Gemini, Bytez o NVIDIA NIM.
- Los providers se configuran por URL, modelo y variable de entorno.
- La memoria compartida vive en markdown para que agentes y humanos puedan leerla.

## Open Questions
- Confirmar llaves disponibles: OPENROUTER_API_KEY, BYTEZ_API_KEY, NVIDIA_NIM_API_KEY.
- Confirmar modelos preferidos para cada provider.

## Next Actions
- Probar request real con un provider.
- Ajustar routing por costo/calidad.
