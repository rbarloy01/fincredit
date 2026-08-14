from __future__ import annotations

import argparse
import json
import os

from .config import load_config
from .orchestrator import Orchestrator


def parse_key_value_overrides(values: list[str], flag: str) -> dict[str, str]:
    overrides: dict[str, str] = {}
    for value in values:
        if "=" not in value:
            raise SystemExit(f"Invalid {flag} '{value}'. Use the format key=value.")
        agent, model = value.split("=", 1)
        agent = agent.strip()
        model = model.strip()
        if not agent or not model:
            raise SystemExit(f"Invalid {flag} '{value}'. Key and value must be non-empty.")
        overrides[agent] = model
    return overrides


def validate_override_names(
    *,
    label: str,
    overrides: dict[str, str],
    allowed: set[str],
) -> None:
    unknown = sorted(set(overrides) - allowed)
    if unknown:
        raise SystemExit(f"Unknown {label}(s): {', '.join(unknown)}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the local AI orchestrator.")
    parser.add_argument("request", help="User request to process")
    parser.add_argument("--task", default="default", help="Routing task name")
    parser.add_argument(
        "--config",
        default="config/ai_orchestrator.example.json",
        help="Path to orchestrator config JSON",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show routing and missing env vars without calling any model",
    )
    parser.add_argument(
        "--model",
        default="",
        help="Override the model for every agent used in this run.",
    )
    parser.add_argument(
        "--provider",
        default="",
        help="Override the provider for every agent used in this run.",
    )
    parser.add_argument(
        "--agent-model",
        action="append",
        default=[],
        metavar="AGENT=MODEL",
        help="Override one agent model. Can be repeated, e.g. --agent-model worker=Qwen/Qwen3-4B.",
    )
    parser.add_argument(
        "--agent-provider",
        action="append",
        default=[],
        metavar="AGENT=PROVIDER",
        help="Override one agent provider. Can be repeated, e.g. --agent-provider worker=openrouter.",
    )
    args = parser.parse_args()

    base_config = load_config(args.config)
    provider = args.provider.strip()
    if provider and provider not in base_config.providers:
        raise SystemExit(f"Unknown provider: {provider}")

    agent_model_overrides = parse_key_value_overrides(args.agent_model, "--agent-model")
    agent_provider_overrides = parse_key_value_overrides(args.agent_provider, "--agent-provider")
    validate_override_names(
        label="agent in --agent-model",
        overrides=agent_model_overrides,
        allowed=set(base_config.agents),
    )
    validate_override_names(
        label="agent in --agent-provider",
        overrides=agent_provider_overrides,
        allowed=set(base_config.agents),
    )
    validate_override_names(
        label="provider in --agent-provider",
        overrides={value: value for value in agent_provider_overrides.values()},
        allowed=set(base_config.providers),
    )
    config = base_config.with_model_overrides(
        default_provider=provider,
        default_model=args.model.strip(),
        agent_providers=agent_provider_overrides,
        agent_models=agent_model_overrides,
    )

    if args.dry_run:
        agent_names = config.routing.get(args.task) or config.routing["default"]
        agents = [config.agents[name] for name in agent_names]
        required_env = sorted(
            {
                config.providers[agent.provider].api_key_env
                for agent in agents
                if not os.environ.get(config.providers[agent.provider].api_key_env)
            }
        )
        print(
            json.dumps(
                {
                    "task": args.task,
                    "agents": [
                        {
                            "name": agent.name,
                            "role": agent.role,
                            "provider": agent.provider,
                            "model": agent.model,
                            "api_key_env": config.providers[agent.provider].api_key_env,
                            "temperature": agent.temperature,
                            "max_tokens": agent.max_tokens,
                        }
                        for agent in agents
                    ],
                    "missing_env": required_env,
                    "memory_dir": str(config.memory_dir),
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return

    result = Orchestrator(config).run(args.task, args.request)
    print(
        json.dumps(
            {
                "answer": result.answer,
                "providers_used": result.providers_used,
                "models_used": result.models_used,
                "run_log_path": result.run_log_path,
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
