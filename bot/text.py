"""Text helpers for Discord: splitting long replies and cleaning history."""

from __future__ import annotations

import re

DISCORD_LIMIT = 2000
_FENCE = re.compile(r"^\s*```(\S*)")


def split_message(text: str, limit: int = DISCORD_LIMIT) -> list[str]:
    """Split text into Discord-sized chunks on line breaks, keeping code blocks intact.

    If a chunk ends inside a ``` block, the block is closed there and reopened
    (with the same language) at the start of the next chunk.
    """
    text = text.strip()
    if not text:
        return []
    budget = limit - 16  # room to close/reopen a code fence
    chunks: list[str] = []
    current = ""
    fence_lang: str | None = None  # language of the open code block, if any

    def flush() -> None:
        nonlocal current
        body = current.rstrip("\n")
        if body.strip():
            chunks.append(body + ("\n```" if fence_lang is not None else ""))
        current = f"```{fence_lang}\n" if fence_lang is not None else ""

    for line in _pieces(text, budget):
        if len(current) + len(line) > budget:
            flush()
        current += line
        match = _FENCE.match(line)
        if match:
            fence_lang = None if fence_lang is not None else match.group(1)
    if current.strip() and current.strip() != f"```{fence_lang}":
        chunks.append(current.rstrip("\n"))
    return chunks


def _pieces(text: str, budget: int) -> list[str]:
    """Lines (with their newline), with any line longer than `budget` hard-split."""
    pieces = []
    for line in text.splitlines(keepends=True):
        while len(line) > budget:
            cut = line.rfind(" ", 0, budget)
            cut = cut if cut > budget // 2 else budget
            pieces.append(line[:cut])
            line = line[cut:]
        pieces.append(line)
    return pieces


def strip_trace(text: str) -> str:
    """Remove the small `-# 🔎 ...` tool trace lines the bot adds under its replies."""
    return "\n".join(line for line in text.splitlines() if not line.startswith("-# ")).strip()
