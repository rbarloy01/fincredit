from __future__ import annotations

import argparse
import json
import os

from .config import load_config
from .orchestrator import Orchestrator


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
    args = parser.parse_args()

    if args.dry_run:
        config = load_config(args.config)
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

    result = Orchestrator.from_file(args.config).run(args.task, args.request)
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
