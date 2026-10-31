import { dexApi } from './endpoints.js';
import { short } from './log.js';

// Token names from DexScreener (free, no key), cached so each token is looked up once.
const names = new Map();
const retryAt = new Map();
let pending = null;
export const cachedTokenName = mint => names.get(mint) ?? short(mint);
export async function tokenNames(mints) {
  const missing = [...new Set(mints)].filter((m) => !names.has(m) && Date.now() >= (retryAt.get(m) ?? 0)).slice(0, 30);
  if (missing.length && !pending) {
    pending = (async () => {
      let ok = false;
      try {
        const res = await fetch(`${dexApi()}/tokens/v1/solana/${missing.join(',')}`, { signal: AbortSignal.timeout(3000) });
        if (!res.ok) return;
        const rows = await res.json();
        if (!Array.isArray(rows)) return;
        for (const p of rows) if (p.baseToken?.symbol) names.set(p.baseToken.address, `$${p.baseToken.symbol}`);
        ok = true;
      } catch {} finally {
        for (const mint of missing) retryAt.set(mint, Date.now() + (ok ? 60_000 : 5000));
        while (retryAt.size > 2000) retryAt.delete(retryAt.keys().next().value);
      }
    })().finally(() => { pending = null; });
  }
  if (pending) await pending;
  return cachedTokenName;
}
