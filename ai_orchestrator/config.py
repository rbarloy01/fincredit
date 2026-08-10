from __future__ import annotations

import json
import os
from dataclasses import dataclass
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


def _expand_env(value: str) -> str:
    if value.startswith("$"):
        return os.environ.get(value[1:], "")
    return value


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
