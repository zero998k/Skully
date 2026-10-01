"""Start the bot: `python -m bot`."""

from __future__ import annotations

import logging
import sys

import discord

from .config import Settings
from .discord_app import SkullyBot


def main() -> int:
    settings = Settings.from_env()
    if not settings.discord_token:
        print("❌ DISCORD_TOKEN is missing. Copy .env.example to .env and paste your bot token in (see README.md).")
        return 1
    if not settings.providers:
        print("❌ No AI key found. Put a free GEMINI_API_KEY (or GROQ_API_KEY / OPENROUTER_API_KEY) in .env.")
        return 1

    discord.utils.setup_logging(level=logging.INFO)
    bot = SkullyBot(settings)
    try:
        bot.run(settings.discord_token, log_handler=None)
    except discord.LoginFailure:
        print("❌ Discord rejected the token. Reset it in the Developer Portal (Bot tab) and update .env.")
        return 1
    except discord.PrivilegedIntentsRequired:
        print(
            "❌ Turn on MESSAGE CONTENT INTENT: Developer Portal → your app → Bot → "
            "Privileged Gateway Intents → Message Content Intent → Save. Then start the bot again."
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
