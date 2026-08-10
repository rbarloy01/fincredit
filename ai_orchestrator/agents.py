from __future__ import annotations

from .config import AgentConfig
from .memory import MarkdownMemory
from .providers import Completion, OpenAICompatibleProvider


SYSTEM_PROMPTS = {
    "planner": "Eres el planner. Divide la request en pasos concretos, riesgos y criterio de exito.",
    "worker": "Eres el worker. Produce la solucion principal, clara y accionable.",
    "reviewer": "Eres el reviewer. Busca errores, riesgos y huecos. Se directo.",
    "summarizer": "Resume el estado nuevo de forma breve para memoria futura.",
}


class Agent:
    def __init__(
        self,
        config: AgentConfig,
        provider: OpenAICompatibleProvider,
        memory: MarkdownMemory,
    ):
        self.config = config
        self.provider = provider
        self.memory = memory

    def run(self, user_request: str, context: str) -> Completion:
        system = SYSTEM_PROMPTS.get(self.config.role, self.config.role)
        messages = [
            {
                "role": "system",
                "content": (
                    f"{system}\n\n"
                    "Usa la memoria del proyecto como contexto compartido. "
                    "No inventes ejecuciones ni credenciales."
                ),
            },
            {
                "role": "user",
                "content": (
                    f"# Project Memory\n{self.memory.read_project()}\n\n"
                    f"# Run Context\n{context}\n\n"
                    f"# User Request\n{user_request}"
                ),
            },
        ]
        result = self.provider.complete(
            model=self.config.model,
            messages=messages,
            temperature=self.config.temperature,
            max_tokens=self.config.max_tokens,
        )
        self.memory.write_agent_note(self.config.name, result.content)
        return result
