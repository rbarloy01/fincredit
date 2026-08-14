from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any

from .config import ProviderConfig


class ProviderError(RuntimeError):
    pass


@dataclass(frozen=True)
class Completion:
    content: str
    provider: str
    model: str
    raw: dict[str, Any]


class OpenAICompatibleProvider:
    """Adapter for OpenRouter, Bytez, NVIDIA NIM, local vLLM, and similar APIs."""

    def __init__(self, config: ProviderConfig):
        self.config = config

    def complete(
        self,
        *,
        model: str,
        messages: list[dict[str, str]],
        temperature: float,
        max_tokens: int,
    ) -> Completion:
        api_key = os.environ.get(self.config.api_key_env)
        if not api_key:
            raise ProviderError(
                f"Missing {self.config.api_key_env} for provider {self.config.name}"
            )

        payload = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        body = json.dumps(payload).encode("utf-8")

        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
            **self.config.extra_headers,
        }
        if self.config.name == "bytez":
            headers["Authorization"] = api_key

        request = urllib.request.Request(
            f"{self.config.base_url}/chat/completions",
            data=body,
            headers=headers,
            method="POST",
        )

        try:
            with urllib.request.urlopen(request, timeout=90) as response:
                raw = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise ProviderError(
                f"{self.config.name} HTTP {exc.code}: {detail[:1000]}"
            ) from exc
        except urllib.error.URLError as exc:
            raise ProviderError(f"{self.config.name} connection error: {exc}") from exc

        try:
            content = raw["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as exc:
            raise ProviderError(f"{self.config.name} returned unexpected JSON: {raw}") from exc

        return Completion(
            content=content,
            provider=self.config.name,
            model=model,
            raw=raw,
        )
