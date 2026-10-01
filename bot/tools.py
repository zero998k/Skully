"""Tools the AI can call: web search, reading pages, crypto data, math, time, memory."""

from __future__ import annotations

import ast
import asyncio
import ipaddress
import json
import logging
import math
import operator
import re
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Awaitable, Callable
from urllib.parse import urljoin, urlparse
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx
from bs4 import BeautifulSoup

from .storage import Storage

log = logging.getLogger(__name__)

MAX_TOOL_RESULT_CHARS = 8000
MAX_PAGE_BYTES = 2_000_000
USER_AGENT = "Mozilla/5.0 (compatible; SkullyBot/1.0; Discord assistant)"
COINGECKO = "https://api.coingecko.com/api/v3"


@dataclass(frozen=True)
class ToolContext:
    memory_scope: str  # "guild:<id>" or "user:<id>" for DMs
    user_name: str


class ToolError(Exception):
    """A tool failed in a way the AI should hear about."""


def _fn(name: str, description: str, properties: dict[str, Any], required: list[str]) -> dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {"type": "object", "properties": properties, "required": required},
        },
    }


TOOL_SCHEMAS: list[dict[str, Any]] = [
    _fn(
        "web_search",
        "Search the web (DuckDuckGo). Use for anything recent, factual, or that you're unsure about: "
        "news, sports, releases, people, prices of things, documentation. Then read_webpage for details.",
        {
            "query": {"type": "string", "description": "Search query"},
            "news": {"type": "boolean", "description": "Search recent news articles instead of the general web"},
        },
        ["query"],
    ),
    _fn(
        "read_webpage",
        "Fetch a web page and return its readable text. Use after web_search, or when someone shares a link.",
        {"url": {"type": "string", "description": "Full http(s) URL"}},
        ["url"],
    ),
    _fn(
        "crypto_price",
        "Live crypto prices from CoinGecko (USD price, 24h change, volume, market cap) plus the simple "
        "Skully signal heuristic. Accepts names, tickers or CoinGecko ids, e.g. ['btc', 'pepe', 'dogwifhat'].",
        {"coins": {"type": "array", "items": {"type": "string"}, "description": "Up to 10 coins"}},
        ["coins"],
    ),
    _fn(
        "crypto_market_overview",
        "Current crypto market mood: the Fear & Greed index and the coins trending on CoinGecko right now.",
        {},
        [],
    ),
    _fn(
        "calculate",
        "Evaluate a math expression exactly, e.g. '(1.5e6 * 0.07) / 12' or 'sqrt(2) * pi'. Supports + - * / // % **, "
        "and sqrt, log, log10, log2, exp, sin, cos, tan, asin, acos, atan, floor, ceil, round, abs, factorial, "
        "min, max, pi, e. Use it instead of doing arithmetic in your head.",
        {"expression": {"type": "string"}},
        ["expression"],
    ),
    _fn(
        "current_time",
        "Current date and time in a timezone.",
        {"timezone": {"type": "string", "description": "IANA name like 'Europe/Berlin' or 'America/New_York'"}},
        [],
    ),
    _fn(
        "remember",
        "Save a fact to long-term memory for this server (or DM), e.g. a preference, birthday, ongoing plan. "
        "Use when someone asks you to remember something or shares something lasting about themselves.",
        {"fact": {"type": "string", "description": "One self-contained fact, including who it's about"}},
        ["fact"],
    ),
    _fn(
        "forget_memory",
        "Delete one long-term memory by its id (ids are shown in your memory list).",
        {"memory_id": {"type": "integer"}},
        ["memory_id"],
    ),
]


class ToolBox:
    def __init__(self, http: httpx.AsyncClient, storage: Storage, coingecko_api_key: str = ""):
        self.http = http
        self.storage = storage
        self.coingecko_headers = {"x-cg-demo-api-key": coingecko_api_key} if coingecko_api_key else {}
        self._coin_ids: dict[str, str] = {}
        self._handlers: dict[str, Callable[..., Awaitable[tuple[Any, str]]]] = {
            "web_search": self.web_search,
            "read_webpage": self.read_webpage,
            "crypto_price": self.crypto_price,
            "crypto_market_overview": self.crypto_market_overview,
            "calculate": self.calculate,
            "current_time": self.current_time,
            "remember": self.remember,
            "forget_memory": self.forget_memory,
        }

    @property
    def schemas(self) -> list[dict[str, Any]]:
        return TOOL_SCHEMAS

    async def call(self, name: str, raw_args: str | None, ctx: ToolContext) -> tuple[str, str | None]:
        """Run a tool. Returns (result text for the AI, short trace line for humans)."""
        handler = self._handlers.get(name)
        if handler is None:
            return json.dumps({"error": f"unknown tool {name!r}"}), None
        try:
            args = json.loads(raw_args or "{}")
            if not isinstance(args, dict):
                raise ValueError("arguments must be a JSON object")
        except ValueError as exc:
            return json.dumps({"error": f"invalid arguments: {exc}"}), None
        try:
            result, trace = await handler(ctx=ctx, **args)
        except TypeError as exc:
            return json.dumps({"error": f"bad arguments for {name}: {exc}"}), None
        except ToolError as exc:
            return json.dumps({"error": str(exc)}), None
        except Exception as exc:  # a broken tool shouldn't kill the whole reply
            log.exception("tool %s failed", name)
            return json.dumps({"error": f"{name} failed: {type(exc).__name__}"}), None
        text = result if isinstance(result, str) else json.dumps(result, ensure_ascii=False, default=str)
        if len(text) > MAX_TOOL_RESULT_CHARS:
            text = text[:MAX_TOOL_RESULT_CHARS] + " …[truncated]"
        return text, trace

    # ---------------------------------------------------------------- web
    async def web_search(self, query: str, news: bool = False, ctx: ToolContext | None = None):
        query = str(query).strip()
        if not query:
            raise ToolError("empty query")

        def run() -> list[dict[str, Any]]:
            from ddgs import DDGS

            search = DDGS().news if news else DDGS().text
            return search(query, max_results=6)

        try:
            raw = await asyncio.wait_for(asyncio.to_thread(run), timeout=25)
        except asyncio.TimeoutError:
            raise ToolError("search timed out, try again or rephrase") from None
        except Exception as exc:  # ddgs raises its own exception types, including for "no results"
            log.warning("search failed for %r: %r", query, exc)
            raw = []
        results = [
            {
                "title": r.get("title", ""),
                "url": r.get("href") or r.get("url", ""),
                "snippet": r.get("body", ""),
                **({"date": r["date"], "source": r.get("source", "")} if news and r.get("date") else {}),
            }
            for r in raw
        ]
        return {"query": query, "results": results or "no results"}, f'🔎 searched "{query[:80]}"'

    async def read_webpage(self, url: str, ctx: ToolContext | None = None):
        url = str(url).strip()
        for _ in range(5):  # follow redirects by hand so every hop gets the safety check
            await _check_public_url(url)
            request = self.http.build_request("GET", url, headers={"User-Agent": USER_AGENT}, timeout=20.0)
            response = await self.http.send(request, stream=True)
            if response.is_redirect and response.headers.get("location"):
                await response.aclose()
                url = urljoin(url, response.headers["location"])
                continue
            break
        else:
            raise ToolError("too many redirects")
        try:
            if response.status_code >= 400:
                raise ToolError(f"page returned HTTP {response.status_code}")
            body = b""
            async for chunk in response.aiter_bytes():
                body += chunk
                if len(body) > MAX_PAGE_BYTES:
                    break
            content_type = response.headers.get("content-type", "").lower()
        finally:
            await response.aclose()

        host = urlparse(url).hostname or url
        if "html" in content_type or body.lstrip()[:15].lower().startswith((b"<!doctype", b"<html")):
            title, text = html_to_text(body.decode(response.encoding or "utf-8", errors="replace"))
        elif content_type.startswith("text/") or "json" in content_type or "xml" in content_type:
            title, text = "", body.decode(response.encoding or "utf-8", errors="replace")
        else:
            raise ToolError(f"can't read this kind of file ({content_type or 'unknown type'})")
        return {"url": url, "title": title, "text": text[:7000]}, f"🌐 read <{host}>"

    # ---------------------------------------------------------------- crypto
    async def _coingecko(self, path: str, **params: Any) -> Any:
        try:
            r = await self.http.get(f"{COINGECKO}{path}", params=params, headers=self.coingecko_headers, timeout=15.0)
        except httpx.HTTPError as exc:
            raise ToolError(f"CoinGecko unreachable ({type(exc).__name__})") from None
        if r.status_code == 429:
            raise ToolError("CoinGecko rate limit hit; wait a minute (a free COINGECKO_API_KEY raises the limit)")
        if r.status_code != 200:
            raise ToolError(f"CoinGecko returned HTTP {r.status_code}")
        return r.json()

    async def _resolve_coin(self, query: str) -> dict[str, Any] | None:
        q = query.strip().lower().lstrip("$")
        if q in self._coin_ids:
            return {"id": self._coin_ids[q]}
        data = await self._coingecko("/search", query=q)
        coins = data.get("coins", [])
        exact = [
            c for c in coins
            if q in {str(c.get("id", "")).lower(), str(c.get("symbol", "")).lower(), str(c.get("name", "")).lower()}
        ]
        # Lots of scam tokens share tickers; the best market-cap rank is almost always the one meant.
        pool = exact or coins[:1]
        if not pool:
            return None
        best = min(pool, key=lambda c: c.get("market_cap_rank") or 10**9)
        self._coin_ids[q] = best["id"]
        return best

    async def crypto_price(self, coins: list[str], ctx: ToolContext | None = None):
        if isinstance(coins, str):
            coins = [coins]
        coins = [str(c) for c in coins if str(c).strip()][:10]
        if not coins:
            raise ToolError("no coins given")
        resolved: dict[str, str] = {}
        not_found = []
        for query in coins:
            coin = await self._resolve_coin(query)
            if coin:
                resolved[query] = coin["id"]
            else:
                not_found.append(query)
        prices = {}
        if resolved:
            prices = await self._coingecko(
                "/simple/price",
                ids=",".join(sorted(set(resolved.values()))),
                vs_currencies="usd",
                include_24hr_change="true",
                include_24hr_vol="true",
                include_market_cap="true",
            )
        results = []
        for query, coin_id in resolved.items():
            data = prices.get(coin_id, {})
            change = data.get("usd_24h_change")
            volume = data.get("usd_24h_vol")
            signal, confidence, reasons = skully_signal(change, volume)
            results.append(
                {
                    "query": query,
                    "coingecko_id": coin_id,
                    "price_usd": data.get("usd"),
                    "change_24h_pct": round(change, 2) if change is not None else None,
                    "volume_24h_usd": volume,
                    "market_cap_usd": data.get("usd_market_cap"),
                    "skully_signal": f"{signal} ({confidence}% confidence)",
                    "signal_reasons": reasons,
                }
            )
        out: dict[str, Any] = {
            "coins": results,
            "note": "Skully signal is a simple momentum/volume heuristic, not financial advice.",
        }
        if not_found:
            out["not_found"] = not_found
        return out, f"📈 checked {', '.join(coins)[:80]}"

    async def crypto_market_overview(self, ctx: ToolContext | None = None):
        out: dict[str, Any] = {}
        try:
            r = await self.http.get("https://api.alternative.me/fng/?limit=1", timeout=10.0)
            fng = r.json()["data"][0]
            out["fear_greed_index"] = {"value": int(fng["value"]), "label": fng["value_classification"]}
        except (httpx.HTTPError, ValueError, KeyError, IndexError):
            out["fear_greed_index"] = "unavailable"
        try:
            data = await self._coingecko("/search/trending")
            trending = []
            for entry in data.get("coins", [])[:8]:
                item = entry.get("item", {})
                details = item.get("data") or {}
                change = (details.get("price_change_percentage_24h") or {}).get("usd")
                trending.append(
                    {
                        "name": item.get("name"),
                        "symbol": item.get("symbol"),
                        "coingecko_id": item.get("id"),
                        "market_cap_rank": item.get("market_cap_rank"),
                        "price_usd": details.get("price"),
                        "change_24h_pct": round(change, 2) if isinstance(change, (int, float)) else None,
                    }
                )
            out["trending_on_coingecko"] = trending
        except ToolError as exc:
            out["trending_on_coingecko"] = f"unavailable: {exc}"
        return out, "📊 checked market mood"

    # ---------------------------------------------------------------- misc
    async def calculate(self, expression: str, ctx: ToolContext | None = None):
        expression = str(expression)
        try:
            value = safe_eval(expression)
        except (ValueError, ZeroDivisionError, OverflowError, SyntaxError, TypeError) as exc:
            raise ToolError(f"can't calculate {expression!r}: {exc}") from None
        return {"expression": expression, "result": value}, f"🧮 calculated `{expression[:60]}`"

    async def current_time(self, timezone: str = "UTC", ctx: ToolContext | None = None):
        try:
            now = datetime.now(ZoneInfo(timezone or "UTC"))
        except (ZoneInfoNotFoundError, ValueError):
            raise ToolError(f"unknown timezone {timezone!r}; use an IANA name like 'Europe/London'") from None
        return {"timezone": timezone, "now": now.strftime("%A %Y-%m-%d %H:%M:%S %Z (UTC%z)")}, None

    async def remember(self, fact: str, ctx: ToolContext):
        try:
            memory_id = self.storage.add_memory(ctx.memory_scope, str(fact), ctx.user_name)
        except ValueError as exc:
            raise ToolError(str(exc)) from None
        return {"saved": True, "memory_id": memory_id}, "🧠 saved to memory"

    async def forget_memory(self, memory_id: int, ctx: ToolContext):
        try:
            deleted = self.storage.delete_memory(ctx.memory_scope, int(memory_id))
        except (TypeError, ValueError):
            raise ToolError("memory_id must be a number") from None
        return {"deleted": deleted}, "🧠 forgot a memory" if deleted else None


# -------------------------------------------------------------------- helpers
async def _check_public_url(url: str) -> None:
    """Refuse non-http(s) URLs and anything that resolves to a private/local address."""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ToolError("only full http(s) URLs can be read")
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(parsed.hostname, port)
    except OSError:
        raise ToolError(f"can't resolve {parsed.hostname}") from None
    for info in infos:
        address = ipaddress.ip_address(info[4][0].split("%")[0])
        if not address.is_global:
            raise ToolError("that address is private or local, so it can't be read")


def html_to_text(html: str) -> tuple[str, str]:
    soup = BeautifulSoup(html, "html.parser")
    title = soup.title.get_text(" ", strip=True) if soup.title else ""
    for tag in soup(["script", "style", "noscript", "svg", "nav", "footer", "header", "aside", "form", "iframe"]):
        tag.decompose()
    main = soup.find("article") or soup.find("main") or soup.body or soup
    text = main.get_text("\n", strip=True)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return title, text


def skully_signal(change_24h: float | None, volume: float | None) -> tuple[str, int, list[str]]:
    """Same momentum/volume heuristic as the Skully radar dashboard (app.py)."""
    if change_24h is None:
        return "Hold", 50, ["Not enough data"]
    score = 0
    reasons = []
    if change_24h > 15:
        score += 30
        reasons.append(f"Strong pump (+{change_24h:.1f}%)")
    elif change_24h > 5:
        score += 15
        reasons.append(f"Positive momentum (+{change_24h:.1f}%)")
    elif change_24h < -15:
        score -= 30
        reasons.append(f"Sharp dump ({change_24h:.1f}%)")
    elif change_24h < -5:
        score -= 15
        reasons.append(f"Negative momentum ({change_24h:.1f}%)")
    if volume and volume > 5_000_000:
        score += 15
        reasons.append("High trading volume")
    elif volume and volume > 1_000_000:
        score += 8
        reasons.append("Decent volume")
    if score >= 25:
        signal, confidence = "Buy", min(85, 55 + score)
    elif score <= -20:
        signal, confidence = "Sell", min(85, 55 + abs(score))
    else:
        signal, confidence = "Hold", 50 + abs(score) // 2
    return signal, confidence, reasons or ["Neutral price action"]


_BIN_OPS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.FloorDiv: operator.floordiv,
    ast.Mod: operator.mod,
    ast.Pow: operator.pow,
}
_UNARY_OPS = {ast.UAdd: operator.pos, ast.USub: operator.neg}
_FUNCS: dict[str, Callable[..., Any]] = {
    name: getattr(math, name)
    for name in ("sqrt", "log", "log10", "log2", "exp", "sin", "cos", "tan", "asin", "acos", "atan",
                 "sinh", "cosh", "tanh", "floor", "ceil", "degrees", "radians", "hypot", "gcd")
}
_FUNCS.update({"abs": abs, "round": round, "min": min, "max": max})
_CONSTS = {"pi": math.pi, "e": math.e, "tau": math.tau, "inf": math.inf}


def _factorial(n: Any) -> int:
    if not isinstance(n, int) or n < 0 or n > 1000:
        raise ValueError("factorial needs a whole number from 0 to 1000")
    return math.factorial(n)


_FUNCS["factorial"] = _factorial


def safe_eval(expression: str) -> Any:
    """Evaluate arithmetic without `eval`: only numbers, operators and math functions."""
    if len(expression) > 300:
        raise ValueError("expression too long")
    tree = ast.parse(expression.replace("^", "**"), mode="eval")

    def ev(node: ast.AST) -> Any:
        if isinstance(node, ast.Expression):
            return ev(node.body)
        if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)) and not isinstance(node.value, bool):
            return node.value
        if isinstance(node, ast.Name) and node.id in _CONSTS:
            return _CONSTS[node.id]
        if isinstance(node, ast.UnaryOp) and type(node.op) in _UNARY_OPS:
            return _UNARY_OPS[type(node.op)](ev(node.operand))
        if isinstance(node, ast.BinOp) and type(node.op) in _BIN_OPS:
            left, right = ev(node.left), ev(node.right)
            if isinstance(node.op, ast.Pow) and abs(right) > 10_000 and abs(left) > 1:
                raise ValueError("exponent too large")
            result = _BIN_OPS[type(node.op)](left, right)
            if isinstance(result, int) and result.bit_length() > 100_000:
                raise ValueError("result too large")
            return result
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id in _FUNCS
            and not node.keywords
        ):
            return _FUNCS[node.func.id](*[ev(arg) for arg in node.args])
        raise ValueError(f"unsupported syntax: {ast.dump(node)[:60]}")

    return ev(tree)
