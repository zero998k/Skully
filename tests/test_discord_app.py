import base64
from types import SimpleNamespace

import discord

from bot.config import ProviderConfig, Settings
from bot.discord_app import SkullyBot, build_user_turn, clean_text, fmt_usd, merge_turns


def make_settings(tmp_path, **overrides):
    values = dict(
        discord_token="x",
        providers=[ProviderConfig("gemini", "https://g.test", "k", ("m",))],
        bot_name="Skully",
        extra_personality="",
        history_messages=20,
        max_tool_steps=6,
        reasoning_effort="high",
        show_tool_trace=True,
        wake_words=("skully",),
        database_path=str(tmp_path / "bot.db"),
        coingecko_api_key="",
    )
    values.update(overrides)
    return Settings(**values)


class FakeAttachment:
    def __init__(self, filename, content_type, data):
        self.filename, self.content_type, self._data, self.size = filename, content_type, data, len(data)

    async def read(self):
        return self._data


def fake_message(content, mentions=(), role_mentions=(), channel_mentions=()):
    return SimpleNamespace(content=content, mentions=list(mentions), role_mentions=list(role_mentions),
                           channel_mentions=list(channel_mentions))


def test_clean_text_turns_mentions_into_names():
    friend = SimpleNamespace(id=22, display_name="Irnes")
    channel = SimpleNamespace(id=33, name="general")
    msg = fake_message("<@11> ask <@!22> about <#33> <:pepe:123>", mentions=[friend], channel_mentions=[channel])
    assert clean_text(msg, bot_id=11) == "ask @Irnes about #general :pepe:"


def test_merge_turns_joins_same_speaker():
    turns = [
        {"role": "user", "content": "[A]: hi"},
        {"role": "user", "content": "[B]: yo"},
        {"role": "assistant", "content": "hey both"},
    ]
    assert merge_turns(turns) == [
        {"role": "user", "content": "[A]: hi\n[B]: yo"},
        {"role": "assistant", "content": "hey both"},
    ]


async def test_build_user_turn_includes_images_and_text_files():
    png = b"\x89PNG fake"
    turn = await build_user_turn(
        "Zippe",
        "what's in these?",
        [
            FakeAttachment("chart.png", "image/png", png),
            FakeAttachment("bot.py", None, b"print('hi')"),
            FakeAttachment("song.mp3", "audio/mpeg", b"..."),
        ],
    )
    text_part, image_part = turn["content"]
    assert text_part["text"].startswith("[Zippe]: what's in these?")
    assert "print('hi')" in text_part["text"]
    assert "song.mp3 (audio/mpeg) that you can't open" in text_part["text"]
    assert image_part["image_url"]["url"] == "data:image/png;base64," + base64.b64encode(png).decode()


async def test_plain_text_turn():
    assert await build_user_turn("Irnes", "hi", []) == {"role": "user", "content": "[Irnes]: hi"}


def test_fmt_usd():
    assert fmt_usd(1_234_567_890) == "$1.23B"
    assert fmt_usd(5_500_000) == "$5.50M"
    assert fmt_usd(42.5) == "$42.50"
    assert fmt_usd(0.00001234) == "$0.00001234"
    assert fmt_usd(0.5) == "$0.5"
    assert fmt_usd(1.2e-12) == "$0.0000000000012"
    assert fmt_usd(0) == "$0"
    assert fmt_usd(None) == "—"


async def test_bot_builds_and_registers_slash_commands(tmp_path):
    bot = SkullyBot(make_settings(tmp_path))
    names = {c.name for c in bot.tree.get_commands()}
    assert names == {"ask", "reset", "autochat", "remember", "memories", "forget", "price", "market",
                     "summarize", "status", "help"}
    assert bot.intents.message_content
    assert bot._wake_re.match("Hey Skully, what's up?")
    assert bot._wake_re.match("skully what is 2+2")
    assert not bot._wake_re.match("I think skully is cool")
    await bot.web.aclose()
    await bot.llm.aclose()
    bot.storage.close()


async def test_should_respond_rules(tmp_path):
    bot = SkullyBot(make_settings(tmp_path))
    me = SimpleNamespace(id=1, roles=[])
    bot._connection.user = discord.ClientUser(state=bot._connection, data={
        "id": 1, "username": "Skully", "discriminator": "0", "avatar": None})
    guild = SimpleNamespace(me=me)

    def msg(content, mentions=(), guild=guild, reference=None, channel_id=50):
        return SimpleNamespace(content=content, mentions=list(mentions), role_mentions=[], guild=guild,
                               reference=reference, channel=SimpleNamespace(id=channel_id))

    assert bot._should_respond(msg("hi", guild=None))  # DM
    assert bot._should_respond(msg("hi", mentions=[bot.user]))
    assert bot._should_respond(msg("skully help"))
    assert not bot._should_respond(msg("just chatting"))
    bot.storage.set_autochat(50, True)
    assert bot._should_respond(msg("just chatting"))
    await bot.web.aclose()
    await bot.llm.aclose()
    bot.storage.close()


class FakeChannel:
    def __init__(self, history):
        self.id, self.name, self._history, self.sent = 50, "general", history, []

    def history(self, limit, before=None):
        async def gen():
            for m in reversed(self._history[-limit:]):  # Discord gives newest first
                yield m
        return gen()

    def typing(self):
        class Typing:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc):
                return False
        return Typing()

    async def send(self, content):
        self.sent.append(content)


async def test_on_message_end_to_end(tmp_path):
    import json

    import httpx

    from bot.llm import LLMChain

    bot = SkullyBot(make_settings(tmp_path, history_messages=10))
    bot._connection.user = discord.ClientUser(state=bot._connection, data={
        "id": 1, "username": "Skully", "discriminator": "0", "avatar": None})
    requests = []

    def handler(request: httpx.Request):
        requests.append(json.loads(request.content))
        if len(requests) == 1:
            call = {"id": "c", "type": "function",
                    "function": {"name": "calculate", "arguments": json.dumps({"expression": "3*7"})}}
            return httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "content": None,
                                                                      "tool_calls": [call]}}]})
        return httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "content": "21, easy."}}]})

    bot.llm = LLMChain([ProviderConfig("groq", "https://llm.test", "k", ("m",), discover_models=False)], "",
                       http=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    bot.agent.llm = bot.llm
    bot.storage.add_memory("guild:9", "Irnes is learning Python", "Irnes")

    irnes = SimpleNamespace(id=2, display_name="Irnes", bot=False)
    zippe = SimpleNamespace(id=3, display_name="Zippe", bot=False)

    def chat(msg_id, author, content):
        return SimpleNamespace(id=msg_id, author=author, content=content, type=discord.MessageType.default,
                               attachments=[], mentions=[], role_mentions=[], channel_mentions=[])

    old_bot_reply = chat(11, bot.user, "Sup!\n-# 🔎 searched \"x\"")
    channel = FakeChannel([chat(10, irnes, "yo skully"), old_bot_reply, chat(12, irnes, "zippe owes me money")])
    guild = SimpleNamespace(id=9, name="Skull HQ", me=SimpleNamespace(roles=[]))
    replies = []
    message = chat(13, zippe, "<@1> what's 3 times 7?")
    message.mentions = [bot.user]
    message.guild, message.channel, message.reference = guild, channel, None

    async def reply(content, mention_author):
        replies.append(content)
    message.reply = reply

    await bot.on_message(message)

    assert replies == ["21, easy.\n-# 🧮 calculated `3*7`"]
    convo = requests[0]["messages"]
    assert convo[0]["role"] == "system"
    assert 'the server "Skull HQ", channel #general' in convo[0]["content"]
    assert "[1] Irnes is learning Python" in convo[0]["content"]
    assert convo[1:] == [
        {"role": "user", "content": "[Irnes]: yo skully"},
        {"role": "assistant", "content": "Sup!"},
        {"role": "user", "content": "[Irnes]: zippe owes me money"},
        {"role": "user", "content": "[Zippe]: what's 3 times 7?"},
    ]

    bot.storage.set_reset(50, 11)  # like /reset after the bot's "Sup!"
    requests.clear()
    await bot.on_message(message)
    assert [m["content"] for m in requests[0]["messages"][1:]] == [
        "[Irnes]: zippe owes me money", "[Zippe]: what's 3 times 7?"]
    await bot.web.aclose()
    await bot.llm.aclose()
    bot.storage.close()
