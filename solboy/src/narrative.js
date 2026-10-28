// The one-line story of a coin on its Pulse page: what it is and where it comes from, written by the free AI
// from the coin's own description, the X post it links to and its website. Never price advice.
import { PROVIDERS, listModels, pickModel, streamChat } from './ai.js';

const SYSTEM = `You explain Solana meme coins to a beginner in plain English.
From the facts given (JSON), write ONE short sentence (under 22 words): what the coin is about (the joke, person, event, animal or trend it refers to) and where it comes from (e.g. which X post or account).
Use only the facts. If they don't say what it is, write "No clear story yet: just a name and ticker."
No price predictions, no advice, no hype, no emojis, no markdown, no headings.`;

// Short replies: prefer a fast model over the biggest one.
const FAST = ['llama-3.3-70b-versatile', 'openai/gpt-oss-20b', 'meta-llama/llama-4-scout-17b-16e-instruct', 'llama-3.1-8b-instant', 'gemini-2.5-flash-lite', 'gemini-2.5-flash'];
let picked = null;

/** Returns { text } or { needsKey: true }. Throws on AI errors. */
export async function writeNarrative(cfg, facts) {
  const provider = PROVIDERS[cfg.research?.provider] ?? PROVIDERS.groq;
  const key = process.env[provider.envKey]?.trim();
  if (!key) return { needsKey: true };
  if (!picked) {
    const available = await listModels(provider, key);
    picked = FAST.find((m) => available.includes(m)) ?? pickModel(provider, available);
  }
  const { cacheKey, ...clean } = facts;
  let text = '';
  await streamChat({ provider, key, model: picked, system: SYSTEM, user: `Coin facts: ${JSON.stringify(clean)}`, onText: (t) => (text += t), maxTokens: 800, timeoutMs: 20_000 });
  text = text.replace(/[#*_`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 500);
  return { text: text || null };
}
