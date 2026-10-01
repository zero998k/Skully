import json
import math

import httpx
import pytest

from bot.storage import Storage
from bot.tools import ToolBox, ToolContext, ToolError, _check_public_url, html_to_text, safe_eval, skully_signal

CTX = ToolContext(memory_scope="guild:1", user_name="Zippe")


def make_toolbox(handler=None, tmp_path=None):
    http = httpx.AsyncClient(transport=httpx.MockTransport(handler or (lambda r: httpx.Response(404))))
    return ToolBox(http, Storage(str(tmp_path / "t.db") if tmp_path else ":memory:"))


def test_safe_eval_math():
    assert safe_eval("(1.5e6 * 0.07) / 12") == pytest.approx(8750.0)
    assert safe_eval("2^10") == 1024
    assert safe_eval("sqrt(2) * pi") == pytest.approx(math.sqrt(2) * math.pi)
    assert safe_eval("factorial(20)") == 2432902008176640000
    assert safe_eval("max(3, 7, -1) % 4") == 3


@pytest.mark.parametrize(
    "expression",
    ["__import__('os').system('ls')", "open('x')", "9**9**9", "factorial(5000)", "().__class__", "lambda: 1", "x"],
)
def test_safe_eval_rejects_dangerous_or_huge(expression):
    with pytest.raises((ValueError, SyntaxError)):
        safe_eval(expression)


def test_skully_signal_matches_dashboard_logic():
    assert skully_signal(20, 10_000_000) == ("Buy", 85, ["Strong pump (+20.0%)", "High trading volume"])
    assert skully_signal(-20, 0)[0] == "Sell"
    assert skully_signal(1, 0) == ("Hold", 50, ["Neutral price action"])
    assert skully_signal(None, None) == ("Hold", 50, ["Not enough data"])


def test_html_to_text_drops_scripts_and_nav():
    title, text = html_to_text(
        "<html><head><title>Hi</title><script>evil()</script></head>"
        "<body><nav>menu</nav><article><h1>Story</h1><p>Body text</p></article></body></html>"
    )
    assert title == "Hi"
    assert "Story" in text and "Body text" in text
    assert "evil" not in text and "menu" not in text


@pytest.mark.parametrize("url", ["http://127.0.0.1/admin", "http://192.168.1.1/", "http://[::1]/", "file:///etc/passwd", "localhost"])
async def test_private_urls_are_refused(url):
    with pytest.raises(ToolError):
        await _check_public_url(url)


async def test_read_webpage_follows_safe_redirect_and_extracts_text():
    def handler(request: httpx.Request):
        if request.url.path == "/start":
            return httpx.Response(302, headers={"location": "/article"})
        return httpx.Response(
            200,
            headers={"content-type": "text/html; charset=utf-8"},
            text="<html><title>News</title><body><main><p>Big news today</p></main></body></html>",
        )

    box = make_toolbox(handler)
    result, trace = await box.read_webpage("http://8.8.8.8/start")
    assert result["url"] == "http://8.8.8.8/article"
    assert result["title"] == "News" and "Big news today" in result["text"]
    assert "8.8.8.8" in trace


async def test_read_webpage_blocks_redirect_to_private_address():
    box = make_toolbox(lambda r: httpx.Response(302, headers={"location": "http://10.0.0.1/secret"}))
    text, _ = await box.call("read_webpage", json.dumps({"url": "http://8.8.8.8/x"}), CTX)
    assert "private or local" in json.loads(text)["error"]


async def test_read_webpage_gives_up_on_redirect_loops():
    box = make_toolbox(lambda r: httpx.Response(302, headers={"location": "/again"}))
    text, _ = await box.call("read_webpage", json.dumps({"url": "http://8.8.8.8/x"}), CTX)
    assert json.loads(text)["error"] == "too many redirects"


async def test_crypto_price_resolves_tickers_by_market_cap_rank():
    def handler(request: httpx.Request):
        if request.url.path.endswith("/search"):
            assert request.url.params["query"] == "pepe"
            return httpx.Response(200, json={"coins": [
                {"id": "pepe-scam", "symbol": "PEPE", "name": "Pepe Scam", "market_cap_rank": None},
                {"id": "pepe", "symbol": "PEPE", "name": "Pepe", "market_cap_rank": 30},
            ]})
        if request.url.path.endswith("/simple/price"):
            assert request.url.params["ids"] == "pepe"
            return httpx.Response(200, json={"pepe": {
                "usd": 0.00001, "usd_24h_change": 16.0, "usd_24h_vol": 9e8, "usd_market_cap": 4e9}})
        return httpx.Response(404)

    box = make_toolbox(handler)
    data, trace = await box.crypto_price(["$PEPE"])
    coin = data["coins"][0]
    assert coin["coingecko_id"] == "pepe"
    assert coin["skully_signal"] == "Buy (85% confidence)"
    assert "not financial advice" in data["note"]


async def test_crypto_price_reports_rate_limit_to_ai():
    box = make_toolbox(lambda r: httpx.Response(429))
    text, trace = await box.call("crypto_price", json.dumps({"coins": ["btc"]}), CTX)
    assert "rate limit" in json.loads(text)["error"]
    assert trace is None


async def test_memory_tools_round_trip(tmp_path):
    box = make_toolbox(tmp_path=tmp_path)
    text, trace = await box.call("remember", json.dumps({"fact": "Irnes's favourite coin is BONK"}), CTX)
    memory_id = json.loads(text)["memory_id"]
    assert trace == "🧠 saved to memory"
    assert [m.content for m in box.storage.list_memories("guild:1")] == ["Irnes's favourite coin is BONK"]
    assert box.storage.list_memories("guild:2") == []  # other servers can't see it
    text, _ = await box.call("forget_memory", json.dumps({"memory_id": memory_id}), CTX)
    assert json.loads(text) == {"deleted": True}


async def test_bad_tool_calls_return_errors_instead_of_crashing():
    box = make_toolbox()
    assert "unknown tool" in (await box.call("hack", "{}", CTX))[0]
    assert "invalid arguments" in (await box.call("calculate", "not json", CTX))[0]
    assert "bad arguments" in (await box.call("calculate", json.dumps({"nope": 1}), CTX))[0]
    assert "can't calculate" in (await box.call("calculate", json.dumps({"expression": "1/0"}), CTX))[0]
    assert "unknown timezone" in (await box.call("current_time", json.dumps({"timezone": "Mars/Base"}), CTX))[0]


async def test_web_search_uses_ddgs(monkeypatch):
    import ddgs

    class FakeDDGS:
        def text(self, query, max_results):
            return [{"title": "T", "href": "https://example.com", "body": "snippet about " + query}]

    monkeypatch.setattr(ddgs, "DDGS", FakeDDGS)
    box = make_toolbox()
    result, trace = await box.web_search("discord.py version")
    assert result["results"][0] == {"title": "T", "url": "https://example.com", "snippet": "snippet about discord.py version"}
    assert trace == '🔎 searched "discord.py version"'
