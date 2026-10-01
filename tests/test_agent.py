import json

import httpx

from bot.agent import Agent
from bot.config import ProviderConfig
from bot.llm import LLMChain
from bot.storage import Storage
from bot.tools import ToolBox, ToolContext

PROVIDER = ProviderConfig("groq", "https://llm.test/v1", "k", ("model-a",), discover_models=False)
CTX = ToolContext(memory_scope="guild:1", user_name="Zippe")


def tool_call(call_id, name, args):
    return {"id": call_id, "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}


def make_agent(responses, max_steps=6):
    """An agent whose LLM replies with `responses` in order, recording each request."""
    requests = []

    def handler(request: httpx.Request):
        body = json.loads(request.content)
        requests.append(body)
        return httpx.Response(200, json={"choices": [{"message": responses[len(requests) - 1]}]})

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    llm = LLMChain([PROVIDER], "", http=http)
    agent = Agent(llm, ToolBox(http, Storage(":memory:")), max_steps=max_steps)
    return agent, requests


async def test_tool_loop_runs_tools_and_feeds_results_back():
    agent, requests = make_agent([
        {"role": "assistant", "content": None, "tool_calls": [
            tool_call("a", "calculate", {"expression": "12*12"}),
            tool_call("b", "remember", {"fact": "Zippe likes math"}),
        ]},
        {"role": "assistant", "content": "It's **144**. Also noted that you like math."},
    ])
    result = await agent.run([{"role": "user", "content": "[Zippe]: what's 12*12? remember I like math"}], CTX)

    assert result.text == "It's **144**. Also noted that you like math."
    assert result.model == "groq/model-a"
    assert result.trace == ["🧮 calculated `12*12`", "🧠 saved to memory"]
    second = requests[1]["messages"]
    tool_messages = [m for m in second if m["role"] == "tool"]
    assert [m["tool_call_id"] for m in tool_messages] == ["a", "b"]
    assert json.loads(tool_messages[0]["content"])["result"] == 144
    assert "tools" in requests[0]


async def test_last_step_forces_an_answer_without_tools():
    looping = {"role": "assistant", "content": None, "tool_calls": [tool_call("x", "calculate", {"expression": "1+1"})]}
    agent, requests = make_agent([looping, looping, {"role": "assistant", "content": "Fine, it's 2."}], max_steps=2)
    result = await agent.run([{"role": "user", "content": "1+1?"}], CTX)
    assert result.text == "Fine, it's 2."
    assert "tools" in requests[0] and "tools" in requests[1] and "tools" not in requests[2]


async def test_no_tools_mode():
    agent, requests = make_agent([{"role": "assistant", "content": "Summary: stuff happened."}])
    result = await agent.run([{"role": "user", "content": "summarize"}], CTX, use_tools=False)
    assert result.text == "Summary: stuff happened."
    assert "tools" not in requests[0]
