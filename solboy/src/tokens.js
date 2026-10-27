import { dexApi } from './endpoints.js';
import { WSOL } from './detect.js';
import { getQuote } from './jupiter.js';
import { short } from './log.js';

// Token names from DexScreener (free, no key), cached so each token is looked up once.
const names = new Map();
export async function tokenNames(mints) {
  const missing = [...new Set(mints)].filter((m) => !names.has(m)).slice(0, 30);
  if (missing.length) {
    try {
      const res = await fetch(`${dexApi()}/tokens/v1/solana/${missing.join(',')}`, { signal: AbortSignal.timeout(3000) });
      for (const p of await res.json()) if (p.baseToken?.symbol) names.set(p.baseToken.address, `$${p.baseToken.symbol}`);
    } catch {}
  }
  return (mint) => names.get(mint) ?? short(mint);
}

// What each open position would sell for right now, cached briefly so a busy screen doesn't spam Jupiter.
const worthCache = new Map();
export async function positionWorth(mint, pos, slippageBps, maxAgeMs = 10_000) {
  const hit = worthCache.get(mint);
  if (hit && hit.tokens === pos.tokens && Date.now() - hit.at < maxAgeMs) return hit.worth;
  try {
    const q = await getQuote({ inputMint: mint, outputMint: WSOL, amount: pos.tokens, slippageBps });
    const worth = Number(q.outAmount) / 1e9;
    worthCache.set(mint, { worth, tokens: pos.tokens, at: Date.now() });
    return worth;
  } catch {
    return null;
  }
}
