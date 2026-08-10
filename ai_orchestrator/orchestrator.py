from __future__ import annotations

from dataclasses import dataclass

from .agents import Agent
from .config import OrchestratorConfig, load_config
from .memory import MarkdownMemory
from .providers import OpenAICompatibleProvider, ProviderError


@dataclass(frozen=True)
class OrchestratorResult:
    answer: str
    providers_used: list[str]
    models_used: list[str]
    run_log_path: str


class Orchestrator:
    def __init__(self, config: OrchestratorConfig):
        self.config = config
        self.memory = MarkdownMemory(config.memory_dir)
        self.providers = {
            name: OpenAICompatibleProvider(provider_config)
            for name, provider_config in config.providers.items()
        }

    @classmethod
    def from_file(cls, path: str) -> "Orchestrator":
        return cls(load_config(path))

    def run(self, task: str, user_request: str) -> OrchestratorResult:
        agent_names = self.config.routing.get(task) or self.config.routing["default"]
        context = ""
        providers_used: list[str] = []
        models_used: list[str] = []
        sections: list[str] = [f"# Run\n\n## Task\n{task}\n\n## Request\n{user_request}"]

        for agent_name in agent_names:
            agent_config = self.config.agents[agent_name]
            agent = Agent(
                config=agent_config,
                provider=self.providers[agent_config.provider],
                memory=self.memory,
            )
            try:
                completion = agent.run(user_request=user_request, context=context)
            except ProviderError as exc:
                fallback = self._fallback_agent(agent_name)
                if fallback is None:
                    raise
                agent = Agent(
                    config=fallback,
                    provider=self.providers[fallback.provider],
                    memory=self.memory,
                )
                completion = agent.run(
                    user_request=user_request,
                    context=f"{context}\n\nProvider failed: {exc}",
                )

            providers_used.append(completion.provider)
            models_used.append(completion.model)
            context += f"\n\n## {agent_name}\n{completion.content}"
            sections.append(
                f"## {agent_name}\nProvider: {completion.provider}\nModel: {completion.model}\n\n{completion.content}"
            )

        answer = context.split(f"## {agent_names[-1]}", 1)[-1].strip()
        run_path = self.memory.append_run("\n\n".join(sections))
        self.memory.append_project_update(
            "Latest Run Summary",
            f"Task: {task}\n\nProviders: {', '.join(providers_used)}\n\nLast answer:\n{answer[:2000]}",
        )
        return OrchestratorResult(
            answer=answer,
            providers_used=providers_used,
            models_used=models_used,
            run_log_path=str(run_path),
        )

    def _fallback_agent(self, agent_name: str):
        fallback_name = f"{agent_name}_fallback"
        return self.config.agents.get(fallback_name)
