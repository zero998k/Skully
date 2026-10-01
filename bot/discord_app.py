"""The Discord side: when to reply, building context from chat history, slash commands."""

from __future__ import annotations

import asyncio
import base64
import logging
import math
import re
from collections import defaultdict
from typing import Any

import discord
import httpx
from discord import app_commands

from .agent import Agent, AgentResult
from .config import Settings
from .llm import AllProvidersFailed, LLMChain
from .prompts import build_system_prompt
from .storage import Storage
from .text import split_message, strip_trace
from .tools import ToolBox, ToolContext, USER_AGENT

log = logging.getLogger(__name__)

IMAGE_TYPES = ("image/png", "image/jpeg", "image/webp")
TEXT_EXTENSIONS = (".txt", ".md", ".py", ".js", ".ts", ".json", ".csv", ".html", ".css", ".java", ".c", ".cpp",
                   ".cs", ".go", ".rs", ".rb", ".php", ".sh", ".yml", ".yaml", ".toml", ".ini", ".sql", ".log")
MAX_IMAGE_BYTES = 8_000_000
MAX_TEXT_FILE_BYTES = 200_000
CHAT_TYPES = (discord.MessageType.default, discord.MessageType.reply)
# History also includes slash command output, e.g. earlier /ask answers.
HISTORY_TYPES = CHAT_TYPES + (discord.MessageType.chat_input_command,)
INVITE_PERMISSIONS = discord.Permissions(
    view_channel=True,
    send_messages=True,
    send_messages_in_threads=True,
    read_message_history=True,
    embed_links=True,
    attach_files=True,
)


class SkullyBot(discord.Client):
    def __init__(self, settings: Settings):
        intents = discord.Intents.default()
        intents.message_content = True
        super().__init__(
            intents=intents,
            allowed_mentions=discord.AllowedMentions(everyone=False, roles=False, replied_user=False),
        )
        self.settings = settings
        self.tree = app_commands.CommandTree(self)
        self.storage = Storage(settings.database_path)
        self.web = httpx.AsyncClient(headers={"User-Agent": USER_AGENT}, timeout=20.0)
        self.llm = LLMChain(settings.providers, settings.reasoning_effort)
        self.toolbox = ToolBox(self.web, self.storage, settings.coingecko_api_key)
        self.agent = Agent(self.llm, self.toolbox, settings.max_tool_steps)
        self._channel_locks: dict[int, asyncio.Lock] = defaultdict(asyncio.Lock)
        self._ai_slots = asyncio.Semaphore(2)  # free tiers have low per-minute limits
        self._synced = False
        wake = "|".join(re.escape(w) for w in settings.wake_words) or re.escape(settings.bot_name.lower())
        self._wake_re = re.compile(rf"^\W*(?:hey|yo|ok|oi)?\W*(?:{wake})\b", re.IGNORECASE)
        register_commands(self)

    # ------------------------------------------------------------ lifecycle
    async def on_ready(self) -> None:
        assert self.user is not None
        log.info("Logged in as %s (id %s) in %d server(s)", self.user, self.user.id, len(self.guilds))
        log.info("AI chain: %s", " -> ".join(p.name for p in self.settings.providers))
        invite = discord.utils.oauth_url(
            self.user.id, permissions=INVITE_PERMISSIONS, scopes=("bot", "applications.commands")
        )
        log.info("Invite me to a server with: %s", invite)
        if not self._synced:
            self._synced = True
            for guild in self.guilds:
                await self._sync_commands(guild)

    async def on_guild_join(self, guild: discord.Guild) -> None:
        await self._sync_commands(guild)

    async def _sync_commands(self, guild: discord.Guild) -> None:
        # Syncing per server makes slash commands show up instantly (global sync can take an hour).
        try:
            self.tree.copy_global_to(guild=guild)
            await self.tree.sync(guild=guild)
            log.info("Slash commands ready in %s", guild.name)
        except discord.HTTPException as exc:
            log.warning("Couldn't sync slash commands in %s: %s", guild.name, exc)

    async def close(self) -> None:
        await self.web.aclose()
        await self.llm.aclose()
        self.storage.close()
        await super().close()

    # ------------------------------------------------------------ chat
    async def on_message(self, message: discord.Message) -> None:
        if message.author.bot or self.user is None or message.type not in CHAT_TYPES:
            return
        if not self._should_respond(message):
            return
        async with self._channel_locks[message.channel.id]:
            async with message.channel.typing():
                result = await self._answer_message(message)
            await send_chunks(message, format_result(result, self.settings.show_tool_trace))

    def _should_respond(self, message: discord.Message) -> bool:
        assert self.user is not None
        if message.guild is None:
            return True  # DMs
        if self.user in message.mentions:
            return True  # @mention, or a reply to one of the bot's messages
        ref = message.reference.resolved if message.reference else None
        if isinstance(ref, discord.Message) and ref.author == self.user:
            return True  # a reply to the bot with the ping turned off
        me = message.guild.me
        if me and any(role.is_bot_managed() and role in me.roles for role in message.role_mentions):
            return True  # someone picked the bot's role from the @ menu
        if self._wake_re.match(message.content):
            return True  # "skully, what's ..."
        return self.storage.channel(message.channel.id).autochat

    async def _answer_message(self, message: discord.Message) -> AgentResult:
        reply_note = ""
        if message.reference and isinstance(message.reference.resolved, discord.Message):
            ref = message.reference.resolved
            ref_text = strip_trace(clean_text(ref, self.user.id if self.user else 0))[:400]
            reply_note = f"(replying to {ref.author.display_name}: \"{ref_text}\")\n"
        text = clean_text(message, self.user.id if self.user else 0)
        current = await build_user_turn(message.author.display_name, reply_note + text, message.attachments)
        history = await self._history(message.channel, before=message)
        return await self._run_agent(message.guild, message.channel, message.author, history + [current])

    async def _run_agent(
        self,
        guild: discord.Guild | None,
        channel: Any,
        author: discord.abc.User,
        conversation: list[dict[str, Any]],
        use_tools: bool = True,
    ) -> AgentResult:
        scope = f"guild:{guild.id}" if guild else f"user:{author.id}"
        if guild:
            place = f'the server "{guild.name}", channel #{getattr(channel, "name", "?")}'
        else:
            place = f"a private DM with {author.display_name}"
        system = build_system_prompt(
            bot_name=self.settings.bot_name,
            place=place,
            memories=self.storage.list_memories(scope),
            extra_personality=self.settings.extra_personality,
        )
        ctx = ToolContext(memory_scope=scope, user_name=author.display_name)
        try:
            async with self._ai_slots:
                return await self.agent.run([{"role": "system", "content": system}] + conversation, ctx, use_tools)
        except AllProvidersFailed as exc:
            log.warning("All AI providers failed: %s", exc)
            return AgentResult(
                text="💀 My brain is out of free juice for a moment (every AI model is rate-limited or down). "
                "Try again in a minute. Adding a second free key (Groq or OpenRouter) to `.env` makes this rarer."
            )
        except Exception:
            log.exception("Agent crashed")
            return AgentResult(text="💀 Something broke on my end while thinking about that. Try again?")

    async def _history(self, channel: Any, before: Any = None) -> list[dict[str, Any]]:
        """Recent channel messages as chat turns, oldest first, since the last /reset."""
        limit = self.settings.history_messages
        if limit <= 0 or not hasattr(channel, "history"):
            return []
        reset_after = self.storage.channel(channel.id).reset_after
        turns: list[dict[str, Any]] = []
        try:
            async for msg in channel.history(limit=limit, before=before):
                if msg.id <= reset_after or msg.type not in HISTORY_TYPES:
                    continue
                if msg.author == self.user:
                    content = strip_trace(msg.content)
                    role = "assistant"
                else:
                    content = clean_text(msg, self.user.id if self.user else 0)
                    names = [a.filename for a in msg.attachments]
                    if names:
                        content += f" [attached: {', '.join(names)}]"
                    content = f"[{msg.author.display_name}]: {content.strip()}"
                    role = "user"
                if content.strip():
                    turns.append({"role": role, "content": content[:1500]})
        except (discord.Forbidden, discord.HTTPException) as exc:
            log.warning("Can't read history in %s: %s", getattr(channel, "id", "?"), exc)
            return []
        turns.reverse()
        return merge_turns(turns)


# ---------------------------------------------------------------- helpers
def clean_text(message: discord.Message, bot_id: int) -> str:
    """Message text with mentions turned into readable @names and the bot's own mention removed."""
    text = re.sub(rf"<@!?{bot_id}>", "", message.content)
    for user in message.mentions:
        text = re.sub(rf"<@!?{user.id}>", f"@{user.display_name}", text)
    for role in message.role_mentions:
        text = text.replace(f"<@&{role.id}>", "" if role.is_bot_managed() else f"@{role.name}")
    for channel in message.channel_mentions:
        text = text.replace(f"<#{channel.id}>", f"#{channel.name}")
    text = re.sub(r"<a?:(\w+):\d+>", r":\1:", text)  # custom emoji
    return text.strip()


def merge_turns(turns: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Join back-to-back messages from the same side into one turn (keeps providers happy)."""
    merged: list[dict[str, Any]] = []
    for turn in turns:
        if merged and merged[-1]["role"] == turn["role"]:
            merged[-1] = {**merged[-1], "content": merged[-1]["content"] + "\n" + turn["content"]}
        else:
            merged.append(dict(turn))
    return merged


async def build_user_turn(author_name: str, text: str, attachments: list[discord.Attachment]) -> dict[str, Any]:
    """The current message as a chat turn, with images and small text files included."""
    notes: list[str] = []
    images: list[dict[str, Any]] = []
    for att in attachments[:6]:
        content_type = (att.content_type or "").split(";")[0].lower()
        try:
            if content_type in IMAGE_TYPES and att.size <= MAX_IMAGE_BYTES and len(images) < 4:
                data = base64.b64encode(await att.read()).decode()
                images.append({"type": "image_url", "image_url": {"url": f"data:{content_type};base64,{data}"}})
                notes.append(f"[image: {att.filename}]")
            elif (content_type.startswith("text/") or att.filename.lower().endswith(TEXT_EXTENSIONS)) and (
                att.size <= MAX_TEXT_FILE_BYTES
            ):
                body = (await att.read()).decode("utf-8", errors="replace")[:20_000]
                notes.append(f"[file {att.filename}]\n```\n{body}\n```")
            else:
                notes.append(f"[file {att.filename} ({content_type or 'unknown type'}) that you can't open]")
        except discord.HTTPException:
            notes.append(f"[file {att.filename} couldn't be downloaded]")
    body_text = f"[{author_name}]: {text}".strip()
    if notes:
        body_text += "\n" + "\n".join(notes)
    if images:
        return {"role": "user", "content": [{"type": "text", "text": body_text}, *images]}
    return {"role": "user", "content": body_text}


def format_result(result: AgentResult, show_trace: bool) -> str:
    text = result.text or "🤔 I came up empty on that one. Try asking another way?"
    if show_trace and result.trace:
        text += "\n-# " + " · ".join(result.trace)
    return text


async def send_chunks(message: discord.Message, text: str) -> None:
    for i, chunk in enumerate(split_message(text)):
        try:
            if i == 0:
                await message.reply(chunk, mention_author=False)
            else:
                await message.channel.send(chunk)
        except discord.HTTPException:
            await message.channel.send(chunk)  # original message was probably deleted


async def send_followups(interaction: discord.Interaction, text: str, ephemeral: bool = False) -> None:
    for chunk in split_message(text):
        await interaction.followup.send(chunk, ephemeral=ephemeral)


def fmt_usd(value: float | None) -> str:
    if value is None:
        return "—"
    if value >= 1_000_000_000:
        return f"${value / 1_000_000_000:,.2f}B"
    if value >= 1_000_000:
        return f"${value / 1_000_000:,.2f}M"
    if value >= 1:
        return f"${value:,.2f}"
    if value <= 0:
        return "$0"
    decimals = 3 - math.floor(math.log10(value))  # 4 significant digits for tiny meme-coin prices
    return f"${value:.{decimals}f}".rstrip("0").rstrip(".")


def fmt_change(change: float | None) -> str:
    if change is None:
        return "—"
    return f"{'🟢' if change >= 0 else '🔴'} {change:+.2f}%"


def scope_for(interaction: discord.Interaction) -> str:
    return f"guild:{interaction.guild_id}" if interaction.guild_id else f"user:{interaction.user.id}"


# ---------------------------------------------------------------- slash commands
def register_commands(bot: SkullyBot) -> None:
    tree = bot.tree

    @tree.command(name="ask", description="Ask Skully anything (it can search the web, see images, do math…)")
    @app_commands.describe(question="Your question", image="Optional image to look at", private="Only you see the answer")
    async def ask(
        interaction: discord.Interaction,
        question: str,
        image: discord.Attachment | None = None,
        private: bool = False,
    ) -> None:
        await interaction.response.defer(thinking=True, ephemeral=private)
        turn = await build_user_turn(interaction.user.display_name, question, [image] if image else [])
        history = [] if private else await bot._history(interaction.channel)
        result = await bot._run_agent(interaction.guild, interaction.channel, interaction.user, history + [turn])
        answer = format_result(result, bot.settings.show_tool_trace)
        await send_followups(interaction, f"> {question[:300]}\n{answer}", ephemeral=private)

    @tree.command(name="reset", description="Forget this channel's conversation so far (memories are kept)")
    async def reset(interaction: discord.Interaction) -> None:
        bot.storage.set_reset(interaction.channel_id or 0, interaction.id)
        await interaction.response.send_message(
            "🧹 Fresh start! I've forgotten the conversation in this channel. "
            "Long-term memories stay; see `/memories`."
        )

    @tree.command(name="autochat", description="Make Skully reply to every message in this channel (or stop)")
    @app_commands.describe(enabled="On: reply to everything here. Off: only when mentioned or named.")
    async def autochat(interaction: discord.Interaction, enabled: bool) -> None:
        bot.storage.set_autochat(interaction.channel_id or 0, enabled)
        if enabled:
            msg = "💬 Autochat **on**: I'll reply to every message in this channel."
        else:
            msg = f"🤫 Autochat **off**: mention me, reply to me, or start with \"{bot.settings.bot_name}\"."
        await interaction.response.send_message(msg)

    @tree.command(name="remember", description="Save something to Skully's long-term memory")
    async def remember(interaction: discord.Interaction, fact: str) -> None:
        try:
            memory_id = bot.storage.add_memory(scope_for(interaction), fact, interaction.user.display_name)
        except ValueError as exc:
            await interaction.response.send_message(f"Couldn't save that: {exc}", ephemeral=True)
            return
        await interaction.response.send_message(f"🧠 Got it (memory #{memory_id}): {fact[:300]}")

    @tree.command(name="memories", description="Show what Skully remembers here")
    async def memories(interaction: discord.Interaction) -> None:
        items = bot.storage.list_memories(scope_for(interaction))
        if not items:
            await interaction.response.send_message("🧠 I don't remember anything here yet.", ephemeral=True)
            return
        await interaction.response.defer(ephemeral=True)
        lines = [f"`#{m.id}` {m.content} — *{m.author}, {m.created_at}*" for m in items]
        await send_followups(interaction, "🧠 **What I remember:**\n" + "\n".join(lines), ephemeral=True)

    @tree.command(name="forget", description="Delete one of Skully's memories by its number (see /memories)")
    async def forget(interaction: discord.Interaction, memory_id: int) -> None:
        if bot.storage.delete_memory(scope_for(interaction), memory_id):
            await interaction.response.send_message(f"🗑️ Forgot memory #{memory_id}.")
        else:
            await interaction.response.send_message(f"No memory #{memory_id} here.", ephemeral=True)

    @tree.command(name="price", description="Live crypto prices + Skully signal (e.g. btc, pepe, bonk)")
    @app_commands.describe(coins="Comma-separated names or tickers")
    async def price(interaction: discord.Interaction, coins: str) -> None:
        await interaction.response.defer(thinking=True)
        names = [c.strip() for c in re.split(r"[,\s]+", coins) if c.strip()]
        try:
            data, _ = await bot.toolbox.crypto_price(names)
        except Exception as exc:
            await interaction.followup.send(f"📉 Couldn't get prices: {exc}")
            return
        lines = []
        for coin in data["coins"]:
            lines.append(
                f"**{coin['query'].upper()}** (`{coin['coingecko_id']}`) — **{fmt_usd(coin['price_usd'])}** "
                f"· {fmt_change(coin['change_24h_pct'])} 24h\n"
                f"  Vol {fmt_usd(coin['volume_24h_usd'])} · MCap {fmt_usd(coin['market_cap_usd'])} "
                f"· Signal **{coin['skully_signal']}** — {' • '.join(coin['signal_reasons'])}"
            )
        if data.get("not_found"):
            lines.append(f"❓ Couldn't find: {', '.join(data['not_found'])}")
        lines.append("-# Data: CoinGecko · Skully signal is a simple heuristic, not financial advice")
        await send_followups(interaction, "\n".join(lines))

    @tree.command(name="market", description="Crypto Fear & Greed + what's trending right now")
    async def market(interaction: discord.Interaction) -> None:
        await interaction.response.defer(thinking=True)
        data, _ = await bot.toolbox.crypto_market_overview()
        fng = data.get("fear_greed_index")
        lines = [
            f"😱 **Fear & Greed:** {fng['value']} — {fng['label']}"
            if isinstance(fng, dict)
            else "😱 Fear & Greed: unavailable"
        ]
        trending = data.get("trending_on_coingecko")
        if isinstance(trending, list) and trending:
            lines.append("🔥 **Trending on CoinGecko:**")
            for i, coin in enumerate(trending, 1):
                rank = f"#{coin['market_cap_rank']}" if coin.get("market_cap_rank") else "unranked"
                lines.append(
                    f"{i}. **{coin['symbol']}** {coin['name']} ({rank}) · {fmt_usd(coin.get('price_usd'))} "
                    f"· {fmt_change(coin.get('change_24h_pct'))}"
                )
        else:
            lines.append(f"🔥 Trending: {trending}")
        await send_followups(interaction, "\n".join(lines))

    @tree.command(name="summarize", description="Summarize the recent conversation in this channel")
    @app_commands.describe(messages="How many recent messages to read (10-200)")
    async def summarize(interaction: discord.Interaction, messages: app_commands.Range[int, 10, 200] = 50) -> None:
        await interaction.response.defer(thinking=True)
        channel = interaction.channel
        lines = []
        try:
            async for msg in channel.history(limit=messages):  # type: ignore[union-attr]
                if msg.type in HISTORY_TYPES and msg.content.strip():
                    text = strip_trace(clean_text(msg, bot.user.id if bot.user else 0))
                    lines.append(f"[{msg.author.display_name}]: {text[:800]}")
        except (AttributeError, discord.HTTPException):
            await interaction.followup.send("I can't read this channel's history.")
            return
        if not lines:
            await interaction.followup.send("Nothing to summarize yet.")
            return
        lines.reverse()
        request = {
            "role": "user",
            "content": "Summarize this Discord conversation: the main topics, decisions, open questions and "
            "anything someone needs to follow up on. Be concise and use bullets.\n\n" + "\n".join(lines),
        }
        result = await bot._run_agent(interaction.guild, channel, interaction.user, [request], use_tools=False)
        await send_followups(interaction, format_result(result, False))

    @tree.command(name="status", description="Which AI models Skully is using right now")
    async def status(interaction: discord.Interaction) -> None:
        lines = ["🧠 **AI chain** (first available answers):", *bot.llm.status_lines()]
        lines.append(f"Last answer came from: `{bot.llm.last_used or 'nothing yet'}`")
        autochat_on = bot.storage.channel(interaction.channel_id or 0).autochat
        lines.append(f"Autochat in this channel: {'on' if autochat_on else 'off'}")
        await interaction.response.send_message("\n".join(lines), ephemeral=True)

    @tree.command(name="help", description="What Skully can do")
    async def help_command(interaction: discord.Interaction) -> None:
        name = bot.settings.bot_name
        await interaction.response.send_message(
            f"""💀 **{name}**: your server's AI.
**Talk to me:** @mention me, reply to my message, start with "{name}, …", or DM me. `/autochat` makes me reply to everything in a channel.
**I can:** search the web and read links · look at images · read code/text files you attach · do exact math · check live crypto prices · remember things about you.
**Commands:** `/ask` · `/price` · `/market` · `/summarize` · `/remember` · `/memories` · `/forget` · `/reset` · `/autochat` · `/status`""",
            ephemeral=True,
        )
