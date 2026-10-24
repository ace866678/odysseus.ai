"""Provider-independent inference client for the evolving-intelligence rollout.

This module is deliberately opt-in and additive. It does not replace the
existing endpoint router or local model; callers must explicitly enable and
invoke it. API keys are read from the environment and are never logged.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Mapping, Sequence
from urllib.parse import urlsplit, urlunsplit

import httpx


class EvolvingAIError(RuntimeError):
    """Safe-to-display error from the optional evolving-AI inference endpoint."""

    def __init__(self, message: str, *, status_code: int | None = None):
        super().__init__(message)
        self.status_code = status_code


def _enabled(value: str | None) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def _chat_completions_url(base_url: str) -> str:
    """Normalize an OpenAI-compatible base URL to /v1/chat/completions."""
    raw = str(base_url or "").strip()
    if not raw:
        raise ValueError("An inference base URL is required")
    parsed = urlsplit(raw)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("Inference URL must be an absolute HTTP(S) URL")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("Inference URL must not contain credentials, query, or fragment")
    path = parsed.path.rstrip("/")
    if path.endswith("/chat/completions"):
        normalized_path = path
    elif path.endswith("/v1"):
        normalized_path = path + "/chat/completions"
    else:
        normalized_path = path + "/v1/chat/completions"
    return urlunsplit((parsed.scheme, parsed.netloc, normalized_path, "", ""))


@dataclass(frozen=True)
class EvolvingAIConfig:
    """Runtime configuration; secrets are intentionally excluded from repr."""

    enabled: bool = False
    base_url: str = ""
    model: str = ""
    api_key: str = ""
    timeout_seconds: float = 30.0

    @classmethod
    def from_env(cls) -> "EvolvingAIConfig":
        raw_timeout = os.getenv("ODYSSEUS_EVOLVING_AI_TIMEOUT", "30").strip()
        try:
            timeout = float(raw_timeout)
        except (TypeError, ValueError):
            timeout = 30.0
        if timeout <= 0:
            timeout = 30.0
        return cls(
            enabled=_enabled(os.getenv("ODYSSEUS_EVOLVING_AI_ENABLED")),
            base_url=os.getenv("ODYSSEUS_EVOLVING_AI_BASE_URL", "").strip(),
            model=os.getenv("ODYSSEUS_EVOLVING_AI_MODEL", "").strip(),
            api_key=os.getenv("ODYSSEUS_EVOLVING_AI_API_KEY", "").strip(),
            timeout_seconds=min(timeout, 300.0),
        )

    @property
    def ready(self) -> bool:
        if not self.enabled or not self.model:
            return False
        try:
            _chat_completions_url(self.base_url)
        except ValueError:
            return False
        return True

    @property
    def completions_url(self) -> str:
        return _chat_completions_url(self.base_url)

    def __repr__(self) -> str:
        return (
            "EvolvingAIConfig("
            f"enabled={self.enabled!r}, base_url={'<configured>' if self.base_url else ''!r}, "
            f"model={self.model!r}, api_key={'<redacted>' if self.api_key else ''!r}, "
            f"timeout_seconds={self.timeout_seconds!r})"
        )


class OpenAICompatibleClient:
    """Minimal async Chat Completions client for compatible providers.

    Pass a custom httpx transport in tests to avoid network calls. The default
    client verifies TLS normally and never includes response bodies in errors.
    """

    def __init__(
        self,
        config: EvolvingAIConfig | None = None,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        self.config = config or EvolvingAIConfig.from_env()
        self._transport = transport

    async def chat_completion(
        self,
        messages: Sequence[Mapping[str, Any]],
        *,
        model: str | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
    ) -> dict[str, Any]:
        config = self.config
        if not config.enabled:
            raise EvolvingAIError("Evolving inference is disabled")
        selected_model = str(model or config.model).strip()
        if not selected_model:
            raise EvolvingAIError("No evolving inference model is configured")
        if not messages:
            raise EvolvingAIError("At least one chat message is required")

        try:
            url = _chat_completions_url(config.base_url)
        except ValueError as exc:
            raise EvolvingAIError(str(exc)) from exc

        payload: dict[str, Any] = {
            "model": selected_model,
            "messages": [dict(message) for message in messages],
            "stream": False,
        }
        if temperature is not None:
            payload["temperature"] = temperature
        if max_tokens is not None and max_tokens > 0:
            payload["max_tokens"] = max_tokens

        headers = {"Accept": "application/json", "Content-Type": "application/json"}
        if config.api_key:
            headers["Authorization"] = f"Bearer {config.api_key}"

        try:
            async with httpx.AsyncClient(
                timeout=config.timeout_seconds,
                transport=self._transport,
            ) as client:
                response = await client.post(url, json=payload, headers=headers)
        except httpx.TimeoutException as exc:
            raise EvolvingAIError("Evolving inference request timed out") from exc
        except httpx.HTTPError as exc:
            raise EvolvingAIError("Could not connect to evolving inference endpoint") from exc

        if response.is_error:
            raise EvolvingAIError(
                f"Evolving inference endpoint returned HTTP {response.status_code}",
                status_code=response.status_code,
            )
        try:
            data = response.json()
        except ValueError as exc:
            raise EvolvingAIError("Evolving inference endpoint returned invalid JSON") from exc
        if not isinstance(data, dict) or not isinstance(data.get("choices"), list):
            raise EvolvingAIError("Evolving inference endpoint returned an unexpected response")
        return data
