import { dexApi } from './endpoints.js';
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
