// Free, keyless live market data from DexScreener, trimmed to what an AI needs to answer questions.

import { dexApi } from './endpoints.js';

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`DexScreener answered ${res.status}`);
  return res.json();
}

const mins = (t) => (t ? Math.round((Date.now() - t) / 60000) : null);

function summarizePair(p) {
  return {
    name: p.baseToken?.name,
    symbol: p.baseToken?.symbol,
    address: p.baseToken?.address,
    dex: p.dexId,
    priceUsd: p.priceUsd ? Number(p.priceUsd) : null,
    marketCapUsd: p.marketCap ?? p.fdv ?? null,
    liquidityUsd: p.liquidity?.usd ?? null,
    volumeUsd: { h1: p.volume?.h1, h24: p.volume?.h24 },
    priceChangePct: { h1: p.priceChange?.h1, h24: p.priceChange?.h24 },
    txns24h: p.txns?.h24,
    pairAgeMinutes: mins(p.pairCreatedAt),
    socials: [...(p.info?.socials ?? []).map((s) => `${s.type}: ${s.url}`), ...(p.info?.websites ?? []).map((w) => w.url)].slice(0, 4),
    paidBoostsActive: p.boosts?.active ?? 0,
  };
}

// Keep the most liquid pair for each token: it best reflects the real price.
function bestPerToken(pairs) {
  const best = new Map();
  for (const p of pairs.filter((x) => x.chainId === 'solana')) {
    const k = p.baseToken?.address;
    if (k && (!best.has(k) || (p.liquidity?.usd ?? 0) > (best.get(k).liquidity?.usd ?? 0))) best.set(k, p);
  }
  return [...best.values()];
}

/** Find a Solana token by address, ticker or name. Returns up to 3 matches, most liquid first. */
export async function lookupToken(query) {
  const q = String(query ?? '').trim().replace(/^\$/, '');
  if (!q) throw new Error('Give a token name, ticker or address.');
  const pairs = ADDRESS.test(q) ? await getJson(`${dexApi()}/tokens/v1/solana/${q}`) : (await getJson(`${dexApi()}/latest/dex/search?q=${encodeURIComponent(q)}`)).pairs ?? [];
  const tokens = bestPerToken(Array.isArray(pairs) ? pairs : [])
    .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))
    .slice(0, 3)
    .map(summarizePair);
  return tokens.length ? { matches: tokens, note: 'Several tokens can share a ticker; the most liquid is usually the real one.' } : { matches: [], note: `No Solana token found for "${q}".` };
}

/** Tokens getting the most paid promotion on DexScreener right now, with live market data. */
export async function trendingTokens() {
  const boosts = (await getJson(`${dexApi()}/token-boosts/top/v1`)).filter((b) => b.chainId === 'solana').slice(0, 12);
  if (!boosts.length) return { tokens: [], note: 'Nothing trending on Solana right now.' };
  const pairs = await getJson(`${dexApi()}/tokens/v1/solana/${boosts.map((b) => b.tokenAddress).join(',')}`);
  const byToken = new Map(bestPerToken(Array.isArray(pairs) ? pairs : []).map((p) => [p.baseToken.address, p]));
  return {
    tokens: boosts.filter((b) => byToken.has(b.tokenAddress)).map((b) => ({ ...summarizePair(byToken.get(b.tokenAddress)), boostAmount: b.totalAmount })),
    note: 'This list is ranked by paid DexScreener boosts (advertising), not organic popularity. Treat it as "what is being promoted".',
  };
}
