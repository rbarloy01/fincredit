from __future__ import annotations

from datetime import datetime
from pathlib import Path


class MarkdownMemory:
    def __init__(self, root: Path):
        self.root = root
        self.project_file = root / "project-memory.md"
        self.agent_dir = root / "agents"
        self.run_dir = root / "runs"
        self.agent_dir.mkdir(parents=True, exist_ok=True)
        self.run_dir.mkdir(parents=True, exist_ok=True)
        if not self.project_file.exists():
            self.project_file.write_text(DEFAULT_PROJECT_MEMORY, encoding="utf-8")

    def read_project(self) -> str:
        return self.project_file.read_text(encoding="utf-8")

    def write_agent_note(self, agent: str, content: str) -> Path:
        path = self.agent_dir / f"{agent}.md"
        path.write_text(content.strip() + "\n", encoding="utf-8")
        return path

    def append_run(self, content: str) -> Path:
        stamp = datetime.now().strftime("%Y-%m-%d-%H%M%S")
        path = self.run_dir / f"{stamp}.md"
        path.write_text(content.strip() + "\n", encoding="utf-8")
        return path

    def append_project_update(self, title: str, content: str) -> None:
        stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with self.project_file.open("a", encoding="utf-8") as file:
            file.write(f"\n## {title} - {stamp}\n\n{content.strip()}\n")


DEFAULT_PROJECT_MEMORY = """# Project Memory

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
"""
