import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { PublicKey } from '@solana/web3.js';
import { log, short, notify, write } from './log.js';
import { PROVIDERS, listModels, pickModel, streamChat } from './ai.js';
import { dexApi, pumpApi, tweetApi } from './endpoints.js';

const SYSTEM_PROMPT = `You are an elite, hyper-efficient Crypto Research Assistant specializing in the Solana meme coin market. Your single objective is to dissect and explain new token narratives with extreme speed and maximum information density.

Process the user's input and provide a complete breakdown in under 5 seconds. To achieve this speed, you must completely eliminate all conversational filler, greetings, and intros. Start directly with the data.

Structure your response using the following strict markdown format:

### 🪙 [TOKEN_TICKER] | [TOKEN_NAME]
**TL;DR:** [3-4 short sentences in plain English that a beginner understands in 10 seconds: what this coin is, why it is going up right now, or plainly that it is falling if the numbers show that (cite the snapshot's actual numbers, e.g. price change, volume, buys vs sells, how new it is), and the single biggest risk. No jargon, no hype words.]
**Core Narrative:** [1-sentence punchy summary of what the coin/movement is about (e.g., AI agent cult, retro internet nostalgia, Matt Furie derivative, political meta)].

### 📊 Narrative Breakdown
* **The "Why Now":** [What triggered this trend? Celebrity tweet, viral TikTok, technical breakout, dev drama, or a rotation from another meta?]
* **Key Tropes & Imagery:** [What is the visual language or meme format being spammed on X/DexScreener? (e.g., MS Paint art, 3D renders, specific catchphrases)]
* **Target Audience:** [Who is buying this? DeGen cabals, retail TikTokers, AI tech enthusiasts, or nostalgic millennials?]

### ⚠️ Risk & Copycat Vector
* **Lifespan Estimate:** [Ultra-Short (Hours) | Short (1-2 Days) | Medium (1 Week+) | Meta-Defining] based on historical patterns of this specific narrative style.
* **Derivative Threat:** [High/Medium/Low] - How easily can a dev spin up "2.0" or "WifHat" versions of this within 10 minutes?
* **Red Flags:** [Specific narrative structural risks, e.g., "Relies entirely on one influencer's tweets," "Dev wallet holding 10% under a different name," "Community is heavily botted"].

### 💡 Quick Verdict
**[Bull Case in 10 words or less]** vs. **[Bear Case in 10 words or less]**

The input is a data snapshot for one token, gathered seconds ago from the blockchain, DexScreener, the launchpad (Pump.fun), the token's metadata, the X post the token links to (linkedTweet), its website, the creator's past launches (creatorHistory) and other tokens using the same ticker (sameTickerTokens). The coin may be only minutes old, so some sources can be missing (sourcesMissing).
Where the narrative comes from, in order: linkedTweet (very often the exact post the coin was made about: say who posted it and what it says), description, name/ticker, website. Use creatorHistory for the dev in Red Flags and sameTickerTokens for Derivative Threat, quoting the numbers. Use launchpad data (age, market cap, bonding curve, replies) when DexScreener has nothing yet.
You cannot browse X, TikTok or Telegram beyond what is in the snapshot. Base every claim on this snapshot plus your knowledge of past meme coin cycles. When the snapshot does not show the trigger, the imagery or the audience, give the most likely answer and end that line with "(inferred)". Only state numbers, holder percentages and wallet facts that appear in the snapshot; never invent them.`;

const withTimeout = (promise, ms) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), ms))]);

async function getJson(url, ms = 2000, init, fetchFn = fetch) {
  const res = await withTimeout(fetchFn(url, { ...init, headers: { Accept: 'application/json', ...init?.headers } }), ms);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const value = (r) => (r.status === 'fulfilled' ? r.value : undefined);
const clip = (t, n = 600) => (typeof t === 'string' && t.trim() ? t.replace(/\s+/g, ' ').trim().slice(0, n) : undefined);
const minsAgo = (ms) => (ms ? Math.max(0, Math.round((Date.now() - ms) / 60000)) : undefined);

// Token creators choose the metadata and website links, so only fetch public https addresses, never this
// computer or the home network.
export function publicUrl(u) {
  try {
    const { protocol, hostname } = new URL(u);
    return protocol === 'https:' && hostname.includes('.') && !/^[\d.]+$|^\[|localhost|\.local$|\.internal$/i.test(hostname);
  } catch {
    return false;
  }
}

// Launchpads put the metadata file on IPFS, and one gateway is often slow on a token seconds old: ask several at once.
const GATEWAYS = ['https://ipfs.io/ipfs/', 'https://cf-ipfs.com/ipfs/', 'https://gateway.pinata.cloud/ipfs/', 'https://dweb.link/ipfs/'];
function metadataFile(uri) {
  const cid = /\/ipfs\/([^/?#]+.*)$/.exec(uri ?? '')?.[1] ?? /^ipfs:\/\/(.+)$/.exec(uri ?? '')?.[1];
  const urls = [...new Set([uri, ...(cid ? GATEWAYS.map((g) => g + cid) : [])])].filter(publicUrl);
  return Promise.any(urls.map((u) => getJson(u, 2000)));
}

// The public embed endpoint X uses for embedded tweets; no login. The token is X's own derivation from the id.
async function linkedTweet(url) {
  const id = /(?:x|twitter)\.com\/[^/]+\/status(?:es)?\/(\d+)/i.exec(url ?? '')?.[1];
  if (!id) return undefined;
  const token = ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
  const t = await getJson(`${tweetApi()}/tweet-result?id=${id}&lang=en&token=${token}`, 2000);
  return {
    by: t.user ? `${t.user.name} (@${t.user.screen_name})${t.user.is_blue_verified ? ', verified' : ''}` : undefined,
    text: clip(t.text, 500),
    likes: t.favorite_count,
    replies: t.conversation_count,
    postedMinutesAgo: t.created_at ? minsAgo(Date.parse(t.created_at)) : undefined,
    quoting: t.quoted_tweet ? { by: t.quoted_tweet.user?.screen_name, text: clip(t.quoted_tweet.text, 300) } : undefined,
  };
}

export async function websiteSummary(url) {
  if (!publicUrl(url) || /(?:^|\.)(?:x|twitter)\.com|t\.me|pump\.fun/i.test(new URL(url).hostname)) return undefined;
  const res = await fetch(url, { redirect: 'follow', headers: { Accept: 'text/html' }, signal: AbortSignal.timeout(2000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = (await res.text()).slice(0, 200_000);
  const meta = (name) => new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']*)`, 'i').exec(html)?.[1];
  return { url, title: clip(/<title[^>]*>([^<]*)/i.exec(html)?.[1], 150), description: clip(meta('og:description') ?? meta('description'), 300) };
}

/**
 * Pull everything we can about a token in parallel, each source capped at ~2 seconds, so it works on a
 * coin launched seconds ago: launchpad data, the linked tweet (often the whole narrative), the website,
 * the creator's past launches and same-ticker copycats, on top of chain and DexScreener data.
 */
async function gatherSnapshot(connection, rpcUrl, rpcFetch, mint, context) {
  const mintKey = new PublicKey(mint);
  const [dexR, assetR, holdersR, supplyR, pumpR] = await Promise.allSettled([
    getJson(`${dexApi()}/tokens/v1/solana/${mint}`),
    getJson(rpcUrl, 2000, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAsset', params: { id: mint } }),
    }, rpcFetch),
    withTimeout(connection.getTokenLargestAccounts(mintKey), 2000),
    withTimeout(connection.getTokenSupply(mintKey), 2000),
    getJson(`${pumpApi()}/coins/${mint}`, 2000),
  ]);

  const snap = { mint, context, sourcesMissing: [] };
  const a = value(assetR)?.result;
  const pump = value(pumpR)?.mint ? value(pumpR) : null;
  const pairs = Array.isArray(value(dexR)) ? value(dexR) : [];
  const p = pairs.sort((x, y) => (y.liquidity?.usd ?? 0) - (x.liquidity?.usd ?? 0))[0];

  snap.name = a?.content?.metadata?.name ?? pump?.name ?? p?.baseToken?.name;
  snap.symbol = a?.content?.metadata?.symbol ?? pump?.symbol ?? p?.baseToken?.symbol;
  const jsonUri = a?.content?.json_uri || pump?.metadata_uri;
  const creator = pump?.creator;
  const socialsFrom = (o) => ({ twitter: o?.twitter, telegram: o?.telegram, website: o?.website });

  // Second round, all at once: things we only know where to find after the first round.
  const metaP = jsonUri ? metadataFile(jsonUri) : Promise.reject(new Error('none'));
  const [metaR, devR, copyR] = await Promise.allSettled([
    metaP,
    creator ? getJson(`${pumpApi()}/coins/user-created-coins/${creator}?offset=0&limit=50&includeNsfw=true`, 2000) : Promise.reject(new Error('none')),
    snap.symbol ? getJson(`${dexApi()}/latest/dex/search?q=${encodeURIComponent(snap.symbol)}`, 2000) : Promise.reject(new Error('none')),
  ]);
  const meta = value(metaR);
  const socials = { ...socialsFrom(meta), ...Object.fromEntries(Object.entries(socialsFrom(pump)).filter(([, v]) => v)) };
  if (!socials.website) socials.website = a?.content?.links?.external_url;
  const dexSocials = p?.info?.socials ?? [];
  if (!socials.twitter) socials.twitter = dexSocials.find((x) => x.type === 'twitter')?.url;
  if (!socials.telegram) socials.telegram = dexSocials.find((x) => x.type === 'telegram')?.url;
  if (!socials.website) socials.website = p?.info?.websites?.[0]?.url;
  snap.description = clip(a?.content?.metadata?.description || meta?.description || pump?.description, 800);
  snap.socials = Object.fromEntries(Object.entries(socials).filter(([, v]) => v));
  if (meta?.createdOn) snap.createdOn = meta.createdOn;

  const [tweetR, siteR] = await Promise.allSettled([linkedTweet(snap.socials.twitter), websiteSummary(snap.socials.website)]);
  if (value(tweetR)) snap.linkedTweet = value(tweetR);
  else if (snap.socials.twitter) snap.twitterNote = /\/status/.test(snap.socials.twitter) ? "Couldn't load the linked post." : 'Links to an X profile or community, not a specific post.';
  if (value(siteR)) snap.website = value(siteR);

  if (pump) {
    snap.launchpad = {
      platform: 'Pump.fun',
      launchedMinutesAgo: minsAgo(pump.created_timestamp),
      marketCapUsd: pump.usd_market_cap ? Math.round(pump.usd_market_cap) : undefined,
      bondingCurve: pump.complete ? 'finished, migrated to a DEX' : 'still on the Pump.fun bonding curve',
      reachedKingOfTheHill: pump.king_of_the_hill_timestamp ? `${minsAgo(pump.king_of_the_hill_timestamp)} min ago` : 'no',
      pumpFunReplies: pump.reply_count,
      nsfw: pump.nsfw || undefined,
      creatorWallet: creator,
    };
  }
  const dev = value(devR);
  const devCoins = Array.isArray(dev) ? dev : dev?.coins;
  if (Array.isArray(devCoins)) {
    const others = devCoins.filter((c) => c.mint !== mint);
    snap.creatorHistory = {
      otherCoinsLaunched: others.length >= 49 ? '49+' : others.length,
      ofThoseFinishedBondingCurve: others.filter((c) => c.complete).length,
      recent: others.slice(0, 5).map((c) => ({ symbol: c.symbol, name: c.name, marketCapUsd: c.usd_market_cap ? Math.round(c.usd_market_cap) : undefined, minutesAgo: minsAgo(c.created_timestamp) })),
      note: 'A creator who launched many coins that never finished the curve is usually a serial launcher (higher rug risk).',
    };
  }

  if (p) {
    snap.market = {
      dex: p.dexId,
      priceUsd: p.priceUsd,
      marketCapUsd: p.marketCap ?? p.fdv,
      liquidityUsd: p.liquidity?.usd,
      volumeUsd: p.volume,
      txns: p.txns,
      priceChangePct: p.priceChange,
      pairAgeMinutes: minsAgo(p.pairCreatedAt),
      boosts: p.boosts?.active,
    };
  } else {
    snap.market = pump ? 'Not on DexScreener yet; see launchpad data.' : 'Not listed on DexScreener yet (likely brand new / still on a bonding curve)';
  }

  const sym = snap.symbol?.toLowerCase();
  const copies = (value(copyR)?.pairs ?? []).filter((x) => x.chainId === 'solana' && x.baseToken?.symbol?.toLowerCase() === sym && x.baseToken?.address !== mint);
  if (value(copyR)) {
    const byToken = [...new Map(copies.map((x) => [x.baseToken.address, x])).values()];
    snap.sameTickerTokens = {
      count: byToken.length,
      biggest: byToken.sort((x, y) => (y.marketCap ?? 0) - (x.marketCap ?? 0)).slice(0, 3).map((x) => ({ name: x.baseToken.name, marketCapUsd: x.marketCap ? Math.round(x.marketCap) : undefined, ageMinutes: minsAgo(x.pairCreatedAt) })),
      note: 'Other Solana tokens using the same ticker (from DexScreener search). Many = a crowded or copied narrative.',
    };
  }

  if (holdersR.status === 'fulfilled' && supplyR.status === 'fulfilled') {
    const total = Number(supplyR.value.value.amount);
    const top = holdersR.value.value.map((h) => (Number(h.amount) / total) * 100);
    snap.holders = {
      note: 'Token accounts, largest first. The #1 account is often the liquidity pool or bonding curve, not a person.',
      top10PctEach: top.slice(0, 10).map((x) => +x.toFixed(2)),
      top10TotalPct: +top.slice(0, 10).reduce((s, x) => s + x, 0).toFixed(2),
    };
  }

  for (const [name, ok] of [['DexScreener', p], ['Pump.fun', pump], ['metadata file', meta], ['holders', snap.holders]]) if (!ok) snap.sourcesMissing.push(name);
  return snap;
}

/**
 * Narrative research on tokens the bot sees. Runs one at a time so reports don't interleave,
 * and never blocks trading. Returns null when research is off or no API key is set.
 */
export function createResearcher({ cfg, connection, rpcUrl, rpcFetch = fetch, outDir }) {
  if (!cfg.research.enabled) return null;
  const useClaude = cfg.research.provider === 'anthropic';
  const provider = PROVIDERS[cfg.research.provider];
  const key = (useClaude ? process.env.ANTHROPIC_API_KEY : process.env[provider.envKey])?.trim();
  if (!key) return null;

  const claude = useClaude ? new Anthropic() : null;
  const done = new Set();
  let queue = Promise.resolve();
  let model = cfg.research.model === 'auto' ? (useClaude ? 'claude-opus-5-5' : null) : cfg.research.model;

  async function resolveModel() {
    if (!model) model = pickModel(provider, await listModels(provider, key));
    return model;
  }

  async function writeReport(snap, onText) {
    const user = `Token snapshot:\n${JSON.stringify(snap, null, 2)}`;
    if (!useClaude) {
      return streamChat({ provider, key, model: await resolveModel(), system: SYSTEM_PROMPT, user, onText });
    }
    const stream = claude.beta.messages.stream({
      model,
      max_tokens: 16000,
      output_config: { effort: cfg.research.effort },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: user }],
    });
    stream.on('text', onText);
    const message = await stream.finalMessage();
    if (message.stop_reason === 'refusal') throw new Error('Claude declined to research this token.');
    return message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  }

  async function run(mint, context) {
    const started = Date.now();
    log(`Researching ${short(mint)}...`);
    const snap = await gatherSnapshot(connection, rpcUrl, rpcFetch, mint, context);
    const dataSecs = ((Date.now() - started) / 1000).toFixed(1);

    write('\n');
    const report = await writeReport(snap, (text) => write(text));
    write('\n');
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    log(`Research done in ${secs}s (data ${dataSecs}s)`);

    const name = `${(snap.symbol || 'token').replace(/[^\w-]/g, '')}-${mint.slice(0, 6)}.md`;
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      path.join(outDir, name),
      `${report}\n\n---\nMint: ${mint}\nhttps://dexscreener.com/solana/${mint}\nResearched ${new Date().toISOString()} in ${secs}s by ${model}\n`,
    );
    notify(`${report}\n\nhttps://dexscreener.com/solana/${mint}`);
  }

  function describeError(e) {
    if (e instanceof Anthropic.AuthenticationError) return 'Anthropic API key was rejected. Check ANTHROPIC_API_KEY in .env.';
    if (e instanceof Anthropic.RateLimitError) return 'Anthropic rate limit hit. Try again shortly.';
    if (e instanceof Anthropic.APIError) return `Anthropic API error ${e.status}: ${e.message}`;
    if (e.name === 'TimeoutError') return 'the AI took too long to answer.';
    return e.message;
  }

  /** Queue a token for research. force=true re-runs a token already researched. */
  function research(mint, context = {}, force = false) {
    if (done.has(mint) && !force) return;
    done.add(mint);
    queue = queue.then(() => run(mint, context)).catch((e) => log(`Research failed for ${short(mint)}: ${describeError(e)}`));
    return queue;
  }

  /** Check the key and choose a model at startup, so problems show up straight away. */
  research.describe = async () => {
    if (useClaude) return `Claude (${model})`;
    try {
      return `${provider.label} (${await resolveModel()}), free`;
    } catch (e) {
      return `${provider.label}, but couldn't reach it yet (${e.message}). Check the key and your internet`;
    }
  };
  return research;
}
