from __future__ import annotations

import json
import os
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class ProviderConfig:
    name: str
    base_url: str
    api_key_env: str
    default_model: str
    extra_headers: dict[str, str]


@dataclass(frozen=True)
class AgentConfig:
    name: str
    role: str
    provider: str
    model: str
    temperature: float = 0.3
    max_tokens: int = 1200


@dataclass(frozen=True)
class OrchestratorConfig:
    providers: dict[str, ProviderConfig]
    agents: dict[str, AgentConfig]
    routing: dict[str, list[str]]
    memory_dir: Path

    def with_model_overrides(
        self,
        *,
        default_provider: str = "",
        default_model: str = "",
        agent_providers: dict[str, str] | None = None,
        agent_models: dict[str, str] | None = None,
    ) -> "OrchestratorConfig":
        provider_overrides = agent_providers or {}
        model_overrides = agent_models or {}
        agents = {}
        for name, agent in self.agents.items():
            provider = (
                provider_overrides.get(name)
                or _env_agent_provider(name)
                or default_provider
                or agent.provider
            )
            if provider not in self.providers:
                raise ValueError(f"Unknown provider override for agent {name}: {provider}")
            model = model_overrides.get(name) or _env_agent_model(name) or default_model
            if not model and provider != agent.provider:
                model = self.providers[provider].default_model
            agents[name] = replace(agent, provider=provider, model=model or agent.model)
        return replace(self, agents=agents)


def _expand_env(value: str) -> str:
    if value.startswith("$"):
        return os.environ.get(value[1:], "")
    return value


def _env_agent_model(agent_name: str) -> str:
    env_name = f"AI_MODEL_{agent_name.upper().replace('-', '_')}"
    return os.environ.get(env_name, "").strip()


def _env_agent_provider(agent_name: str) -> str:
    env_name = f"AI_PROVIDER_{agent_name.upper().replace('-', '_')}"
    return os.environ.get(env_name, "").strip()


def load_config(path: str | Path) -> OrchestratorConfig:
    raw: dict[str, Any] = json.loads(Path(path).read_text(encoding="utf-8"))

    providers = {
        name: ProviderConfig(
            name=name,
            base_url=data["base_url"].rstrip("/"),
            api_key_env=data["api_key_env"],
            default_model=data["default_model"],
            extra_headers={
                key: _expand_env(value)
                for key, value in data.get("extra_headers", {}).items()
                if _expand_env(value)
            },
        )
        for name, data in raw["providers"].items()
    }

    agents = {
        name: AgentConfig(
            name=name,
            role=data["role"],
            provider=data["provider"],
            model=data.get("model") or providers[data["provider"]].default_model,
            temperature=float(data.get("temperature", 0.3)),
            max_tokens=int(data.get("max_tokens", 1200)),
        )
        for name, data in raw["agents"].items()
    }

    return OrchestratorConfig(
        providers=providers,
        agents=agents,
        routing=raw.get("routing", {}),
        memory_dir=Path(raw.get("memory_dir", "memory")),
    )
