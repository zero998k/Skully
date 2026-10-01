"""SQLite storage: long-term memories and per-channel settings."""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone

MAX_MEMORIES_PER_SCOPE = 200
MAX_MEMORY_CHARS = 500


@dataclass(frozen=True)
class Memory:
    id: int
    content: str
    author: str
    created_at: str


@dataclass(frozen=True)
class ChannelSettings:
    autochat: bool = False
    # Messages at or before this message id are ignored as conversation history.
    reset_after: int = 0


class Storage:
    def __init__(self, path: str):
        self.db = sqlite3.connect(path)
        self.db.executescript(
            """
            CREATE TABLE IF NOT EXISTS memories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                scope TEXT NOT NULL,
                content TEXT NOT NULL,
                author TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS memories_scope ON memories(scope);
            CREATE TABLE IF NOT EXISTS channels (
                channel_id INTEGER PRIMARY KEY,
                autochat INTEGER NOT NULL DEFAULT 0,
                reset_after INTEGER NOT NULL DEFAULT 0
            );
            """
        )
        self.db.commit()

    def close(self) -> None:
        self.db.close()

    # ---- memories ----
    def add_memory(self, scope: str, content: str, author: str) -> int:
        content = " ".join(content.split())[:MAX_MEMORY_CHARS]
        if not content:
            raise ValueError("memory is empty")
        count = self.db.execute("SELECT COUNT(*) FROM memories WHERE scope = ?", (scope,)).fetchone()[0]
        if count >= MAX_MEMORIES_PER_SCOPE:
            raise ValueError(f"memory is full ({MAX_MEMORIES_PER_SCOPE} items); forget something first")
        cur = self.db.execute(
            "INSERT INTO memories (scope, content, author, created_at) VALUES (?, ?, ?, ?)",
            (scope, content, author, datetime.now(timezone.utc).strftime("%Y-%m-%d")),
        )
        self.db.commit()
        return int(cur.lastrowid)

    def list_memories(self, scope: str) -> list[Memory]:
        rows = self.db.execute(
            "SELECT id, content, author, created_at FROM memories WHERE scope = ? ORDER BY id",
            (scope,),
        ).fetchall()
        return [Memory(*row) for row in rows]

    def delete_memory(self, scope: str, memory_id: int) -> bool:
        cur = self.db.execute("DELETE FROM memories WHERE scope = ? AND id = ?", (scope, memory_id))
        self.db.commit()
        return cur.rowcount > 0

    def clear_memories(self, scope: str) -> int:
        cur = self.db.execute("DELETE FROM memories WHERE scope = ?", (scope,))
        self.db.commit()
        return cur.rowcount

    # ---- channels ----
    def channel(self, channel_id: int) -> ChannelSettings:
        row = self.db.execute(
            "SELECT autochat, reset_after FROM channels WHERE channel_id = ?", (channel_id,)
        ).fetchone()
        return ChannelSettings(bool(row[0]), int(row[1])) if row else ChannelSettings()

    def set_autochat(self, channel_id: int, enabled: bool) -> None:
        self.db.execute(
            "INSERT INTO channels (channel_id, autochat) VALUES (?, ?) "
            "ON CONFLICT(channel_id) DO UPDATE SET autochat = excluded.autochat",
            (channel_id, int(enabled)),
        )
        self.db.commit()

    def set_reset(self, channel_id: int, message_id: int) -> None:
        self.db.execute(
            "INSERT INTO channels (channel_id, reset_after) VALUES (?, ?) "
            "ON CONFLICT(channel_id) DO UPDATE SET reset_after = excluded.reset_after",
            (channel_id, message_id),
        )
        self.db.commit()
