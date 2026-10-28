// Free AI providers. Both speak the OpenAI-style chat API, so one code path serves either.
// Model names change often, so by default we ask the provider what it has and pick the best match.

export const PROVIDERS = {
  groq: {
    label: 'Groq',
    get base() {
      return process.env.GROQ_API_URL || 'https://api.groq.com/openai/v1';
    },
    envKey: 'GROQ_API_KEY',
    signup: 'https://console.groq.com/keys',
    prefer: ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'meta-llama/llama-4-scout-17b-16e-instruct', 'openai/gpt-oss-20b', 'llama-3.1-8b-instant'],
    fallback: /llama|gpt-oss|qwen|kimi/i,
  },
  gemini: {
    label: 'Google Gemini',
    base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    envKey: 'GEMINI_API_KEY',
    signup: 'https://aistudio.google.com/apikey',
    prefer: ['gemini-2.5-flash', 'gemini-flash-latest', 'gemini-2.5-flash-lite'],
    fallback: /^gemini-[\d.]+-flash(-lite)?$/i,
  },
};

export class AiError extends Error {}

function explainStatus(provider, status, body) {
  // Gemini answers a bad key with a 400 rather than a 401.
  if (status === 401 || status === 403 || /api key/i.test(body)) return `${provider.label} rejected the API key. Check ${provider.envKey} in .env.`;
  if (status === 429) return `${provider.label} free limit reached for now. Research resumes once it resets.`;
  if (status === 413) return `${provider.label} said the request was too large for this model's free limit.`;
  return `${provider.label} error ${status}: ${body.slice(0, 300)}`;
}

export async function listModels(provider, key, timeoutMs = 10_000) {
  const res = await fetch(`${provider.base}/models`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new AiError(explainStatus(provider, res.status, await res.text()));
  const { data = [] } = await res.json();
  return data.map((m) => String(m.id).replace(/^models\//, ''));
}

export function pickModel(provider, available) {
  return provider.prefer.find((m) => available.includes(m)) ?? available.find((m) => provider.fallback.test(m)) ?? available[0];
}

/** Stream a chat reply, calling onText for each piece as it arrives. Returns the full text. */
export async function streamChat({ provider, key, model, system, user, onText, maxTokens = 4096, timeoutMs = 30_000 }) {
  const res = await fetch(`${provider.base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      model,
      stream: true,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      // gpt-oss models think before answering; keep that short for speed.
      ...(model.includes('gpt-oss') ? { reasoning_effort: 'low' } : {}),
    }),
  });
  if (!res.ok) throw new AiError(explainStatus(provider, res.status, await res.text()));

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return full;
      let event;
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }
      if (event.error) throw new AiError(`${provider.label} error: ${event.error.message ?? JSON.stringify(event.error)}`);
      const text = event.choices?.[0]?.delta?.content;
      if (text) {
        full += text;
        onText(text);
      }
    }
  }
  return full;
}

/**
 * One chat turn that may come back with proposed actions (OpenAI-style tool calls).
 * Returns { text, calls: [{ name, args }] }. Calls are only proposals; nothing runs here.
 */
export async function chatWithTools({ provider, key, model, system, messages, tools, timeoutMs = 45_000 }) {
  const res = await fetch(`${provider.base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      messages: [{ role: 'system', content: system }, ...messages],
      tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
      tool_choice: 'auto',
      ...(model.includes('gpt-oss') ? { reasoning_effort: 'low' } : {}),
    }),
  });
  if (!res.ok) throw new AiError(explainStatus(provider, res.status, await res.text()));
  const msg = (await res.json()).choices?.[0]?.message ?? {};
  const calls = (msg.tool_calls ?? []).map((c) => {
    let args = null;
    try {
      args = JSON.parse(c.function.arguments || '{}');
    } catch {
      // garbled arguments: reported back to the model as an error instead of guessed at
    }
    return { id: c.id, name: c.function.name, args };
  });
  return { text: msg.content ?? '', calls, message: { role: 'assistant', content: msg.content ?? '', ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}) } };
}
