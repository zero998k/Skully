"""Settings for the Skully Discord bot, read from environment variables / a .env file."""

from __future__ import annotations

import os
from dataclasses import dataclass, field

from dotenv import load_dotenv

load_dotenv()


@dataclass(frozen=True)
class ProviderConfig:
    """One OpenAI-compatible chat API (Gemini, Groq, OpenRouter, Ollama, ...)."""

    name: str
    base_url: str
    api_key: str
    # Preferred models, best first. The first ones that actually exist on the
    # provider are used; the rest are kept as fallbacks for rate limits.
    models: tuple[str, ...]
    vision: bool = False
    # Ask the provider's /models endpoint which of `models` exist.
    discover_models: bool = True
    extra_headers: dict[str, str] = field(default_factory=dict)


def _env(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip()


def _env_int(name: str, default: int) -> int:
    try:
        return int(_env(name, str(default)))
    except ValueError:
        return default


def _env_bool(name: str, default: bool) -> bool:
    value = _env(name, "1" if default else "0").lower()
    return value in {"1", "true", "yes", "on"}


def _env_list(name: str, default: str) -> tuple[str, ...]:
    return tuple(x.strip() for x in _env(name, default).split(",") if x.strip())


def load_providers() -> list[ProviderConfig]:
    """Build the provider chain from whichever API keys are set, in PROVIDER_ORDER."""
    available: dict[str, ProviderConfig] = {}

    if key := _env("GEMINI_API_KEY"):
        available["gemini"] = ProviderConfig(
            name="gemini",
            base_url="https://generativelanguage.googleapis.com/v1beta/openai",
            api_key=key,
            models=_env_list(
                "GEMINI_MODELS",
                "gemini-3-flash,gemini-2.5-flash,gemini-3.1-flash-lite,gemini-2.5-flash-lite",
            ),
            vision=True,
        )

    if key := _env("GROQ_API_KEY"):
        available["groq"] = ProviderConfig(
            name="groq",
            base_url="https://api.groq.com/openai/v1",
            api_key=key,
            models=_env_list(
                "GROQ_MODELS",
                "openai/gpt-oss-120b,qwen/qwen3.8-27b,qwen/qwen3.6-27b,openai/gpt-oss-20b",
            ),
        )

    if key := _env("OPENROUTER_API_KEY"):
        available["openrouter"] = ProviderConfig(
            name="openrouter",
            base_url="https://openrouter.ai/api/v1",
            api_key=key,
            # openrouter/free picks a free model that supports tools/images as needed.
            models=_env_list("OPENROUTER_MODELS", "openrouter/free"),
            vision=True,
            discover_models=False,
            extra_headers={"X-Title": "Skully Discord Bot"},
        )

    if base_url := _env("CUSTOM_LLM_BASE_URL"):
        available["custom"] = ProviderConfig(
            name="custom",
            base_url=base_url.rstrip("/"),
            api_key=_env("CUSTOM_LLM_API_KEY", "none"),
            models=_env_list("CUSTOM_LLM_MODELS", ""),
            vision=_env_bool("CUSTOM_LLM_VISION", False),
        )

    order = _env_list("PROVIDER_ORDER", "gemini,groq,openrouter,custom")
    chain = [available[name] for name in order if name in available]
    # Anything configured but missing from PROVIDER_ORDER still goes on the end.
    chain += [p for name, p in available.items() if name not in order]
    return chain


@dataclass(frozen=True)
class Settings:
    discord_token: str
    providers: list[ProviderConfig]
    bot_name: str
    extra_personality: str
    history_messages: int
    max_tool_steps: int
    reasoning_effort: str
    show_tool_trace: bool
    wake_words: tuple[str, ...]
    database_path: str
    coingecko_api_key: str

    @classmethod
    def from_env(cls) -> "Settings":
        bot_name = _env("BOT_NAME", "Skully")
        return cls(
            discord_token=_env("DISCORD_TOKEN"),
            providers=load_providers(),
            bot_name=bot_name,
            extra_personality=_env("EXTRA_PERSONALITY"),
            history_messages=_env_int("HISTORY_MESSAGES", 20),
            max_tool_steps=_env_int("MAX_TOOL_STEPS", 6),
            reasoning_effort=_env("REASONING_EFFORT", "high"),
            show_tool_trace=_env_bool("SHOW_TOOL_TRACE", True),
            wake_words=_env_list("WAKE_WORDS", bot_name.lower()),
            database_path=_env("DATABASE_PATH", "skully.db"),
            coingecko_api_key=_env("COINGECKO_API_KEY"),
        )
