"""The think → use tools → answer loop."""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any

from .llm import LLMChain
from .tools import ToolBox, ToolContext

log = logging.getLogger(__name__)


@dataclass
class AgentResult:
    text: str
    model: str | None = None
    trace: list[str] = field(default_factory=list)


class Agent:
    def __init__(self, llm: LLMChain, tools: ToolBox, max_steps: int = 6):
        self.llm = llm
        self.tools = tools
        self.max_steps = max_steps

    async def run(self, messages: list[dict[str, Any]], ctx: ToolContext, use_tools: bool = True) -> AgentResult:
        """Answer the conversation in `messages`, calling tools as the model asks.

        Raises llm.AllProvidersFailed if no model can answer.
        """
        messages = list(messages)
        trace: list[str] = []
        model = None
        for step in range(self.max_steps + 1):
            # On the last step, take the tools away so the model has to answer.
            offer_tools = use_tools and step < self.max_steps
            completion = await self.llm.complete(messages, self.tools.schemas if offer_tools else None)
            model = completion.label
            message = completion.message
            calls = message.get("tool_calls") or []
            if not calls or not offer_tools:
                return AgentResult(text=_text_of(message), model=model, trace=trace)

            messages.append(message)
            results = await asyncio.gather(
                *(self.tools.call(c.get("function", {}).get("name", ""), c.get("function", {}).get("arguments"), ctx)
                  for c in calls)
            )
            for call, (result, line) in zip(calls, results):
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": call.get("id"),
                        "name": call.get("function", {}).get("name", ""),
                        "content": result,
                    }
                )
                if line and line not in trace:
                    trace.append(line)
        return AgentResult(text="", model=model, trace=trace)  # unreachable: the last step has no tools


def _text_of(message: dict[str, Any]) -> str:
    content = message.get("content") or ""
    if isinstance(content, list):  # some providers return content parts
        content = "".join(p.get("text", "") for p in content if isinstance(p, dict))
    return str(content).strip()
