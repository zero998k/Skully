import json

import httpx
import pytest

from bot.config import ProviderConfig
from bot.llm import AllProvidersFailed, LLMChain, pick_models, prepare_messages

GEMINI = ProviderConfig("gemini", "https://gemini.test/v1", "g-key", ("gemini-3-flash", "gemini-2.5-flash"), vision=True)
GROQ = ProviderConfig("groq", "https://groq.test/v1", "q-key", ("openai/gpt-oss-120b",))


def reply(text: str) -> dict:
    return {"choices": [{"message": {"role": "assistant", "content": text}}]}


class FakeClock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


def make_chain(handler, providers=(GEMINI, GROQ), effort="high", clock=None):
    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return LLMChain(list(providers), effort, http=http, clock=clock or FakeClock())


def test_pick_models_prefers_exact_then_versions_but_not_other_models():
    available = ["gemini-3-flash-preview", "gemini-3-flash-lite", "gemini-2.5-flash", "gemini-2.5-flash-001"]
    assert pick_models(("gemini-3-flash", "gemini-2.5-flash"), available) == ["gemini-3-flash-preview", "gemini-2.5-flash"]
    # nothing matches -> keep configured names and let the API decide
    assert pick_models(("mystery-model",), available) == ["mystery-model"]
    # no preference (e.g. local Ollama) -> whatever is installed
    assert pick_models((), ["llama3", "qwen3"]) == ["llama3", "qwen3"]


def test_prepare_messages_keeps_gemini_signatures_only_for_gemini_and_flattens_images():
    messages = [
        {"role": "user", "content": [{"type": "text", "text": "what is this"},
                                     {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAA"}}]},
        {
            "role": "assistant",
            "content": None,
            "reasoning": "secret thoughts",
            "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "calculate", "arguments": "{}"},
                            "extra_content": {"google": {"thought_signature": "sig"}}}],
        },
        {"role": "tool", "tool_call_id": "c1", "name": "calculate", "content": "4"},
    ]
    for_gemini = prepare_messages(messages, GEMINI)
    assert for_gemini[1]["tool_calls"][0]["extra_content"] == {"google": {"thought_signature": "sig"}}
    assert "reasoning" not in for_gemini[1]
    assert isinstance(for_gemini[0]["content"], list)  # Gemini can see images
    assert for_gemini[2]["name"] == "calculate"

    for_groq = prepare_messages(messages, GROQ)
    assert "extra_content" not in for_groq[1]["tool_calls"][0]
    assert "name" not in for_groq[2]
    assert "what is this" in for_groq[0]["content"] and "can't see images" in for_groq[0]["content"]


async def test_discovers_models_and_answers_from_first_provider():
    seen = []

    def handler(request: httpx.Request):
        if request.url.path.endswith("/models"):
            return httpx.Response(200, json={"data": [{"id": "models/gemini-3-flash-preview"}, {"id": "models/gemini-2.5-flash"}]})
        body = json.loads(request.content)
        seen.append((request.url.host, body["model"], body.get("reasoning_effort")))
        assert request.headers["authorization"] == "Bearer g-key"
        return httpx.Response(200, json=reply("hi"))

    chain = make_chain(handler)
    result = await chain.complete([{"role": "user", "content": "hello"}])
    assert result.message["content"] == "hi"
    assert result.label == "gemini/gemini-3-flash-preview"
    assert seen == [("gemini.test", "gemini-3-flash-preview", "high")]


async def test_rate_limit_falls_back_and_cools_down():
    clock = FakeClock()
    calls = []

    def handler(request: httpx.Request):
        if request.url.path.endswith("/models"):
            return httpx.Response(500)  # discovery failing is fine: configured names are used
        model = json.loads(request.content)["model"]
        calls.append(model)
        if request.url.host == "gemini.test":
            return httpx.Response(429, headers={"retry-after": "30"}, json={"error": "quota"})
        return httpx.Response(200, json=reply("from groq"))

    chain = make_chain(handler, clock=clock)
    result = await chain.complete([{"role": "user", "content": "hello"}])
    assert result.provider == "groq"
    assert calls == ["gemini-3-flash", "gemini-2.5-flash", "openai/gpt-oss-120b"]

    calls.clear()
    await chain.complete([{"role": "user", "content": "again"}])
    assert calls == ["openai/gpt-oss-120b"]  # Gemini models are still cooling down

    clock.now += 31
    calls.clear()
    await chain.complete([{"role": "user", "content": "later"}])
    assert calls[0] == "gemini-3-flash"  # cooldown over, Gemini is tried first again


async def test_retries_without_reasoning_effort_when_model_rejects_it():
    bodies = []

    def handler(request: httpx.Request):
        if request.url.path.endswith("/models"):
            return httpx.Response(404)
        body = json.loads(request.content)
        bodies.append(body)
        if "reasoning_effort" in body:
            return httpx.Response(400, json={"error": {"message": "unknown parameter reasoning_effort"}})
        return httpx.Response(200, json=reply("ok"))

    chain = make_chain(handler, providers=(GROQ,))
    assert (await chain.complete([{"role": "user", "content": "x"}])).message["content"] == "ok"
    assert [("reasoning_effort" in b) for b in bodies] == [True, False]
    bodies.clear()
    await chain.complete([{"role": "user", "content": "y"}])
    assert [("reasoning_effort" in b) for b in bodies] == [False]  # remembered


async def test_bad_key_skips_whole_provider_and_all_failing_raises():
    calls = []

    def handler(request: httpx.Request):
        if request.url.path.endswith("/models"):
            return httpx.Response(401)
        calls.append(request.url.host)
        return httpx.Response(401, json={"error": "bad key"})

    chain = make_chain(handler)
    with pytest.raises(AllProvidersFailed):
        await chain.complete([{"role": "user", "content": "x"}])
    assert calls == ["gemini.test", "groq.test"]  # only one model tried per bad provider


async def test_empty_200_response_moves_on():
    def handler(request: httpx.Request):
        if request.url.path.endswith("/models"):
            return httpx.Response(404)
        if request.url.host == "gemini.test":
            return httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "content": ""}}]})
        return httpx.Response(200, json=reply("backup"))

    chain = make_chain(handler)
    assert (await chain.complete([{"role": "user", "content": "x"}])).message["content"] == "backup"


async def test_no_providers_configured():
    chain = make_chain(lambda r: httpx.Response(500), providers=())
    with pytest.raises(AllProvidersFailed, match="No AI provider"):
        await chain.complete([{"role": "user", "content": "x"}])
