"""Offline tests for the opt-in evolving-intelligence inference adapter."""
import json

import httpx
import pytest

from src.evolving_intelligence import (
    EvolvingAIConfig,
    EvolvingAIError,
    OpenAICompatibleClient,
    _chat_completions_url,
)


def test_normalizes_openai_compatible_urls():
    assert _chat_completions_url("https://api.example.test") == (
        "https://api.example.test/v1/chat/completions"
    )
    assert _chat_completions_url("https://api.example.test/custom/v1/") == (
        "https://api.example.test/custom/v1/chat/completions"
    )
    assert _chat_completions_url("http://localhost:8000/v1/chat/completions") == (
        "http://localhost:8000/v1/chat/completions"
    )


@pytest.mark.parametrize(
    "url",
    [
        "",
        "not-a-url",
        "ftp://api.example.test",
        "https://user:password@api.example.test/v1",
        "https://api.example.test/v1?token=secret",
    ],
)
def test_rejects_invalid_or_credential_bearing_urls(url):
    with pytest.raises(ValueError):
        _chat_completions_url(url)


def test_environment_config_is_disabled_by_default(monkeypatch):
    for key in (
        "ODYSSEUS_EVOLVING_AI_ENABLED",
        "ODYSSEUS_EVOLVING_AI_BASE_URL",
        "ODYSSEUS_EVOLVING_AI_MODEL",
        "ODYSSEUS_EVOLVING_AI_API_KEY",
    ):
        monkeypatch.delenv(key, raising=False)
    config = EvolvingAIConfig.from_env()
    assert config.enabled is False
    assert config.ready is False
    assert config.api_key == ""


@pytest.mark.asyncio
async def test_client_sends_compatible_payload_and_bearer_key():
    seen = {}

    async def handler(request):
        seen["url"] = str(request.url)
        seen["headers"] = dict(request.headers)
        seen["payload"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={"choices": [{"message": {"role": "assistant", "content": "hello"}}]},
        )

    config = EvolvingAIConfig(
        enabled=True,
        base_url="https://provider.example.test/v1",
        model="free-model",
        api_key="test-secret",
        timeout_seconds=5,
    )
    client = OpenAICompatibleClient(config, transport=httpx.MockTransport(handler))
    result = await client.chat_completion(
        [{"role": "user", "content": "hi"}], temperature=0.2, max_tokens=64
    )

    assert seen["url"] == "https://provider.example.test/v1/chat/completions"
    assert seen["headers"]["authorization"] == "Bearer test-secret"
    assert seen["payload"] == {
        "model": "free-model",
        "messages": [{"role": "user", "content": "hi"}],
        "stream": False,
        "temperature": 0.2,
        "max_tokens": 64,
    }
    assert result["choices"][0]["message"]["content"] == "hello"


@pytest.mark.asyncio
async def test_client_does_not_call_provider_when_disabled():
    client = OpenAICompatibleClient(
        EvolvingAIConfig(enabled=False, base_url="https://provider.example.test", model="m")
    )
    with pytest.raises(EvolvingAIError, match="disabled"):
        await client.chat_completion([{"role": "user", "content": "hi"}])


@pytest.mark.asyncio
async def test_provider_error_does_not_leak_response_body():
    async def handler(request):
        return httpx.Response(401, text="private-provider-error-and-secret")

    client = OpenAICompatibleClient(
        EvolvingAIConfig(
            enabled=True,
            base_url="https://provider.example.test/v1",
            model="m",
            api_key="test-secret",
        ),
        transport=httpx.MockTransport(handler),
    )
    with pytest.raises(EvolvingAIError) as caught:
        await client.chat_completion([{"role": "user", "content": "hi"}])
    assert caught.value.status_code == 401
    assert "private-provider-error" not in str(caught.value)
    assert "test-secret" not in repr(client.config)
