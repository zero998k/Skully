import fs from 'node:fs';
import path from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { file } from './paths.js';
import { log } from './log.js';
import { dexApi } from './endpoints.js';
import { parseTrades } from './detect.js';

// Pulse: a live board of new Pump.fun / Bonk coins (New Pairs, Final Stretch, Migrated) with Axiom-style filters.
// Data comes free from PumpPortal's public websocket (every launch, trade and migration), DexScreener for
// coins after they migrate, and your own Solana connection for holders and wallet funding.

const PUMPPORTAL_WS = () => process.env.PUMPPORTAL_WS_URL || 'wss://pumpportal.fun/api/data';
const SOL_PRICE_URL = () => process.env.SOL_PRICE_URL || 'https://lite-api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112';
const GECKO_API = () => process.env.GECKO_API_URL || 'https://api.geckoterminal.com/api/v2';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const PUMP_AMM_PROGRAM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
// The PumpSwap pool a Pump.fun coin migrates into (pool index 0, made by the coin's Pump.fun pool authority).
function pumpSwapPool(mint) {
  const m = new PublicKey(mint);
  const [authority] = PublicKey.findProgramAddressSync([Buffer.from('pool-authority'), m.toBuffer()], PUMP_PROGRAM);
  const index = Buffer.alloc(2);
  const [pool] = PublicKey.findProgramAddressSync([Buffer.from('pool'), index, authority.toBuffer(), m.toBuffer(), new PublicKey(WSOL_MINT).toBuffer()], PUMP_AMM_PROGRAM);
  return pool.toBase58();
}
const SUPPLY = 1e9; // Pump.fun and Bonk coins all have 1 billion tokens
const PUMP_START_VTOKENS = 1_073_000_191; // virtual tokens in a fresh Pump.fun curve
const PUMP_CURVE_TOKENS = 793_100_191; // tokens sold before the curve completes
const GRADUATION_MC_SOL = 410; // rough market cap (SOL) where a curve completes, for launchpads without curve maths
const BUNDLE_MS = 1200; // bought within ~1-3 blocks of the launch: bundled with it
const SNIPE_MS = 5000; // bought within the first few seconds
const MAX_TOKENS = 4000;
const MAX_SUBSCRIBED = 2500; // live trade feeds kept open: every recent coin, so their stats are complete when they get hot
const TRADES_KEPT = 500;

// Every launchpad Axiom lists. SolBoy has live data for the ones marked live; the rest are shown but can't match yet.
export const PROTOCOLS = [
  ['pump', 'Pump', true], ['bonk', 'Bonk', true], ['pump-amm', 'Pump AMM', true], ['bags', 'Bags', false],
  ['moonshot', 'Moonshot', false], ['heaven', 'Heaven', false], ['daos', 'Daos.fun', false], ['candle', 'Candle', false],
  ['sugar', 'Sugar', false], ['believe', 'Believe', false], ['jup-studio', 'Jupiter Studio', false], ['moonit', 'Moonit', false],
  ['boop', 'Boop', false], ['launchlab', 'LaunchLab', false], ['dynamic-bc', 'Dynamic BC', false], ['raydium', 'Raydium', true],
  ['meteora', 'Meteora AMM', true], ['meteora-v2', 'Meteora AMM V2', true], ['orca', 'Orca', true],
];
const DEX_TO_PROTOCOL = { pumpswap: 'pump-amm', raydium: 'raydium', meteora: 'meteora', meteoradbc: 'meteora-v2', orca: 'orca' };

const TWEET_API = () => process.env.TWEET_API_URL || 'https://cdn.syndication.twimg.com';
const clip = (x, n) => (x == null ? null : String(x).replace(/\s+/g, ' ').trim().slice(0, n) || null);
const gwScore = new Map(); // gateway -> recent answer times (ms); faster gateways are asked first
const gwRank = (list) => [...list].sort((a, b) => avgMs(a) - avgMs(b));
const avgMs = (g) => { const x = gwScore.get(g); return x?.length ? x.reduce((s, v) => s + v, 0) / x.length : 2500; };
function gwNote(url, ms) { const g = GATEWAYS.find((x) => url.startsWith(x)); if (!g) return; const x = gwScore.get(g) ?? []; x.push(ms); if (x.length > 20) x.shift(); gwScore.set(g, x); }
const GATEWAYS = ['https://pump.mypinata.cloud/ipfs/', 'https://ipfs.io/ipfs/', 'https://dweb.link/ipfs/', 'https://gateway.pinata.cloud/ipfs/', 'https://w3s.link/ipfs/'];
const PUMP_API = () => process.env.PUMP_API_URL || 'https://frontend-api-v3.pump.fun';
const ipfsCid = (u) => /\/ipfs\/([^?#]+)/.exec(u ?? '')?.[1] ?? /^ipfs:\/\/(.+)$/.exec(u ?? '')?.[1] ?? null;
// Coin creators choose these links, so only public https addresses are fetched, never this computer or the home network.
function publicUrl(u) {
  try {
    const { protocol, hostname } = new URL(u);
    return protocol === 'https:' && hostname.includes('.') && !/^[\d.]+$|^\[|localhost|\.local$|\.internal$/i.test(hostname);
  } catch {
    return false;
  }
}
const allowLocal = () => process.env.PULSE_ALLOW_LOCAL_URLS === '1'; // tests only

async function getJson(url, ms = 4000) {
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const num = (x) => (x == null || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));
const handleOf = (url) => /(?:x|twitter)\.com\/(?!i\/|search|home|intent)([A-Za-z0-9_]{1,15})/i.exec(url ?? '')?.[1]?.toLowerCase() ?? null;

/** Default filters for one column: everything allowed. */
export function blankFilters() {
  const range = () => ({ min: '', max: '' });
  return {
    quality: false,
    include: [],
    exclude: [],
    protocols: Object.fromEntries(PROTOCOLS.map(([id]) => [id, true])),
    audit: {
      dexPaid: false, caEndsPump: false,
      age: { min: '', max: '', minUnit: 'm', maxUnit: 'm' },
      top10: range(), dev: range(), snipers: range(), insiders: range(), bundle: range(), holders: range(),
      proTraders: range(), devMigrations: range(), devPairs: range(),
    },
    metrics: { liquidity: range(), volume: range(), mc: range(), curve: range(), fees: range(), txns: range(), buys: range(), sells: range() },
    socials: { twitterReuses: range(), twitter: false, website: false, telegram: false, anySocial: false },
  };
}
export const blankPresets = () => ({ active: 1, presets: { 1: blankCols(), 2: blankCols(), 3: blankCols() } });
const blankCols = () => ({ new: blankFilters(), stretch: blankFilters(), migrated: blankFilters() });

const UNIT = { s: 1, m: 60, h: 3600, d: 86400 };
function inRange(value, r, scale = 1) {
  if (!r) return true;
  const min = r.min === '' || r.min == null ? null : Number(r.min) * scale;
  const max = r.max === '' || r.max == null ? null : Number(r.max) * scale;
  if (min == null && max == null) return true;
  if (value == null) return true; // not known yet: don't hide it
  return (min == null || value >= min) && (max == null || value <= max);
}

/** Does a coin pass one column's filters? Unknown numbers pass, so brand-new coins aren't hidden by missing data. */
// "Quality only": hides the junk most launches are: no socials at all, a dev who already dumped, or a coin a few
// wallets (bundles, top 10) already own most of. Unknown numbers don't hide a coin.
export function quality(row) {
  if (!(row.twitter || row.website || row.telegram)) return false;
  if (row.devSold) return false;
  if (row.bundle != null && row.bundle >= 30) return false;
  if (row.top10 != null && row.top10 >= 60) return false;
  if (row.snipers != null && row.snipers >= 30) return false;
  return true;
}

export function passes(row, f) {
  if (!f) return true;
  if (f.quality && !quality(row)) return false;
  const text = `${row.name} ${row.symbol} ${row.mint}`.toLowerCase();
  if (f.include?.length && !f.include.some((k) => text.includes(String(k).toLowerCase()))) return false;
  if (f.exclude?.some((k) => text.includes(String(k).toLowerCase()))) return false;
  if (f.protocols && f.protocols[row.protocol] === false) return false;
  const a = f.audit ?? {};
  if (a.dexPaid && !row.dexPaid) return false;
  if (a.caEndsPump && !row.mint.endsWith('pump')) return false;
  if (a.age) {
    const min = a.age.min === '' ? null : Number(a.age.min) * (UNIT[a.age.minUnit] ?? 60);
    const max = a.age.max === '' ? null : Number(a.age.max) * (UNIT[a.age.maxUnit] ?? 60);
    if ((min != null && row.ageSec < min) || (max != null && row.ageSec > max)) return false;
  }
  for (const k of ['top10', 'dev', 'snipers', 'insiders', 'bundle', 'holders', 'proTraders', 'devMigrations', 'devPairs']) if (!inRange(row[k], a[k])) return false;
  const m = f.metrics ?? {};
  const metric = { liquidity: row.liqUsd, volume: row.volUsd, mc: row.mcUsd, curve: row.progress, fees: row.feesUsd, txns: row.txns, buys: row.buys, sells: row.sells };
  for (const [k, v] of Object.entries(metric)) if (!inRange(v, m[k])) return false;
  const s = f.socials ?? {};
  if (!inRange(row.twitterReuses, s.twitterReuses)) return false;
  if (s.twitter && !row.twitter) return false;
  if (s.website && !row.website) return false;
  if (s.telegram && !row.telegram) return false;
  if (s.anySocial && !(row.twitter || row.website || row.telegram)) return false;
  return true;
}

export function createPulse({ cfg, connection }) {
  const tokens = new Map();
  const subscribed = new Set();
  const listeners = new Set(); // (event) => void, for live trades of open coins
  let ws = null;
  let wsState = 'connecting';
  let lastMessageAt = 0;
  let solUsd = null;
  let retry = 1000;
  const pendingSubs = new Set();
  const pendingUnsubs = new Set();
  const settingsFile = file('data/pulse-filters.json');
  const historyFile = file('data/pulse-history.json');
  const cacheFile = file('data/pulse-cache.json');
  let filters = blankPresets();
  try {
    filters = { ...filters, ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) };
  } catch {}
  // What SolBoy has learned over time: each creator's launches and migrations, and how often an X account is reused.
  let history = { devs: {}, twitter: {} };
  try {
    history = { ...history, ...JSON.parse(fs.readFileSync(historyFile, 'utf8')) };
  } catch {}
  let historyDirty = false;
  const focus = new Map(); // coins someone has open: mint -> count of viewers
  const stats = { metaOk: 0, metaFail: 0, tweetOk: 0, tweetFail: 0, imgOk: 0, imgFail: 0, seed: null, seedError: null, geckoOk: 0, geckoFail: 0 }; // for the live check

  function saveJson(target, data) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(`${target}.tmp`, JSON.stringify(data));
    fs.renameSync(`${target}.tmp`, target);
  }

  // ---- live feed ----
  function send(obj) {
    if (ws?.readyState === 1) ws.send(JSON.stringify(obj));
  }
  function connect() {
    wsState = 'connecting';
    try {
      ws = new WebSocket(PUMPPORTAL_WS());
    } catch (e) {
      wsState = 'offline';
      return setTimeout(connect, retry);
    }
    ws.onopen = () => {
      wsState = 'live';
      retry = 1000;
      send({ method: 'subscribeNewToken' });
      send({ method: 'subscribeMigration' });
      const keys = [...subscribed];
      for (let i = 0; i < keys.length; i += 100) send({ method: 'subscribeTokenTrade', keys: keys.slice(i, i + 100) });
    };
    ws.onmessage = (m) => {
      lastMessageAt = Date.now();
      let d;
      try {
        d = JSON.parse(typeof m.data === 'string' ? m.data : Buffer.from(m.data).toString());
      } catch {
        return;
      }
      if (!d?.mint) return;
      if (d.txType === 'create') onCreate(d);
      else if (d.txType === 'buy' || d.txType === 'sell') onTrade(d);
      else if (d.txType === 'migrate' || d.txType === 'migration' || d.method === 'migration') onMigrate(d);
    };
    ws.onclose = () => {
      if (wsState !== 'stopped') {
        wsState = 'offline';
        setTimeout(connect, retry);
        retry = Math.min(retry * 2, 30_000);
      }
    };
    ws.onerror = () => {};
  }
  // Subscriptions go out in batches, so a burst of launches doesn't flood the feed with messages.
  setInterval(() => {
    if (pendingUnsubs.size) {
      send({ method: 'unsubscribeTokenTrade', keys: [...pendingUnsubs] });
      pendingUnsubs.clear();
    }
    if (pendingSubs.size) {
      send({ method: 'subscribeTokenTrade', keys: [...pendingSubs] });
      pendingSubs.clear();
    }
  }, 1500).unref();

  function follow(mint) {
    if (subscribed.has(mint)) return;
    subscribed.add(mint);
    pendingUnsubs.delete(mint);
    pendingSubs.add(mint);
  }
  function unfollow(mint) {
    if (!subscribed.delete(mint)) return;
    pendingSubs.delete(mint);
    pendingUnsubs.add(mint);
  }

  function blankToken(mint) {
    return {
      mint, name: '', symbol: '', uri: null, protocol: 'pump', creator: null, createdAt: null, seenAt: Date.now(),
      vSol: null, vTokens: null, mcSol: null, athMcSol: 0, migrated: false, migratedAt: null,
      trades: [], wallets: new Map(), buys: 0, sells: 0, volSol: 0, lastTradeAt: null, fromBirth: false,
      meta: null, metaState: 'none', dex: null, analysis: null,
    };
  }
  function wallet(tok, address) {
    let w = tok.wallets.get(address);
    if (!w) tok.wallets.set(address, (w = { bal: 0, buySol: 0, sellSol: 0, boughtTok: 0, soldTok: 0, buys: 0, sells: 0, firstAt: null, tags: new Set() }));
    return w;
  }

  function onCreate(d) {
    const tok = tokens.get(d.mint) ?? blankToken(d.mint);
    Object.assign(tok, {
      name: String(d.name ?? '').slice(0, 60), symbol: String(d.symbol ?? '').slice(0, 20), uri: d.uri ?? null,
      protocol: d.pool === 'bonk' ? 'bonk' : 'pump', creator: d.traderPublicKey ?? null, createdAt: Date.now(), fromBirth: true,
    });
    tokens.set(d.mint, tok);
    wantMeta(tok); // picture and socials start loading the moment the coin launches
    if (tok.creator) {
      const dev = wallet(tok, tok.creator);
      dev.tags.add('dev');
      if (num(d.initialBuy)) {
        dev.bal = num(d.initialBuy);
        dev.boughtTok = dev.bal;
        dev.buySol = num(d.solAmount) ?? 0;
        dev.buys = 1;
        dev.firstAt = tok.createdAt;
        tok.buys++;
        tok.volSol += dev.buySol;
      }
      if (dev.buys) tok.trades.push({ sig: d.signature, t: tok.createdAt, side: 'buy', wallet: tok.creator, sol: dev.buySol, tokens: dev.bal, mcSol: num(d.marketCapSol) });
      const h = (history.devs[tok.creator] ??= { created: 0, migrated: 0, mints: [] });
      h.created++;
      h.mints = [d.mint, ...h.mints].slice(0, 20);
      historyDirty = true;
    }
    curve(tok, d);
    subscribed.add(d.mint);
    send({ method: 'subscribeTokenTrade', keys: [d.mint] }); // straight away: the first seconds matter most
    if (tokens.size > MAX_TOKENS) prune(true);
  }

  function curve(tok, d) {
    if (d.bondingCurveKey) tok.bondingCurveKey = d.bondingCurveKey;
    if (num(d.vSolInBondingCurve) != null) tok.vSol = num(d.vSolInBondingCurve);
    if (num(d.vTokensInBondingCurve) != null) tok.vTokens = num(d.vTokensInBondingCurve);
    const mc = num(d.marketCapSol) ?? (tok.vSol && tok.vTokens ? (tok.vSol / tok.vTokens) * SUPPLY : null);
    if (mc != null) {
      tok.mcSol = mc;
      tok.athMcSol = Math.max(tok.athMcSol, mc);
    }
  }

  const tradeTicks = []; // when trades arrived (last minute), to show the feed is really flowing
  function onTrade(d) {
    const nowT = Date.now();
    tradeTicks.push(nowT);
    while (tradeTicks.length && nowT - tradeTicks[0] > 60_000) tradeTicks.shift();
    let tok = tokens.get(d.mint);
    if (!tok) tokens.set(d.mint, (tok = blankToken(d.mint)));
    const now = Date.now();
    const buy = d.txType === 'buy';
    const sol = num(d.solAmount) ?? 0;
    const amount = num(d.tokenAmount) ?? 0;
    const who = d.traderPublicKey;
    curve(tok, d);
    if (d.pool && d.pool !== 'pump' && d.pool !== 'bonk') {
      tok.pool = d.pool;
      tok.feedAmmTradeAt = now;
    }
    if (d.signature && viewers > 0 && Date.now() - lastDelaySample > (delays.length < 3 ? 8_000 : 60_000)) sampleDelay(d.signature, now);
    tok.lastTradeAt = now;
    tok.volSol += sol;
    buy ? tok.buys++ : tok.sells++;
    if (who) {
      const w = wallet(tok, who);
      w.lastAt = now;
      if (buy) {
        w.buys++;
        w.buySol += sol;
        w.boughtTok += amount;
        if (w.firstAt == null) {
          w.firstAt = now;
          if (tok.fromBirth && who !== tok.creator) {
            if (now - tok.createdAt <= BUNDLE_MS) w.tags.add('bundler');
            if (now - tok.createdAt <= SNIPE_MS) w.tags.add('sniper');
          }
        }
      } else {
        w.sells++;
        w.sellSol += sol;
        w.soldTok += amount;
      }
      w.bal = num(d.newTokenBalance) ?? Math.max(0, w.bal + (buy ? amount : -amount));
    }
    const trade = { sig: d.signature, t: now, side: buy ? 'buy' : 'sell', wallet: who, sol, tokens: amount, mcSol: tok.mcSol };
    tok.trades.push(trade);
    if (tok.trades.length > TRADES_KEPT) tok.trades.splice(0, tok.trades.length - TRADES_KEPT);
    if (focus.has(d.mint)) for (const fn of listeners) fn({ mint: d.mint, trade: decorateTrade(tok, trade) });
  }

  function onMigrate(d) {
    let tok = tokens.get(d.mint);
    if (!tok) tokens.set(d.mint, (tok = blankToken(d.mint)));
    if (tok.migrated) return;
    tok.migrated = true;
    tok.migratedAt = Date.now();
    tok.pool = d.pool && d.pool !== 'pump' ? d.pool : 'pump-amm';
    if (tok.creator && history.devs[tok.creator]) {
      history.devs[tok.creator].migrated++;
      historyDirty = true;
    }
    follow(d.mint);
  }

  // ---- how far behind the chain the live feed is (measured, not guessed) ----
  // Every minute while Pulse is open: look up one trade's block time and compare it with when it reached SolBoy.
  // Block times are whole seconds, so this averages several samples. 2 Solana requests per sample.
  let lastDelaySample = 0;
  let viewers = 0;
  const delays = [];
  async function sampleDelay(sig, receivedAt) {
    lastDelaySample = Date.now();
    try {
      await new Promise((r) => setTimeout(r, 4000));
      const st = (await connection.getSignatureStatuses([sig])).value[0];
      if (!st?.slot) return;
      const bt = await connection.getBlockTime(st.slot);
      if (!bt) return;
      delays.push(receivedAt / 1000 - (bt + 0.5)); // a block time is rounded down to the second
      if (delays.length > 12) delays.shift();
    } catch {}
  }
  const feedDelay = () => (delays.length >= 2 ? Math.max(0.1, delays.reduce((a, b) => a + b, 0) / delays.length) : null);

  // ---- live price for migrated coins you have open: watch the pool's two vaults on the chain ----
  // Each change in the pool's token or SOL vault is a trade (or a liquidity change), seen at "processed" speed,
  // so the chart moves with every trade instead of waiting for DexScreener. Only for coins someone is viewing.
  const poolOf = (tok) => {
    if (tok.dex?.pair) return tok.dex.pair;
    try { return tok.protocol === 'pump' ? pumpSwapPool(tok.mint) : null; } catch { return null; }
  };
  async function watchPool(tok) {
    if (!tok.migrated) return;
    const pairAddr = poolOf(tok);
    const w0 = tok.poolWatch;
    // a pool that didn't work is tried again once DexScreener names another pool, or after 30 seconds
    if (w0 && (w0.state === 'live' || w0.state === 'starting' || (w0.pair === pairAddr && Date.now() - w0.at < 30_000))) return;
    if (!pairAddr) return;
    const w = (tok.poolWatch = { state: 'starting', ids: [], pair: pairAddr, at: Date.now() });
    try {
      const pair = new PublicKey(pairAddr);
      const [baseRes, quoteRes] = await Promise.all([
        connection.getTokenAccountsByOwner(pair, { mint: new PublicKey(tok.mint) }, 'processed'),
        connection.getTokenAccountsByOwner(pair, { mint: new PublicKey(WSOL_MINT) }, 'processed'),
      ]);
      if (tok.poolWatch !== w) return; // the coin was closed while this was starting
      const base = baseRes.value[0];
      const quote = quoteRes.value[0];
      if (!base || !quote) return void (tok.poolWatch = { state: 'unsupported', ids: [], pair: pairAddr, at: Date.now() });
      const amount = (data) => Number(Buffer.from(data).readBigUInt64LE(64));
      w.base = amount(base.account.data) / 1e6;
      w.quote = amount(quote.account.data) / 1e9;
      w.pending = new Map();
      const priceNow = () => (w.base > 0 ? w.quote / w.base : null);
      const flush = (slot) => {
        const p = w.pending.get(slot);
        w.pending.delete(slot);
        const price = priceNow();
        if (price) {
          tok.mcSol = price * SUPPLY;
          tok.athMcSol = Math.max(tok.athMcSol, tok.mcSol);
        }
        if (!p || Math.abs(p.dq) < 0.0005) return;
        if (p.db && Math.sign(p.db) === Math.sign(p.dq)) return; // both sides grew or shrank: liquidity, not a trade
        if (Date.now() - (tok.feedAmmTradeAt ?? 0) < 15_000) return; // the feed already shows these trades, with wallets
        const buy = p.dq > 0;
        const sol = Math.abs(p.dq);
        const amountTok = Math.abs(p.db) || (price ? sol / price : 0);
        const now = Date.now();
        tok.volSol += sol;
        buy ? tok.buys++ : tok.sells++;
        tok.lastTradeAt = now;
        const trade = { sig: null, t: now, side: buy ? 'buy' : 'sell', wallet: null, sol, tokens: amountTok, mcSol: tok.mcSol, slot, source: 'pool' };
        tok.trades.push(trade);
        if (tok.trades.length > TRADES_KEPT) tok.trades.splice(0, tok.trades.length - TRADES_KEPT);
        for (const fn of listeners) fn({ mint: tok.mint, trade: decorateTrade(tok, trade) });
      };
      const onChange = (side) => (info, ctx) => {
        const next = side === 'base' ? amount(info.data) / 1e6 : amount(info.data) / 1e9;
        const delta = next - w[side];
        w[side] = next;
        const p = w.pending.get(ctx.slot) ?? { dq: 0, db: 0 };
        side === 'quote' ? (p.dq += delta) : (p.db += delta);
        if (!w.pending.has(ctx.slot)) setTimeout(() => flush(ctx.slot), 120); // wait for the other vault in the same slot
        w.pending.set(ctx.slot, p);
      };
      w.ids.push(connection.onAccountChange(base.pubkey, onChange('base'), 'processed'));
      w.ids.push(connection.onAccountChange(quote.pubkey, onChange('quote'), 'processed'));
      w.state = 'live';
      const price = priceNow();
      if (price) tok.mcSol = price * SUPPLY;
    } catch {
      if (tok.poolWatch !== w) return;
      tok.poolWatch = { state: 'failed', ids: [], pair: pairAddr, at: Date.now() };
    }
  }
  function unwatchPool(tok) {
    const w = tok?.poolWatch;
    if (!w) return;
    for (const id of w.ids ?? []) connection.removeAccountChangeListener(id).catch(() => {});
    tok.poolWatch = null;
  }

  // ---- the story behind a coin: the X post it links to, and its website ----
  async function fetchTweet(url) {
    const id = /(?:x|twitter)\.com\/[^/]+\/status(?:es)?\/(\d+)/i.exec(url ?? '')?.[1];
    if (!id) return null;
    const token = ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, ''); // X's own embed token
    const t = await getJson(`${TWEET_API()}/tweet-result?id=${id}&lang=en&token=${token}`, 5000);
    const img = (u) => (typeof u === 'string' && (publicUrl(u) || allowLocal()) ? u : null);
    return {
      url, author: clip(t.user?.name, 60), handle: clip(t.user?.screen_name, 30), verified: Boolean(t.user?.is_blue_verified), avatar: img(t.user?.profile_image_url_https),
      text: clip(t.text, 500), image: img(t.mediaDetails?.[0]?.media_url_https ?? t.photos?.[0]?.url), likes: num(t.favorite_count), replies: num(t.conversation_count),
      at: Date.parse(t.created_at) || null, quote: t.quoted_tweet ? { handle: clip(t.quoted_tweet.user?.screen_name, 30), text: clip(t.quoted_tweet.text, 300) } : null,
    };
  }
  const storyQueue = [];
  let storyBusy = 0;
  function wantStory(tok) {
    if (!tok || tok.storyState || tok.metaState !== 'done' || !/\/status(?:es)?\/\d+/.test(tok.meta?.twitter ?? '')) return;
    tok.storyState = 'queued';
    storyQueue.push(tok);
    pumpStories();
  }
  function pumpStories() {
    while (storyBusy < 3 && storyQueue.length) {
      const t = storyQueue.shift();
      storyBusy++;
      fetchTweet(t.meta.twitter)
        .then((tw) => { t.tweet = tw; t.storyState = 'done'; stats.tweetOk++; })
        .catch(() => { t.storyState = 'failed'; stats.tweetFail++; })
        .finally(() => { storyBusy--; pumpStories(); });
    }
  }
  async function siteSummary(url) {
    if (!(publicUrl(url) || (allowLocal() && /^http:\/\/127\.0\.0\.1/.test(url ?? ''))) || /(?:^|\.)(?:x|twitter)\.com|t\.me|pump\.fun/i.test(new URL(url).hostname)) return null;
    const res = await fetch(url, { redirect: 'follow', headers: { Accept: 'text/html' }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const html = (await res.text()).slice(0, 200_000);
    const meta = (name) => new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']*)`, 'i').exec(html)?.[1];
    return { url, title: clip(/<title[^>]*>([^<]*)/i.exec(html)?.[1], 120), description: clip(meta('og:description') ?? meta('description'), 300) };
  }
  function wantSite(tok) {
    const url = tok.meta?.website;
    if (!url || tok.siteState) return;
    tok.siteState = 'loading';
    siteSummary(url).then((x) => { tok.site = x; tok.siteState = 'done'; }).catch(() => { tok.siteState = 'failed'; });
  }
  const xKind = (u) => (!u ? null : /\/status(?:es)?\/\d+/.test(u) ? 'post' : /\/i\/communities\//.test(u) ? 'community' : /(?:x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/?(?:[?#]|$)/i.test(u) ? 'profile' : 'link');

  // ---- housekeeping ----
  function prune(force = false) {
    const now = Date.now();
    const solMc = (t) => (t.mcSol ?? 0) * (solUsd ?? 150);
    for (const [mint, t] of tokens) {
      if (t.migrated && now - t.migratedAt < 6 * 3600_000) continue;
      if (focus.has(mint)) continue;
      const age = now - (t.createdAt ?? t.seenAt);
      const quiet = now - (t.lastTradeAt ?? t.seenAt);
      const dead = (age > 3600_000 && solMc(t) < 15_000) || (age > 15 * 60_000 && quiet > 10 * 60_000 && progressOf(t) < 15) || age > 12 * 3600_000;
      if (dead || (force && tokens.size > MAX_TOKENS && quiet > 120_000)) {
        tokens.delete(mint);
        unfollow(mint);
      }
    }
    // Keep live trade subscriptions for the busiest coins only.
    if (subscribed.size > MAX_SUBSCRIBED) {
      const quietest = [...subscribed].map((m) => [m, tokens.get(m)?.lastTradeAt ?? 0]).filter(([m]) => !focus.has(m)).sort((a, b) => a[1] - b[1]);
      for (const [m] of quietest.slice(0, subscribed.size - MAX_SUBSCRIBED)) unfollow(m);
    }
    if (historyDirty) {
      historyDirty = false;
      const devs = Object.entries(history.devs);
      if (devs.length > 60_000) history.devs = Object.fromEntries(devs.slice(-40_000));
      const tw = Object.entries(history.twitter);
      if (tw.length > 60_000) history.twitter = Object.fromEntries(tw.slice(-40_000));
      try {
        saveJson(historyFile, history);
      } catch {}
    }
  }
  setInterval(() => prune(), 30_000).unref();

  async function refreshSolPrice() {
    try {
      const d = await getJson(SOL_PRICE_URL());
      const p = num(Object.values(d)[0]?.usdPrice ?? d.data?.So11111111111111111111111111111111111111112?.price);
      if (p) solUsd = p;
    } catch {}
  }
  refreshSolPrice();
  setInterval(refreshSolPrice, 30_000).unref();

  // ---- metadata (name, image, socials) for coins people can see ----
  const metaQueue = [];
  let metaBusy = 0;
  function wantMeta(tok) {
    if (tok.metaState !== 'none' || (!tok.uri && !dasLeft())) return;
    tok.metaState = 'queued';
    metaQueue.push(tok);
    pumpMeta();
  }
  function pumpMeta() {
    while (metaBusy < 8 && metaQueue.length) {
      const tok = metaQueue.shift();
      metaBusy++;
      loadMeta(tok).finally(() => {
        metaBusy--;
        pumpMeta();
      });
    }
  }
  // Helius's coin lookup (your own key): any coin's metadata link, name and a fast copy of its picture.
  // 10 credits each, so it is a backup with a daily cap (the free plan has about 1 million credits a month).
  const DAS_DAILY = 2500;
  let dasDay = '', dasUsed = 0;
  const dasLeft = () => { const d = new Date().toDateString(); if (d !== dasDay) { dasDay = d; dasUsed = 0; } return dasUsed < DAS_DAILY; };
  async function dasAsset(mint) {
    if (!dasLeft()) throw new Error('daily Helius lookups used up');
    dasUsed++;
    const res = await fetch(connection.rpcEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAsset', params: { id: mint } }), signal: AbortSignal.timeout(6000) });
    const r = (await res.json()).result;
    if (!r?.content) throw new Error('no asset');
    const f = r.content.files?.[0] ?? {};
    const img = [f.cdn_uri, r.content.links?.image, f.uri].find((u) => typeof u === 'string' && (publicUrl(u) || allowLocal()));
    stats.dasOk = (stats.dasOk ?? 0) + 1;
    return { jsonUri: r.content.json_uri || null, image: img ?? null, name: r.content.metadata?.name, symbol: r.content.metadata?.symbol, description: r.content.metadata?.description };
  }
  async function loadMeta(tok) {
    let das = null;
    if (!tok.uri) {
      // a coin SolBoy didn't see launch: ask Helius where its details live
      try {
        das = await dasAsset(tok.mint);
        tok.uri = das.jsonUri;
        tok.name ||= String(das.name ?? '').slice(0, 60);
        tok.symbol ||= String(das.symbol ?? '').slice(0, 20);
      } catch {
        tok.metaState = 'failed';
        stats.metaFail++;
        return;
      }
    }
    const cid = ipfsCid(tok.uri);
    const urls = [...new Set([tok.uri, ...(cid ? gwRank(GATEWAYS).map((g) => g + cid) : [])])].filter((u) => publicUrl(u) || (allowLocal() && /^http:\/\/127\.0\.0\.1/.test(u)));
    try {
      // IPFS gateways and Pump.fun's own record for the coin, whichever answers first
      const t0 = Date.now();
      const sources = urls.map((u) => getJson(u, 5000).then((x) => { gwNote(u, Date.now() - t0); return x; }, (e) => { gwNote(u, 5000); throw e; }));
      if (tok.protocol === 'pump') sources.push(getJson(`${PUMP_API()}/coins/${tok.mint}`, 5000).then((c) => (c?.image_uri ? { ...c, image: c.image_uri } : Promise.reject(new Error('no coin')))));
      if (!sources.length) throw new Error('no metadata link');
      const m = await Promise.any(sources);
      const image = typeof m.image === 'string' ? m.image.replace(/^ipfs:\/\//, 'https://ipfs.io/ipfs/') : null;
      tok.meta = {
        image: image && (publicUrl(image) || allowLocal()) ? image : das?.image ?? null,
        cdnImage: das?.image ?? null,
        description: String(m.description ?? '').slice(0, 400),
        twitter: typeof m.twitter === 'string' ? m.twitter.slice(0, 200) : null,
        telegram: typeof m.telegram === 'string' ? m.telegram.slice(0, 200) : null,
        website: typeof m.website === 'string' ? m.website.slice(0, 200) : null,
      };
      const key = handleOf(tok.meta.twitter) ?? tok.meta.twitter?.toLowerCase();
      if (key) {
        history.twitter[key] = (history.twitter[key] ?? 0) + 1;
        historyDirty = true;
      }
      tok.metaState = 'done';
      stats.metaOk++;
      if (tok.meta.image || tok.meta.cdnImage) fetchImage(tok.mint); // fetch the picture now, so it's ready when the card shows
    } catch {
      // the details file didn't load: Helius still has the picture (and the name), even without the socials
      if (!das && dasLeft()) das = await dasAsset(tok.mint).catch(() => null);
      if (das?.image && !tok.meta) {
        tok.meta = { image: das.image, cdnImage: das.image, description: String(das.description ?? '').slice(0, 400), twitter: null, telegram: null, website: null };
      }
      if (tok.metaTries) stats.metaFail++;
      // IPFS gateways are often slow for brand-new files: try once more a little later
      tok.metaState = tok.metaTries ? 'failed' : 'none';
      tok.metaTries = (tok.metaTries ?? 0) + 1;
      if (tok.metaState === 'none') setTimeout(() => wantMeta(tok), 8000).unref?.();
    }
  }

  // ---- DexScreener: prices and paid profiles for coins after they migrate (and older coins we didn't see launch) ----
  async function enrich(list) {
    const mints = list.filter((t) => !t.dex || Date.now() - t.dex.at > 20_000).map((t) => t.mint).slice(0, 30);
    if (!mints.length) return;
    try {
      const pairs = await getJson(`${dexApi()}/tokens/v1/solana/${mints.join(',')}`, 6000);
      const best = new Map();
      for (const p of Array.isArray(pairs) ? pairs : []) {
        const m = p.baseToken?.address;
        if (m && (!best.has(m) || (p.liquidity?.usd ?? 0) > (best.get(m).liquidity?.usd ?? 0))) best.set(m, p);
      }
      for (const mint of mints) {
        const tok = tokens.get(mint);
        const p = best.get(mint);
        if (!tok) continue;
        tok.dex = p
          ? {
              at: Date.now(), mcUsd: num(p.marketCap ?? p.fdv), liqUsd: num(p.liquidity?.usd), volUsd: num(p.volume?.h24),
              buys: num(p.txns?.h24?.buys), sells: num(p.txns?.h24?.sells), priceUsd: num(p.priceUsd), pair: p.pairAddress, dexId: p.dexId,
              paid: Boolean(p.info?.imageUrl || p.info?.websites?.length || p.info?.socials?.length), pairCreatedAt: p.pairCreatedAt ?? null,
              image: p.info?.imageUrl ?? null, socials: p.info?.socials ?? [], websites: p.info?.websites ?? [],
              windows: Object.fromEntries(['m5', 'h1', 'h6', 'h24'].map((k) => [k, { change: num(p.priceChange?.[k]), volUsd: num(p.volume?.[k]), buys: num(p.txns?.[k]?.buys), sells: num(p.txns?.[k]?.sells) }])),
            }
          : { at: Date.now() };
        if (p && !tok.name) {
          tok.name = p.baseToken?.name ?? '';
          tok.symbol = p.baseToken?.symbol ?? '';
        }
        if (p && tok.migrated && DEX_TO_PROTOCOL[p.dexId]) tok.pool = DEX_TO_PROTOCOL[p.dexId];
      }
    } catch {}
  }

  // ---- numbers for one coin ----
  function progressOf(t) {
    if (t.migrated) return 100;
    if (t.protocol === 'pump' && t.vTokens != null) return Math.max(0, Math.min(100, ((PUMP_START_VTOKENS - t.vTokens) / PUMP_CURVE_TOKENS) * 100));
    return t.mcSol != null ? Math.max(0, Math.min(99, (t.mcSol / GRADUATION_MC_SOL) * 100)) : null;
  }
  function pctOf(t, pick) {
    let sum = 0;
    for (const [addr, w] of t.wallets) if (pick(addr, w)) sum += w.bal;
    return (sum / SUPPLY) * 100;
  }
  function holders(t) {
    return [...t.wallets].filter(([, w]) => w.bal > 1).sort((a, b) => b[1].bal - a[1].bal);
  }
  function row(t) {
    const usd = solUsd ?? 0;
    const known = t.fromBirth; // wallet-level numbers are exact only for coins followed since launch
    const top = known ? holders(t) : [];
    const dev = t.creator ? t.wallets.get(t.creator) : null;
    const m = t.meta ?? {};
    const twitter = m.twitter || t.dex?.socials?.find((s) => s.type === 'twitter')?.url || null;
    const telegram = m.telegram || t.dex?.socials?.find((s) => s.type === 'telegram')?.url || null;
    const website = m.website || t.dex?.websites?.[0]?.url || null;
    const twKey = handleOf(twitter) ?? twitter?.toLowerCase();
    const devHist = t.creator ? history.devs[t.creator] : null;
    const onCurve = !t.migrated && t.vSol != null;
    const liveAmm = t.poolWatch?.state === 'live' || Date.now() - (t.feedAmmTradeAt ?? 0) < 60_000; // a live price beats DexScreener's
    const mcUsd = t.migrated && !liveAmm && t.dex?.mcUsd != null ? t.dex.mcUsd : t.mcSol != null && usd ? t.mcSol * usd : t.dex?.mcUsd ?? null;
    return {
      mint: t.mint, name: t.name || t.dex?.name || '', symbol: t.symbol || '', protocol: t.migrated ? t.pool ?? 'pump-amm' : t.protocol,
      launchpad: t.protocol, image: m.image || t.dex?.image || null, description: m.description || '',
      xKind: xKind(twitter), tweet: t.tweet ? { handle: t.tweet.handle, author: t.tweet.author, verified: t.tweet.verified, text: clip(t.tweet.text, 160), likes: t.tweet.likes, image: t.tweet.image } : null,
      createdAt: t.createdAt ?? t.dex?.pairCreatedAt ?? null,
      ageSec: Math.round((Date.now() - (t.createdAt ?? t.dex?.pairCreatedAt ?? t.seenAt)) / 1000),
      migrated: t.migrated, migratedAt: t.migratedAt, progress: progressOf(t),
      priceSol: t.mcSol != null ? t.mcSol / SUPPLY : null, mcSol: t.mcSol, mcUsd, athMcUsd: t.athMcSol && usd ? t.athMcSol * usd : null,
      liqUsd: onCurve && usd ? Math.max(0, t.vSol - 30) * usd * 2 : t.dex?.liqUsd ?? null,
      volUsd: (t.migrated || !t.fromBirth) && t.dex?.volUsd != null ? Math.max(t.dex.volUsd, t.volSol * usd) : usd && (t.volSol || t.fromBirth) ? t.volSol * usd : t.dex?.volUsd ?? null,
      feesUsd: usd && (t.volSol || t.fromBirth) ? t.volSol * usd * 0.0125 : null,
      // coins SolBoy didn't follow from launch show "-" until it sees trades or DexScreener has numbers
      txns: t.buys + t.sells || (t.dex ? (t.dex.buys ?? 0) + (t.dex.sells ?? 0) : t.fromBirth ? 0 : null), buys: t.buys || t.dex?.buys || 0, sells: t.sells || t.dex?.sells || 0,
      holders: known ? top.length : null,
      top10: known ? (top.slice(0, 10).reduce((s, [, w]) => s + w.bal, 0) / SUPPLY) * 100 : null,
      dev: known && dev ? (dev.bal / SUPPLY) * 100 : null,
      devSold: Boolean(known && dev && dev.buys && dev.bal <= 1),
      snipers: known ? pctOf(t, (_, w) => w.tags.has('sniper')) : null,
      bundle: known ? pctOf(t, (_, w) => w.tags.has('bundler')) : null,
      insiders: t.analysis ? pctOf(t, (a) => t.analysis.insiders.includes(a)) : null,
      snipersCount: known ? [...t.wallets.values()].filter((w) => w.tags.has('sniper')).length : null,
      bundlersCount: known ? [...t.wallets.values()].filter((w) => w.tags.has('bundler')).length : null,
      proTraders: null,
      devPairs: devHist ? Math.max(0, devHist.created - 1) : null,
      devMigrations: devHist ? devHist.migrated - (t.migrated ? 1 : 0) : null,
      creator: t.creator,
      twitter, telegram, website, xHandle: handleOf(twitter),
      twitterReuses: twKey ? Math.max(0, (history.twitter[twKey] ?? 1) - 1) : null,
      dexPaid: t.dex?.paid ?? null,
      followedSinceLaunch: known,
      launchCheck: t.backfill ?? null,
    };
  }

  function column(t) {
    if (t.migrated) return 'migrated';
    const p = progressOf(t);
    return p != null && p >= (cfg.pulse?.stretchPct ?? 45) ? 'stretch' : 'new';
  }

  /** The three columns, filtered with the active preset. */
  function board(limit = 40) {
    const f = filters.presets[filters.active] ?? blankCols();
    const cols = { new: [], stretch: [], migrated: [] };
    const nameless = [];
    for (const t of tokens.values()) {
      if (!t.name && !t.dex) {
        // a coin seen only through its migration (or late trades) has no name yet: DexScreener has it
        if (t.migrated || (progressOf(t) ?? 0) >= (cfg.pulse?.stretchPct ?? 45)) nameless.push(t);
        continue;
      }
      cols[column(t)].push(t);
    }
    if (nameless.length) enrich(nameless.slice(0, 30));
    cols.new.sort((a, b) => (b.createdAt ?? b.seenAt) - (a.createdAt ?? a.seenAt));
    cols.stretch.sort((a, b) => (progressOf(b) ?? 0) - (progressOf(a) ?? 0));
    cols.migrated.sort((a, b) => (b.migratedAt ?? 0) - (a.migratedAt ?? 0));
    const out = {};
    for (const [name, list] of Object.entries(cols)) {
      const rows = [];
      for (const t of list) {
        const r = row(t);
        if (passes(r, f[name])) rows.push(r);
        if (rows.length >= limit) break;
      }
      for (const r of rows) {
        const tk = tokens.get(r.mint);
        wantMeta(tk);
        wantStory(tk);
      }
      out[name] = rows;
    }
    enrich([...cols.migrated.slice(0, 30), ...cols.stretch.slice(0, 10)]);
    for (const t of cols.stretch.slice(0, 10)) wantBackfill(t);
    return out;
  }

  // ---- one coin in detail ----
  const labels = () => {
    const map = new Map();
    for (const k of cfg.pulse?.kols ?? []) map.set(k.address, { label: k.label, kol: true });
    for (const w of cfg.wallets) map.set(w.address, { label: w.label, copied: true, ...(map.get(w.address) ?? {}) });
    return map;
  };
  function decorateTrade(tok, tr) {
    const w = tr.wallet ? tok.wallets.get(tr.wallet) : null;
    const l = labels().get(tr.wallet);
    return { ...tr, mcUsd: tr.mcSol != null && solUsd ? tr.mcSol * solUsd : null, usd: solUsd ? tr.sol * solUsd : null, feeSol: tr.sol * feeRate(tok) + 0.000005, tags: w ? [...w.tags] : [], label: l?.label ?? null, kol: Boolean(l?.kol) };
  }

  // Trading fees a wallet paid on this coin, estimated: the exchange fee on what it traded plus the network fee
  // per transaction (priority tips aren't in the live feed). Pump.fun curve: 1.25%; PumpSwap and others: about 0.3%.
  const feeRate = (tok) => (tok.migrated ? 0.003 : 0.0125);
  function walletDetail(tok, w, pct) {
    if (!w) return { tags: [], pct, buySol: null, sellSol: null, buys: null, sells: null, pnlSol: null, feesSol: null };
    const price = tok.mcSol != null ? tok.mcSol / SUPPLY : null; // SOL per token
    const usd = solUsd;
    const remainingSol = price != null ? w.bal * price : null;
    const avg = (sol, tok2) => (tok2 > 0 && usd ? (sol / tok2) * SUPPLY * usd : null); // the market cap they bought / sold at, on average
    return {
      tags: [...w.tags], pct,
      buySol: w.buySol, sellSol: w.sellSol, buys: w.buys, sells: w.sells, boughtTok: w.boughtTok, soldTok: w.soldTok,
      avgBuyMcUsd: avg(w.buySol, w.boughtTok), avgSellMcUsd: avg(w.sellSol, w.soldTok),
      remainingSol, remainingUsd: remainingSol != null && usd ? remainingSol * usd : null, holdingPct: (w.bal / SUPPLY) * 100,
      pnlSol: w.sellSol + (remainingSol ?? 0) - w.buySol,
      feesSol: (w.buySol + w.sellSol) * feeRate(tok) + (w.buys + w.sells) * 0.000005,
      firstAt: w.firstAt ?? null, lastAt: w.lastAt ?? null,
    };
  }
  // SOL in each top holder's wallet (one request for all of them, refreshed every 30 seconds)
  const solBalCache = new Map();
  function solBalances(tok, owners) {
    const hit = solBalCache.get(tok.mint);
    if ((!hit || Date.now() - hit.at > 30_000) && owners.length && !hit?.loading) {
      const next = { at: Date.now(), map: hit?.map ?? new Map(), loading: true };
      solBalCache.set(tok.mint, next);
      connection.getMultipleAccountsInfo(owners.map((o) => new PublicKey(o)))
        .then((infos) => { infos.forEach((a, i) => next.map.set(owners[i], a ? a.lamports / 1e9 : 0)); })
        .catch(() => {})
        .finally(() => { next.loading = false; });
      if (solBalCache.size > 200) solBalCache.delete(solBalCache.keys().next().value);
    }
    return solBalCache.get(tok.mint)?.map ?? new Map();
  }

  // 5m / 1h / 6h / 24h: price change, volume and buys vs sells, from SolBoy's own trades when they cover the
  // window, otherwise DexScreener's numbers
  function windowStats(tok) {
    const now = Date.now();
    const out = {};
    const oldest = tok.trades[0]?.t ?? now;
    for (const [k, ms] of [['m5', 300e3], ['h1', 3600e3], ['h6', 21600e3], ['h24', 86400e3]]) {
      const covered = tok.fromBirth || oldest <= now - ms;
      if (!covered && tok.dex?.windows?.[k]) { out[k] = { ...tok.dex.windows[k], source: 'dex' }; continue; }
      const inWin = tok.trades.filter((t) => t.t >= now - ms);
      if (!inWin.length) { out[k] = covered ? { change: 0, volUsd: 0, buys: 0, sells: 0, buyUsd: 0, sellUsd: 0 } : null; continue; }
      const before = [...tok.trades].reverse().find((t) => t.t < now - ms && t.mcSol != null);
      const start = before?.mcSol ?? inWin.find((t) => t.mcSol != null)?.mcSol;
      const end = tok.mcSol ?? inWin.at(-1).mcSol;
      const usd = solUsd ?? 0;
      const buys = inWin.filter((t) => t.side === 'buy'), sells = inWin.filter((t) => t.side === 'sell');
      const sum = (l) => l.reduce((a, t) => a + (t.sol ?? 0), 0) * usd;
      out[k] = { change: start && end ? ((end - start) / start) * 100 : null, volUsd: sum(inWin), buys: buys.length, sells: sells.length, buyUsd: sum(buys), sellUsd: sum(sells), source: covered ? 'live' : 'partial' };
    }
    return out;
  }
  // Can the creator still mint more coins or freeze yours? Read once from the chain.
  function securityOf(tok) {
    if (tok.security) return tok.security;
    if (!tok.securityLoading) {
      tok.securityLoading = true;
      connection.getParsedAccountInfo(new PublicKey(tok.mint)).then((r) => {
        const info = r.value?.data?.parsed?.info;
        if (info) tok.security = { mintAuthority: Boolean(info.mintAuthority), freezeAuthority: Boolean(info.freezeAuthority), token2022: r.value.owner?.toString?.() === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCCEpPxuEb' };
      }).catch(() => {}).finally(() => { tok.securityLoading = false; });
    }
    return null;
  }
  const holderCache = new Map();
  const holdersLoading = new Set();
  function refreshHolders(tok) {
    const cached = holderCache.get(tok.mint);
    if ((cached && Date.now() - cached.at < 15_000) || holdersLoading.has(tok.mint)) return;
    holdersLoading.add(tok.mint);
    chainHolders(tok).catch(() => {}).finally(() => holdersLoading.delete(tok.mint));
  }
  async function chainHolders(tok) {
    const cached = holderCache.get(tok.mint);
    if (cached && Date.now() - cached.at < 15_000) return cached.list;
    const mintKey = new PublicKey(tok.mint);
    const [largest, supplyRes] = await Promise.all([connection.getTokenLargestAccounts(mintKey), connection.getTokenSupply(mintKey)]);
    const accounts = largest.value.slice(0, 20);
    const infos = await connection.getMultipleParsedAccounts(accounts.map((a) => a.address));
    const supply = Number(supplyRes.value.uiAmount) || SUPPLY;
    const list = accounts.map((a, i) => ({ owner: infos.value[i]?.data?.parsed?.info?.owner ?? a.address.toBase58(), pct: (Number(a.uiAmount ?? 0) / supply) * 100, amount: Number(a.uiAmount ?? 0) }));
    holderCache.set(tok.mint, { at: Date.now(), list });
    return list;
  }

  async function coin(mint) {
    let tok = tokens.get(mint);
    if (!tok) {
      new PublicKey(mint); // throws for a bad address
      tokens.set(mint, (tok = blankToken(mint)));
      follow(mint);
    }
    if (!tok.dex || Date.now() - tok.dex.at > 20_000) {
      // the first look waits a moment for DexScreener; after that the page never waits on it
      const pending = enrich([tok]).catch(() => {});
      if (!tok.name && !tok.dex && !tok.enrichTried) await Promise.race([pending, new Promise((r) => setTimeout(r, 1500))]);
      tok.enrichTried = true;
    }
    if (!tok.fromBirth && tok.trades.length < 20) geckoTrades(tok);
    wantMeta(tok);
    wantStory(tok);
    wantSite(tok);
    wantBackfill(tok, true);
    if (focus.has(mint)) watchPool(tok);
    const r = row(tok);
    const names = labels();
    const chain = holderCache.get(mint)?.list ?? [];
    refreshHolders(tok);
    const known = new Map(tok.wallets);
    const holderRows = [];
    const seen = new Set();
    const solBal = solBalances(tok, chain.slice(0, 20).map((h) => h.owner));
    const describe = (owner, pct) => {
      const w = known.get(owner);
      const l = names.get(owner);
      const pool = owner === tok.bondingCurveKey || (!w && pct > 15) ? (tok.migrated ? 'Liquidity pool' : 'Bonding curve') : null;
      return {
        wallet: owner, pct, label: pool ?? l?.label ?? null, pool: Boolean(pool), kol: Boolean(l?.kol), copied: Boolean(l?.copied),
        insider: Boolean(tok.analysis?.insiders.includes(owner)), funder: tok.analysis?.funders?.[owner] ?? null, solBalance: solBal.get(owner) ?? null,
        ...walletDetail(tok, w, pct),
      };
    };
    for (const h of chain) {
      seen.add(h.owner);
      holderRows.push(describe(h.owner, h.pct));
    }
    for (const [addr, w] of holders(tok)) {
      if (holderRows.length >= 60) break;
      if (!seen.has(addr)) holderRows.push(describe(addr, (w.bal / SUPPLY) * 100));
    }
    holderRows.sort((a, b) => b.pct - a.pct);
    const traders = [...tok.wallets]
      .map(([addr, w]) => ({ wallet: addr, label: names.get(addr)?.label ?? null, kol: Boolean(names.get(addr)?.kol), funder: tok.analysis?.funders?.[addr] ?? null, ...walletDetail(tok, w, (w.bal / SUPPLY) * 100) }))
      .sort((a, b) => b.pnlSol - a.pnlSol)
      .slice(0, 50);
    const early = [...tok.wallets]
      .filter(([, w]) => w.tags.has('sniper') || w.tags.has('bundler'))
      .map(([addr, w]) => ({ wallet: addr, label: names.get(addr)?.label ?? null, boughtPct: (w.boughtTok / SUPPLY) * 100, status: w.bal <= 1 ? 'sold all' : w.soldTok > 0 ? 'sold some' : 'holding', ...walletDetail(tok, w, (w.bal / SUPPLY) * 100) }))
      .sort((a, b) => b.boughtPct - a.boughtPct);
    const devHist = tok.creator ? history.devs[tok.creator] : null;
    return {
      ...r,
      windows: windowStats(tok),
      security: securityOf(tok),
      story: { tweet: tok.tweet ?? null, site: tok.site ?? null, loading: (tok.uri && !['done', 'failed'].includes(tok.metaState)) || tok.storyState === 'queued' || tok.siteState === 'loading' || (Boolean(tok.meta?.website) && !tok.siteState) || (/\/status(?:es)?\/\d+/.test(tok.meta?.twitter ?? '') && !tok.storyState) },
      solUsd,
      trades: tok.trades.slice(-200).reverse().map((tr) => decorateTrade(tok, tr)),
      holdersList: holderRows,
      topTraders: traders,
      early,
      devTokens: (devHist?.mints ?? []).filter((m) => m !== mint).map((m) => {
        const d = tokens.get(m);
        return { mint: m, name: d?.name ?? null, symbol: d?.symbol ?? null, migrated: d?.migrated ?? null, mcUsd: d?.mcSol != null && solUsd ? d.mcSol * solUsd : d?.dex?.mcUsd ?? null, athUsd: d?.athMcSol && solUsd ? d.athMcSol * solUsd : null, createdAt: d?.createdAt ?? null, progress: d ? progressOf(d) : null };
      }),
      feeRate: feeRate(tok),
      devCreated: devHist?.created ?? null,
      analysis: tok.analysis ? { at: tok.analysis.at, insiders: tok.analysis.insiders.length, clusters: tok.analysis.clusters } : null,
      pair: tok.dex?.pair ?? null,
      priceSource: !tok.migrated ? (tok.fromBirth || tok.trades.length ? 'feed' : 'waiting') : tok.poolWatch?.state === 'live' ? 'pool' : Date.now() - (tok.feedAmmTradeAt ?? 0) < 60_000 ? 'feed' : 'dexscreener',
      dexId: tok.dex?.dexId ?? null,
    };
  }

  /**
   * Insider check for one coin: who funded each top holder's wallet. Wallets funded by the creator (or by
   * whoever funded the creator) are insiders; several holders funded by the same new wallet are a cluster.
   * About 40 Solana requests, so it only runs when you ask.
   */
  async function analyze(mint) {
    const tok = tokens.get(mint);
    if (!tok) throw new Error('Open the coin first.');
    const holderList = (await chainHolders(tok)).filter((h) => h.pct < 15).slice(0, 15).map((h) => h.owner);
    const funderOf = async (address) => {
      const sigs = await connection.getSignaturesForAddress(new PublicKey(address), { limit: 1000 });
      if (!sigs.length || sigs.length >= 1000) return null; // a long-used wallet: its first funding is too far back
      const tx = await connection.getParsedTransaction(sigs.at(-1).signature, { maxSupportedTransactionVersion: 0 });
      for (const ix of tx?.transaction?.message?.instructions ?? []) {
        if (ix.parsed?.type === 'transfer' && ix.program === 'system' && ix.parsed.info?.destination === address) return ix.parsed.info.source;
      }
      return null;
    };
    const funders = {};
    const devFunder = tok.creator ? await funderOf(tok.creator).catch(() => null) : null;
    for (const h of holderList) {
      if (h === tok.creator) continue;
      funders[h] = await funderOf(h).catch(() => null);
      await new Promise((r) => setTimeout(r, 150));
    }
    const byFunder = {};
    for (const [h, f] of Object.entries(funders)) if (f) (byFunder[f] ??= []).push(h);
    const insiders = Object.entries(funders).filter(([h, f]) => f && (f === tok.creator || (devFunder && f === devFunder) || h === devFunder)).map(([h]) => h);
    const clusters = Object.values(byFunder).filter((list) => list.length >= 2).length;
    for (const list of Object.values(byFunder)) if (list.length >= 2) for (const h of list) wallet(tok, h).tags.add('cluster');
    tok.analysis = { at: Date.now(), insiders, funders, clusters };
    return { insiders: insiders.length, clusters, checked: holderList.length };
  }

  /**
   * Exact launch check from the chain: bundled buys land in the same block as the launch, before any live feed can
   * subscribe to a brand-new coin. Reads the coin's first transactions to tag who bought in the launch block
   * (bundlers) and the next few seconds (snipers). About 5-35 Solana requests, spaced out so copy trading stays fast;
   * runs once for coins that reach Final Stretch and whenever you open a coin.
   */
  const backfillQueue = [];
  let backfilling = false;
  function wantBackfill(tok, urgent = false) {
    if (!tok || tok.backfill || tok.backfillQueued || cfg.pulse?.backfill === 'off') return;
    tok.backfillQueued = true;
    urgent ? backfillQueue.unshift(tok) : backfillQueue.push(tok);
    if (backfillQueue.length > 20) backfillQueue.length = 20;
    runBackfills();
  }
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  async function runBackfills() {
    if (backfilling) return;
    backfilling = true;
    while (backfillQueue.length) {
      const tok = backfillQueue.shift();
      try {
        await backfill(tok);
      } catch (e) {
        tok.backfill = 'failed';
      }
      await pause(cfg.pulse?.backfillGapMs ?? 20_000); // at most a few per minute
    }
    backfilling = false;
  }
  async function backfill(tok) {
    const mintKey = new PublicKey(tok.mint);
    let sigs = [];
    let before;
    for (let page = 0; page < 5; page++) {
      const batch = await connection.getSignaturesForAddress(mintKey, { limit: 1000, before });
      sigs = sigs.concat(batch);
      if (batch.length < 1000) break;
      before = batch.at(-1).signature;
      await pause(250);
    }
    const complete = sigs.length && sigs.length % 1000 !== 0;
    if (!complete) return void (tok.backfill = 'partial');
    const ok = sigs.filter((x) => !x.err);
    const launchSlot = ok.at(-1)?.slot;
    const early = ok.filter((x) => x.slot <= launchSlot + 10).reverse().slice(0, 30);
    const found = new Map();
    for (const sig of early) {
      const tx = await connection.getParsedTransaction(sig.signature, { maxSupportedTransactionVersion: 0 });
      await pause(250);
      if (!tx?.meta) continue;
      const pre = new Map();
      for (const b of tx.meta.preTokenBalances ?? []) if (b.mint === tok.mint) pre.set(b.owner, Number(b.uiTokenAmount.uiAmount ?? 0));
      for (const b of tx.meta.postTokenBalances ?? []) {
        if (b.mint !== tok.mint || !b.owner || b.owner === tok.bondingCurveKey) continue;
        const got = Number(b.uiTokenAmount.uiAmount ?? 0) - (pre.get(b.owner) ?? 0);
        if (got > 0) found.set(b.owner, { slot: sig.slot, got, after: Number(b.uiTokenAmount.uiAmount ?? 0), sol: 0 });
      }
    }
    const creator = tok.creator ?? found.keys().next().value;
    for (const w of tok.wallets.values()) {
      w.tags.delete('bundler');
      w.tags.delete('sniper');
    }
    for (const [owner, f] of found) {
      const w = wallet(tok, owner);
      if (!w.buys) {
        w.buys = 1;
        w.boughtTok = f.got;
        w.bal = f.after;
        w.firstAt = (tok.createdAt ?? Date.now()) + (f.slot - launchSlot) * 400;
      }
      if (owner === creator) continue;
      if (f.slot === launchSlot) w.tags.add('bundler');
      if (f.slot <= launchSlot + 10) w.tags.add('sniper');
    }
    tok.fromBirth = true;
    tok.backfill = 'exact';
  }

  /** Candles for coins SolBoy didn't follow from launch (GeckoTerminal, free). */
  const geckoPools = new Map();
  async function geckoPool(mint) {
    if (geckoPools.has(mint)) return geckoPools.get(mint);
    const pools = await getJson(`${GECKO_API()}/networks/solana/tokens/${mint}/pools?page=1`, 6000);
    const pool = pools.data?.[0]?.attributes?.address ?? null;
    geckoPools.set(mint, pool);
    if (geckoPools.size > 300) geckoPools.delete(geckoPools.keys().next().value);
    return pool;
  }
  /** The last few hundred trades of a coin SolBoy didn't follow from launch, so its page isn't empty. */
  async function geckoTrades(tok) {
    if (tok.geckoTradesAt && Date.now() - tok.geckoTradesAt < 60_000) return;
    tok.geckoTradesAt = Date.now();
    try {
      const pool = await geckoPool(tok.mint);
      if (!pool) return void chainTrades(tok);
      const d = await getJson(`${GECKO_API()}/networks/solana/pools/${pool}/trades`, 6000);
      const have = new Set(tok.trades.map((t) => t.sig));
      const usd = solUsd;
      const got = [];
      for (const x of d.data ?? []) {
        const a = x.attributes ?? {};
        if (!a.tx_hash || have.has(a.tx_hash) || (a.kind !== 'buy' && a.kind !== 'sell')) continue;
        const buy = a.kind === 'buy';
        const sol = num(buy ? a.from_token_amount : a.to_token_amount);
        const tokens = num(buy ? a.to_token_amount : a.from_token_amount);
        const priceUsd = num(buy ? a.price_to_in_usd : a.price_from_in_usd);
        const t = Date.parse(a.block_timestamp);
        if (sol == null || !Number.isFinite(t)) continue;
        got.push({ sig: a.tx_hash, t, side: a.kind, wallet: a.tx_from_address ?? null, sol, tokens: tokens ?? 0, mcSol: priceUsd && usd ? (priceUsd * SUPPLY) / usd : null, source: 'history' });
      }
      if (!got.length) return void chainTrades(tok);
      tok.trades = [...got, ...tok.trades].sort((a, b) => a.t - b.t).slice(-TRADES_KEPT);
      stats.geckoOk++;
    } catch {
      stats.geckoFail++;
      chainTrades(tok);
    }
  }
  /** The coin's latest trades read straight from the chain (your Helius key), when GeckoTerminal has none. */
  async function chainTrades(tok) {
    if (tok.chainTradesAt && Date.now() - tok.chainTradesAt < 120_000) return;
    tok.chainTradesAt = Date.now();
    try {
      const addr = !tok.migrated && tok.bondingCurveKey ? tok.bondingCurveKey : tok.dex?.pair ?? tok.mint;
      const sigs = await connection.getSignaturesForAddress(new PublicKey(addr), { limit: 80 });
      const have = new Set(tok.trades.map((t) => t.sig));
      const todo = sigs.filter((x) => !x.err && !have.has(x.signature)).map((x) => x.signature);
      const got = [];
      for (let i = 0; i < todo.length; i += 20) {
        const txs = await connection.getParsedTransactions(todo.slice(i, i + 20), { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
        for (const tx of txs) {
          const keys = tx?.transaction?.message?.accountKeys ?? [];
          const trader = (keys[0]?.pubkey ?? keys[0])?.toString();
          if (!trader) continue;
          for (const t of parseTrades(tx, trader)) {
            if (t.mint !== tok.mint) continue;
            const tokens = Number(t.tokenAmount) / 1e6;
            got.push({ sig: tx.transaction.signatures[0], t: (tx.blockTime ?? 0) * 1000, side: t.side, wallet: trader, sol: t.solAmount, tokens, mcSol: tokens ? (t.solAmount / tokens) * SUPPLY : null, source: 'chain' });
          }
        }
      }
      if (!got.length) return;
      tok.trades = [...got, ...tok.trades].sort((a, b) => a.t - b.t).slice(-TRADES_KEPT);
      stats.chainOk = (stats.chainOk ?? 0) + 1;
    } catch {
      stats.chainFail = (stats.chainFail ?? 0) + 1;
    }
  }
  async function history5m(mint) {
    const tok = tokens.get(mint);
    if (tok?.fromBirth && tok.trades.length) return []; // SolBoy has every trade: the page draws the chart itself
    try {
      const pool = await geckoPool(mint);
      if (!pool) return [];
      const o = await getJson(`${GECKO_API()}/networks/solana/pools/${pool}/ohlcv/minute?aggregate=1&limit=500&currency=usd&token=base`, 6000);
      return (o.data?.attributes?.ohlcv_list ?? []).map(([t, op, hi, lo, cl, v]) => ({ t: t * 1000, o: op, h: hi, l: lo, c: cl, v })).reverse();
    } catch {
      return [];
    }
  }

  /** Price of a coin in SOL per token, from the live feed (for paper trades and PnL). */
  function priceSol(mint) {
    const t = tokens.get(mint);
    if (t?.mcSol != null) return t.mcSol / SUPPLY;
    if (t?.dex?.priceUsd && solUsd) return t.dex.priceUsd / solUsd;
    return null;
  }
  function curveOf(mint) {
    const t = tokens.get(mint);
    return t && !t.migrated && t.protocol === 'pump' && t.vSol && t.vTokens ? { vSol: t.vSol, vTokens: t.vTokens } : null;
  }

  // ---- fill the columns right away: the last saved board, then Pump.fun's own lists ----
  function seedCoin(c) {
    if (!c?.mint || typeof c.mint !== 'string') return;
    try { new PublicKey(c.mint); } catch { return; }
    let tok = tokens.get(c.mint);
    if (tok?.fromBirth) return;
    if (!tok) tokens.set(c.mint, (tok = blankToken(c.mint)));
    tok.seeded = true;
    tok.name ||= String(c.name ?? '').slice(0, 60);
    tok.symbol ||= String(c.symbol ?? '').slice(0, 20);
    tok.uri ||= c.metadata_uri ?? null;
    tok.creator ||= c.creator ?? null;
    tok.createdAt ||= num(c.created_timestamp);
    if (c.bonding_curve) tok.bondingCurveKey = c.bonding_curve;
    const vSol = num(c.virtual_sol_reserves), vTok = num(c.virtual_token_reserves);
    if (!tok.lastTradeAt || num(c.last_trade_timestamp) > tok.lastTradeAt) {
      if (vSol && vTok) { tok.vSol = vSol / 1e9; tok.vTokens = vTok / 1e6; }
      const mc = num(c.market_cap) ?? (tok.vSol && tok.vTokens ? (tok.vSol / tok.vTokens) * SUPPLY : null);
      if (mc != null) { tok.mcSol = mc; tok.athMcSol = Math.max(tok.athMcSol, mc); }
      tok.lastTradeAt = num(c.last_trade_timestamp) ?? tok.lastTradeAt;
    }
    if (c.complete && !tok.migrated) {
      tok.migrated = true;
      tok.migratedAt = num(c.last_trade_timestamp) ?? Date.now();
    }
    if (!tok.meta && (c.image_uri || c.twitter || c.website || c.telegram)) {
      const str = (x) => (typeof x === 'string' && x ? x.slice(0, 200) : null);
      tok.meta = { image: str(c.image_uri), description: String(c.description ?? '').slice(0, 400), twitter: str(c.twitter), telegram: str(c.telegram), website: str(c.website) };
      tok.metaState = 'done';
    }
    follow(c.mint);
  }
  let lastSeed = 0;
  async function seedFromPump() {
    lastSeed = Date.now();
    const lists = [
      'sort=created_timestamp&order=DESC',
      'sort=market_cap&order=DESC&complete=false',
      'sort=last_trade_timestamp&order=DESC&complete=true',
    ];
    const results = await Promise.allSettled(lists.map((q) => getJson(`${PUMP_API()}/coins?offset=0&limit=50&includeNsfw=false&${q}`, 8000)));
    let n = 0;
    for (const r of results) if (r.status === 'fulfilled' && Array.isArray(r.value)) for (const c of r.value) { seedCoin(c); n++; }
    stats.seed = n;
    stats.seedError = results.find((r) => r.status === 'rejected')?.reason?.message ?? null;
    if (n) log(`Pulse loaded ${n} coins from Pump.fun to fill the columns.`);
    if (n < 40) await seedFromGecko().catch(() => {});
  }
  // GeckoTerminal lists Pump.fun curve pools and PumpSwap pools for free: a second way to fill the columns.
  const PUMP_K = 30 * PUMP_START_VTOKENS; // constant product of a Pump.fun curve (SOL x tokens, virtual)
  async function seedFromGecko() {
    if (!solUsd) await refreshSolPrice();
    if (!solUsd) return;
    const lists = [
      'networks/solana/new_pools?page=1&include=base_token,dex',
      'networks/solana/dexes/pump-fun/pools?page=1&sort=h24_volume_usd_desc&include=base_token,dex',
      'networks/solana/dexes/pumpswap/pools?page=1&sort=h24_volume_usd_desc&include=base_token,dex',
    ];
    const results = await Promise.allSettled(lists.map((q) => getJson(`${GECKO_API()}/${q}`, 8000)));
    let n = 0;
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      const tokensById = new Map((r.value.included ?? []).filter((x) => x.type === 'token').map((x) => [x.id, x.attributes ?? {}]));
      for (const pool of r.value.data ?? []) {
        const a = pool.attributes ?? {};
        const dexId = pool.relationships?.dex?.data?.id ?? '';
        const baseId = pool.relationships?.base_token?.data?.id ?? '';
        const mint = baseId.replace(/^solana_/, '');
        const curve = dexId === 'pump-fun';
        const migrated = /pumpswap|pump-swap/.test(dexId);
        if (!mint || (!curve && !migrated)) continue;
        const tk = tokensById.get(baseId) ?? {};
        const mcSol = (num(a.market_cap_usd) ?? num(a.fdv_usd) ?? 0) / solUsd;
        if (!(mcSol > 0)) continue;
        const created = Date.parse(a.pool_created_at) || null;
        const c = { mint, name: tk.name ?? String(a.name ?? '').split(' / ')[0], symbol: tk.symbol ?? String(a.name ?? '').split(' / ')[0], market_cap: mcSol, last_trade_timestamp: Date.now(), complete: migrated };
        if (tk.image_url && !/missing/.test(tk.image_url)) c.image_uri = tk.image_url;
        if (curve) {
          const vTokens = Math.sqrt((PUMP_K * SUPPLY) / mcSol); // where on the curve this market cap sits
          c.virtual_token_reserves = vTokens * 1e6;
          c.virtual_sol_reserves = (PUMP_K / vTokens) * 1e9;
          c.created_timestamp = created;
        } else c.last_trade_timestamp = created ?? Date.now(); // used as the migration time
        seedCoin(c);
        n++;
      }
    }
    stats.gecko = n;
    if (n) log(`Pulse loaded ${n} coins from GeckoTerminal to fill the columns.`);
  }
  function saveCache() {
    const keep = [...tokens.values()].filter((t) => t.name && (t.mcSol != null || t.migrated)).sort((a, b) => (b.lastTradeAt ?? b.seenAt) - (a.lastTradeAt ?? a.seenAt)).slice(0, 500);
    const pick = (t) => ({
      mint: t.mint, name: t.name, symbol: t.symbol, uri: t.uri, protocol: t.protocol, creator: t.creator, createdAt: t.createdAt, bondingCurveKey: t.bondingCurveKey,
      vSol: t.vSol, vTokens: t.vTokens, mcSol: t.mcSol, athMcSol: t.athMcSol, migrated: t.migrated, migratedAt: t.migratedAt, pool: t.pool,
      buys: t.buys, sells: t.sells, volSol: t.volSol, lastTradeAt: t.lastTradeAt, meta: t.meta, trades: t.trades.slice(-80), tweet: t.tweet ?? null,
      fromBirth: t.fromBirth, backfill: t.backfill === 'exact' ? 'exact' : undefined,
      // the biggest wallets with their dev/sniper/bundler tags, so those numbers survive a restart
      wallets: [...t.wallets].sort((a, b) => b[1].bal - a[1].bal).slice(0, 40).map(([a, w]) => [a, { ...w, tags: [...w.tags] }]),
    });
    try { saveJson(cacheFile, { at: Date.now(), tokens: keep.map(pick) }); } catch {}
  }
  try {
    const saved = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (Date.now() - saved.at < 6 * 3600_000) {
      for (const c of saved.tokens ?? []) {
        if (!c?.mint || tokens.has(c.mint)) continue;
        const wallets = new Map((Array.isArray(c.wallets) ? c.wallets : []).map(([a, w]) => [a, { ...w, tags: new Set(w.tags ?? []) }]));
        const tok = Object.assign(blankToken(c.mint), c, { trades: Array.isArray(c.trades) ? c.trades : [], wallets, fromBirth: Boolean(c.fromBirth), restored: true });
        if (tok.tweet) tok.storyState = 'done';
        tok.metaState = tok.meta ? 'done' : 'none';
        tokens.set(c.mint, tok);
        if (Date.now() - (tok.lastTradeAt ?? 0) < 6 * 3600_000) follow(c.mint);
      }
    }
  } catch {}
  setInterval(saveCache, 60_000).unref();
  seedFromPump().catch(() => {});
  setInterval(() => viewers > 0 && Date.now() - lastSeed > 90_000 && seedFromPump().catch(() => {}), 15_000).unref();

  // ---- coin pictures: fetched once through the fastest IPFS gateway, then served from memory ----
  const imgCache = new Map();
  const imgFail = new Map();
  const imgInflight = new Map();
  let imgBytes = 0;
  function fetchImage(mint) {
    const tok = tokens.get(mint);
    const src = tok?.meta?.cdnImage || tok?.meta?.image || tok?.dex?.image;
    if (!src) return null;
    const hit = imgCache.get(mint);
    if (hit) {
      imgCache.delete(mint);
      imgCache.set(mint, hit);
      return hit;
    }
    if (Date.now() - (imgFail.get(mint) ?? 0) < 60_000) return null;
    if (imgInflight.has(mint)) return imgInflight.get(mint);
    const cid = ipfsCid(src);
    const urls = [...new Set([src, ...(cid ? gwRank(GATEWAYS).map((g) => g + cid) : [])])].filter((u) => publicUrl(u) || (allowLocal() && /^http:\/\/127\.0\.0\.1/.test(u)));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12_000);
    // try the coin's own link first, then one more gateway every 1.5 seconds, and keep the first that answers
    const p = Promise.any(urls.map(async (u, i) => {
      if (i) await new Promise((r) => setTimeout(r, i * 350)); // the next server gets asked after 0.35s, not seconds
      if (ctrl.signal.aborted) throw new Error('done');
      const res = await fetch(u, { signal: ctrl.signal });
      const type = res.headers.get('content-type') ?? '';
      if (!res.ok || !/^image\//.test(type) || Number(res.headers.get('content-length') ?? 0) > 3e6) throw new Error('not an image');
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 3e6) throw new Error('too big');
      return { type, buf };
    }))
      .then((v) => {
        stats.imgOk++;
        imgCache.set(mint, v);
        imgBytes += v.buf.length;
        while (imgBytes > 80e6 || imgCache.size > 800) {
          const [k, old] = imgCache.entries().next().value;
          imgCache.delete(k);
          imgBytes -= old.buf.length;
        }
        return v;
      })
      .catch(() => {
        stats.imgFail++;
        // no gateway answered: get Helius's copy of the picture for next time
        if (tok && !tok.meta?.cdnImage && dasLeft()) dasAsset(mint).then((d) => { if (d.image) { tok.meta = { ...(tok.meta ?? {}), cdnImage: d.image, image: tok.meta?.image ?? d.image }; imgFail.delete(mint); } }).catch(() => {});
        imgFail.set(mint, Date.now());
        if (imgFail.size > 2000) imgFail.delete(imgFail.keys().next().value);
        return null;
      })
      .finally(() => {
        ctrl.abort();
        clearTimeout(timer);
        imgInflight.delete(mint);
      });
    imgInflight.set(mint, p);
    return p;
  }

  connect();
  log('Pulse is listening for new coins (PumpPortal live feed).');

  return {
    board,
    coin,
    analyze,
    history: history5m,
    /** Live check of every outside source Pulse uses, run from this computer. */
    async health() {
      const timed = (p, ms = 8000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('no answer in 8s')), ms))]);
      const check = async (name, fn) => { const t0 = Date.now(); try { return { name, ok: true, detail: await timed(fn()), ms: Date.now() - t0 }; } catch (e) { return { name, ok: false, detail: e.message, ms: Date.now() - t0 }; } };
      const recent = [...tokens.values()].filter((t) => t.meta?.image || t.dex?.image).sort((a, b) => (b.lastTradeAt ?? 0) - (a.lastTradeAt ?? 0));
      const WIF = 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm';
      const pct = (ok, bad) => (ok + bad ? `${Math.round((ok / (ok + bad)) * 100)}% of ${ok + bad}` : 'none tried yet');
      return Promise.all([
        check('Live coin feed (PumpPortal)', async () => {
          if (wsState !== 'live') throw new Error(`feed is ${wsState}`);
          if (Date.now() - lastMessageAt > 60_000) throw new Error('connected, but no coins in the last minute');
          const tpm = tradeTicks.filter((x) => Date.now() - x < 60_000).length;
          if (subscribed.size > 20 && tpm === 0) throw new Error(`new coins arrive, but no trades in the last minute (following ${subscribed.size} coins): holders, snipers and bundles can't fill in`);
          return `live, ${tokens.size} coins tracked, ${tpm} trades in the last minute, last message ${Math.round((Date.now() - lastMessageAt) / 1000)}s ago`;
        }),
        check('Pump.fun coin lists', async () => {
          const list = await getJson(`${PUMP_API()}/coins?offset=0&limit=5&sort=market_cap&order=DESC&includeNsfw=false&complete=false`, 8000);
          if (!Array.isArray(list) || !list.length) throw new Error('answered, but with no coins');
          return `${list.length} coins, e.g. $${clip(list[0].symbol, 12)}`;
        }),
        check('Coin details from Helius (backup for pictures)', async () => {
          const d = await dasAsset('EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm');
          if (!d.jsonUri && !d.image) throw new Error('answered, but with no details');
          return `ok (${dasUsed} of ${DAS_DAILY} daily lookups used)`;
        }),
        check('Coin pictures (IPFS)', async () => {
          if (!recent.length) throw new Error('no coin pictures known yet; wait a minute and check again');
          const v = await fetchImage(recent[0].mint);
          if (!v) throw new Error(`couldn't load $${recent[0].symbol}'s picture (all time: ${pct(stats.imgOk, stats.imgFail)} loaded)`);
          return `$${recent[0].symbol}'s picture loaded; all time ${pct(stats.imgOk, stats.imgFail)}; coin details ${pct(stats.metaOk, stats.metaFail)}`;
        }),
        check('X posts', async () => {
          const t = await fetchTweet('https://x.com/elonmusk/status/1585341984679469056');
          if (!t?.text) throw new Error('answered, but with no post');
          return `post loaded; coins so far: ${pct(stats.tweetOk, stats.tweetFail)}`;
        }),
        check('Older trades and charts (GeckoTerminal)', async () => {
          const d = await getJson(`${GECKO_API()}/networks/solana/tokens/${WIF}/pools?page=1`, 8000);
          if (!d.data?.length) throw new Error('answered, but with no pools');
          return `ok; coins so far: ${pct(stats.geckoOk, stats.geckoFail)}`;
        }),
        check('Market data (DexScreener)', async () => {
          const d = await getJson(`${dexApi()}/tokens/v1/solana/${WIF}`, 8000);
          if (!Array.isArray(d) || !d.length) throw new Error('answered, but with no pairs');
          return `ok, $WIF at $${Number(d[0].priceUsd).toPrecision(4)}`;
        }),
        check('Your Solana connection (Helius)', async () => `ok, slot ${await connection.getSlot('processed')}`),
        check('SOL price', async () => {
          if (!solUsd) throw new Error('no SOL price yet');
          return `$${solUsd.toFixed(2)}`;
        }),
      ]);
    },
    storyFacts(mint) {
      const t = tokens.get(mint);
      if (!t) return null;
      const r = row(t);
      return { name: r.name, symbol: r.symbol, description: r.description || null, ageMinutes: Math.round(r.ageSec / 60), marketCapUsd: r.mcUsd != null ? Math.round(r.mcUsd) : null,
        xLink: t.meta?.twitter ?? null, xPost: t.tweet ? { by: `${t.tweet.author} (@${t.tweet.handle})${t.tweet.verified ? ', verified' : ''}`, text: t.tweet.text, likes: t.tweet.likes, quoting: t.tweet.quote } : null,
        website: t.site ? { title: t.site.title, description: t.site.description } : t.meta?.website ?? null, telegram: Boolean(t.meta?.telegram), cacheKey: `${t.tweet?.text ?? ''}|${t.site?.title ?? ''}|${r.description}` };
    },
    setNarrative(mint, n) { const t = tokens.get(mint); if (t) t.narrative = n; },
    getNarrative: (mint) => tokens.get(mint)?.narrative ?? null,
    image: fetchImage,
    priceSol,
    curveOf,
    status: () => ({ feed: wsState === 'live' && Date.now() - lastMessageAt > 120_000 ? 'quiet' : wsState, solUsd, tracking: tokens.size, live: subscribed.size, delaySec: feedDelay(), tpm: tradeTicks.filter((x) => Date.now() - x < 60_000).length }),
    viewing(delta) {
      viewers = Math.max(0, viewers + delta);
    },
    filters: () => filters,
    setFilters(next) {
      if (!next?.presets) throw new Error('Bad filters.');
      filters = { active: [1, 2, 3].includes(Number(next.active)) ? Number(next.active) : 1, presets: next.presets };
      saveJson(settingsFile, filters);
      return filters;
    },
    open(mint) {
      focus.set(mint, (focus.get(mint) ?? 0) + 1);
      follow(mint);
      const t = tokens.get(mint);
      if (t?.migrated) watchPool(t);
      if (t && !t.fromBirth && t.trades.length < 20) geckoTrades(t);
    },
    close(mint) {
      const n = (focus.get(mint) ?? 1) - 1;
      if (n > 0) return focus.set(mint, n);
      focus.delete(mint);
      setTimeout(() => !focus.has(mint) && unwatchPool(tokens.get(mint)), 30_000); // a short grace period for page reloads
    },
    onTrade(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    protocols: PROTOCOLS,
    stop() {
      saveCache();
      wsState = 'stopped';
      ws?.close();
    },
  };
}
