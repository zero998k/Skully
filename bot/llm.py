"""Talks to free OpenAI-compatible chat APIs, falling back down the chain on errors.

Every provider (Gemini, Groq, OpenRouter, a local Ollama...) speaks the same
`/chat/completions` format, so one client handles them all. When a model is
rate-limited or down, the next model/provider in the chain answers instead.
"""

from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass, field
from typing import Any, Callable

import httpx

from .config import ProviderConfig

log = logging.getLogger(__name__)

_MODEL_REFRESH_SECONDS = 6 * 60 * 60
_STANDARD_MESSAGE_KEYS = ("role", "content", "tool_calls", "tool_call_id", "name")


class AllProvidersFailed(Exception):
    """Every configured model failed or is cooling down after a rate limit."""


@dataclass
class Completion:
    message: dict[str, Any]
    provider: str
    model: str

    @property
    def label(self) -> str:
        return f"{self.provider}/{self.model}"


@dataclass
class _ProviderState:
    models: list[str] = field(default_factory=list)
    resolved_at: float = 0.0
    cooldown_until: float = 0.0


def pick_models(preferred: tuple[str, ...], available: list[str]) -> list[str]:
    """Map preferred model names onto the ids a provider really serves.

    "gemini-3-flash" matches "gemini-3-flash" exactly, or a versioned/preview id
    like "gemini-3-flash-preview" -- but not a different model such as
    "gemini-3-flash-lite".
    """
    if not preferred:
        return available[:3]
    picked: list[str] = []
    for pref in preferred:
        pattern = re.compile(re.escape(pref) + r"(-preview)?(-[0-9][0-9a-z-]*)?")
        matches = [m for m in available if pattern.fullmatch(m)]
        if matches:
            best = pref if pref in matches else min(matches, key=len)
            if best not in picked:
                picked.append(best)
    return picked or list(preferred)


def prepare_messages(messages: list[dict[str, Any]], provider: ProviderConfig) -> list[dict[str, Any]]:
    """Reduce messages to what `provider` accepts.

    Gemini needs its `extra_content` thought signatures echoed back on tool
    calls; other providers can reject unknown fields, so they get plain
    OpenAI-format messages. Image parts are swapped for a note when the
    provider can't see images.
    """
    is_gemini = provider.name == "gemini"
    out = []
    for msg in messages:
        clean = {k: msg[k] for k in _STANDARD_MESSAGE_KEYS if k in msg}
        if is_gemini and "extra_content" in msg:
            clean["extra_content"] = msg["extra_content"]
        if not (is_gemini and clean.get("role") == "tool"):
            clean.pop("name", None)
        if clean.get("tool_calls"):
            calls = []
            for call in clean["tool_calls"]:
                fn = call.get("function", {})
                plain = {
                    "id": call.get("id"),
                    "type": "function",
                    "function": {"name": fn.get("name"), "arguments": fn.get("arguments") or "{}"},
                }
                if is_gemini and "extra_content" in call:
                    plain["extra_content"] = call["extra_content"]
                calls.append(plain)
            clean["tool_calls"] = calls
        if isinstance(clean.get("content"), list) and not provider.vision:
            clean["content"] = _flatten_parts(clean["content"])
        out.append(clean)
    return out


def _flatten_parts(parts: list[dict[str, Any]]) -> str:
    texts, images = [], 0
    for part in parts:
        if part.get("type") == "text":
            texts.append(part.get("text", ""))
        elif part.get("type") == "image_url":
            images += 1
    if images:
        texts.append(f"[{images} image(s) attached, but the current model can't see images]")
    return "\n".join(t for t in texts if t)


def _retry_after(response: httpx.Response, default: float) -> float:
    try:
        return max(1.0, float(response.headers.get("retry-after", default)))
    except ValueError:
        return default


class LLMChain:
    def __init__(
        self,
        providers: list[ProviderConfig],
        reasoning_effort: str = "",
        http: httpx.AsyncClient | None = None,
        clock: Callable[[], float] = time.monotonic,
    ):
        self.providers = providers
        self.reasoning_effort = reasoning_effort
        self.http = http or httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=15.0))
        self.clock = clock
        self._state: dict[str, _ProviderState] = {p.name: _ProviderState() for p in providers}
        self._model_cooldown: dict[tuple[str, str], float] = {}
        # Models that rejected `reasoning_effort`; they get requests without it.
        self._no_extras: set[tuple[str, str]] = set()
        self.last_used: str | None = None

    async def aclose(self) -> None:
        await self.http.aclose()

    async def complete(self, messages: list[dict[str, Any]], tools: list[dict[str, Any]] | None = None) -> Completion:
        if not self.providers:
            raise AllProvidersFailed("No AI provider is configured. Add GEMINI_API_KEY (or another key) to .env.")
        errors: list[str] = []
        for provider in self.providers:
            state = self._state[provider.name]
            if state.cooldown_until > self.clock():
                errors.append(f"{provider.name}: cooling down")
                continue
            for model in await self._models_for(provider):
                if self._model_cooldown.get((provider.name, model), 0) > self.clock():
                    errors.append(f"{provider.name}/{model}: cooling down")
                    continue
                result = await self._try(provider, model, messages, tools, errors)
                if result is not None:
                    self.last_used = result.label
                    return result
                if state.cooldown_until > self.clock():
                    break  # whole provider is out (bad key etc.)
        raise AllProvidersFailed("; ".join(errors[-6:]) or "no models available")

    async def _try(self, provider, model, messages, tools, errors) -> Completion | None:
        key = (provider.name, model)
        body: dict[str, Any] = {"model": model, "messages": prepare_messages(messages, provider)}
        if tools:
            body["tools"] = tools
            body["tool_choice"] = "auto"
        use_extras = bool(self.reasoning_effort) and key not in self._no_extras
        if use_extras:
            body["reasoning_effort"] = self.reasoning_effort

        for attempt in range(2):
            try:
                response = await self.http.post(
                    f"{provider.base_url}/chat/completions",
                    json=body,
                    headers={"Authorization": f"Bearer {provider.api_key}", **provider.extra_headers},
                )
            except httpx.HTTPError as exc:
                errors.append(f"{provider.name}/{model}: {type(exc).__name__}")
                log.warning("%s/%s request failed: %r", provider.name, model, exc)
                return None

            status = response.status_code
            if status == 200:
                message = _first_message(response)
                if message is None:
                    errors.append(f"{provider.name}/{model}: empty or error response")
                    log.warning("%s/%s bad 200 body: %s", provider.name, model, response.text[:300])
                    return None
                return Completion(message=message, provider=provider.name, model=model)

            log.warning("%s/%s HTTP %s: %s", provider.name, model, status, response.text[:300])
            errors.append(f"{provider.name}/{model}: HTTP {status}")
            if status == 400 and use_extras and attempt == 0:
                # Maybe this model doesn't take reasoning_effort; retry once without it.
                body.pop("reasoning_effort", None)
                self._no_extras.add(key)
                use_extras = False
                continue
            if status == 429:
                self._model_cooldown[key] = self.clock() + _retry_after(response, 60.0)
            elif status in (401, 403):
                self._state[provider.name].cooldown_until = self.clock() + 3600
            elif status == 404:
                self._model_cooldown[key] = self.clock() + 3600
            elif status >= 500:
                self._model_cooldown[key] = self.clock() + 20
            return None
        return None

    async def _models_for(self, provider: ProviderConfig) -> list[str]:
        state = self._state[provider.name]
        if state.models and self.clock() - state.resolved_at < _MODEL_REFRESH_SECONDS:
            return state.models
        models = list(provider.models)
        if provider.discover_models:
            available = await self._list_models(provider)
            if available:
                models = pick_models(provider.models, available)
        state.models, state.resolved_at = models, self.clock()
        if models:
            log.info("%s models: %s", provider.name, ", ".join(models))
        return models

    async def _list_models(self, provider: ProviderConfig) -> list[str]:
        try:
            response = await self.http.get(
                f"{provider.base_url}/models",
                headers={"Authorization": f"Bearer {provider.api_key}", **provider.extra_headers},
                timeout=20.0,
            )
            response.raise_for_status()
            data = response.json().get("data", [])
            return [str(m["id"]).removeprefix("models/") for m in data if m.get("id")]
        except (httpx.HTTPError, ValueError, AttributeError) as exc:
            log.warning("Could not list %s models (%r); using configured names", provider.name, exc)
            return []

    def status_lines(self) -> list[str]:
        lines = []
        now = self.clock()
        for provider in self.providers:
            state = self._state[provider.name]
            models = state.models or list(provider.models) or ["(auto)"]
            parts = []
            for model in models:
                wait = self._model_cooldown.get((provider.name, model), 0) - now
                parts.append(f"{model} (rate-limited {int(wait)}s)" if wait > 0 else model)
            prefix = "⛔ " if state.cooldown_until > now else ""
            lines.append(f"{prefix}**{provider.name}**: {', '.join(parts)}")
        return lines


def _first_message(response: httpx.Response) -> dict[str, Any] | None:
    try:
        data = response.json()
    except ValueError:
        return None
    if isinstance(data, list):  # some Gemini errors come back wrapped in a list
        data = data[0] if data else {}
    if not isinstance(data, dict) or data.get("error"):
        return None
    choices = data.get("choices") or []
    if not choices or not isinstance(choices[0].get("message"), dict):
        return None
    message = dict(choices[0]["message"])
    message.setdefault("role", "assistant")
    if not message.get("content") and not message.get("tool_calls"):
        return None
    return message
