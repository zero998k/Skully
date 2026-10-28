import fs from 'node:fs';
import path from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { file } from './paths.js';
import { log } from './log.js';
import { dexApi } from './endpoints.js';

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
const MAX_TOKENS = 1500;
const MAX_SUBSCRIBED = 600;
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

const GATEWAYS = ['https://ipfs.io/ipfs/', 'https://cf-ipfs.com/ipfs/', 'https://gateway.pinata.cloud/ipfs/', 'https://dweb.link/ipfs/'];
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
export function passes(row, f) {
  if (!f) return true;
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

  function onTrade(d) {
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
    if (tok.metaState !== 'none' || !tok.uri) return;
    tok.metaState = 'queued';
    metaQueue.push(tok);
    pumpMeta();
  }
  function pumpMeta() {
    while (metaBusy < 4 && metaQueue.length) {
      const tok = metaQueue.shift();
      metaBusy++;
      loadMeta(tok).finally(() => {
        metaBusy--;
        pumpMeta();
      });
    }
  }
  async function loadMeta(tok) {
    const cid = /\/ipfs\/([^?#]+)/.exec(tok.uri)?.[1] ?? /^ipfs:\/\/(.+)$/.exec(tok.uri)?.[1];
    const urls = [...new Set([tok.uri, ...(cid ? GATEWAYS.map((g) => g + cid) : [])])].filter((u) => publicUrl(u) || (allowLocal() && /^http:\/\/127\.0\.0\.1/.test(u)));
    try {
      const m = await Promise.any(urls.map((u) => getJson(u, 5000)));
      const image = typeof m.image === 'string' ? m.image.replace(/^ipfs:\/\//, 'https://ipfs.io/ipfs/') : null;
      tok.meta = {
        image: image && (publicUrl(image) || allowLocal()) ? image : null,
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
    } catch {
      tok.metaState = 'failed';
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
      createdAt: t.createdAt ?? t.dex?.pairCreatedAt ?? null,
      ageSec: Math.round((Date.now() - (t.createdAt ?? t.dex?.pairCreatedAt ?? t.seenAt)) / 1000),
      migrated: t.migrated, migratedAt: t.migratedAt, progress: progressOf(t),
      priceSol: t.mcSol != null ? t.mcSol / SUPPLY : null, mcSol: t.mcSol, mcUsd, athMcUsd: t.athMcSol && usd ? t.athMcSol * usd : null,
      liqUsd: onCurve && usd ? Math.max(0, t.vSol - 30) * usd * 2 : t.dex?.liqUsd ?? null,
      volUsd: t.migrated && t.dex?.volUsd != null ? Math.max(t.dex.volUsd, t.volSol * usd) : usd ? t.volSol * usd : t.dex?.volUsd ?? null,
      feesUsd: usd ? t.volSol * usd * 0.0125 : null,
      txns: t.buys + t.sells || (t.dex ? (t.dex.buys ?? 0) + (t.dex.sells ?? 0) : 0), buys: t.buys || t.dex?.buys || 0, sells: t.sells || t.dex?.sells || 0,
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
    for (const t of tokens.values()) {
      if (!t.name && !t.dex) continue;
      cols[column(t)].push(t);
    }
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
      for (const r of rows) wantMeta(tokens.get(r.mint));
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
    return { ...tr, mcUsd: tr.mcSol != null && solUsd ? tr.mcSol * solUsd : null, usd: solUsd ? tr.sol * solUsd : null, tags: w ? [...w.tags] : [], label: l?.label ?? null, kol: Boolean(l?.kol) };
  }

  const holderCache = new Map();
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
    if (!tok.dex || Date.now() - tok.dex.at > 20_000) await enrich([tok]);
    wantMeta(tok);
    wantBackfill(tok, true);
    if (focus.has(mint)) watchPool(tok);
    const r = row(tok);
    const names = labels();
    let chain = [];
    try {
      chain = await chainHolders(tok);
    } catch {}
    const known = new Map(tok.wallets);
    const holderRows = [];
    const seen = new Set();
    const describe = (owner, pct) => {
      const w = known.get(owner);
      const l = names.get(owner);
      const pool = owner === tok.bondingCurveKey || (!w && pct > 15) ? (tok.migrated ? 'Liquidity pool' : 'Bonding curve') : null;
      return {
        wallet: owner, pct, label: pool ?? l?.label ?? null, pool: Boolean(pool), kol: Boolean(l?.kol), copied: Boolean(l?.copied),
        tags: w ? [...w.tags] : [], buySol: w?.buySol ?? null, sellSol: w?.sellSol ?? null, buys: w?.buys ?? null, sells: w?.sells ?? null,
        insider: Boolean(tok.analysis?.insiders.includes(owner)), funder: tok.analysis?.funders?.[owner] ?? null,
        pnlSol: w && solUsd != null && tok.mcSol != null ? w.sellSol + (w.bal * tok.mcSol) / SUPPLY - w.buySol : null,
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
      .map(([addr, w]) => ({ wallet: addr, label: names.get(addr)?.label ?? null, kol: Boolean(names.get(addr)?.kol), tags: [...w.tags], buySol: w.buySol, sellSol: w.sellSol, buys: w.buys, sells: w.sells, holdingPct: (w.bal / SUPPLY) * 100, pnlSol: w.sellSol + (w.bal * (tok.mcSol ?? 0)) / SUPPLY - w.buySol }))
      .sort((a, b) => b.pnlSol - a.pnlSol)
      .slice(0, 50);
    const early = [...tok.wallets]
      .filter(([, w]) => w.tags.has('sniper') || w.tags.has('bundler'))
      .map(([addr, w]) => ({ wallet: addr, tags: [...w.tags], boughtPct: (w.boughtTok / SUPPLY) * 100, holdingPct: (w.bal / SUPPLY) * 100, buySol: w.buySol, sellSol: w.sellSol, status: w.bal <= 1 ? 'sold all' : w.soldTok > 0 ? 'sold some' : 'holding' }))
      .sort((a, b) => b.boughtPct - a.boughtPct);
    const devHist = tok.creator ? history.devs[tok.creator] : null;
    return {
      ...r,
      solUsd,
      trades: tok.trades.slice(-200).reverse().map((tr) => decorateTrade(tok, tr)),
      holdersList: holderRows,
      topTraders: traders,
      early,
      devTokens: (devHist?.mints ?? []).filter((m) => m !== mint).map((m) => ({ mint: m, name: tokens.get(m)?.name ?? null, symbol: tokens.get(m)?.symbol ?? null, migrated: tokens.get(m)?.migrated ?? null })),
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
  async function history5m(mint) {
    try {
      const pools = await getJson(`${GECKO_API()}/networks/solana/tokens/${mint}/pools?page=1`, 6000);
      const pool = pools.data?.[0]?.attributes?.address;
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

  connect();
  log('Pulse is listening for new coins (PumpPortal live feed).');

  return {
    board,
    coin,
    analyze,
    history: history5m,
    priceSol,
    curveOf,
    status: () => ({ feed: wsState === 'live' && Date.now() - lastMessageAt > 120_000 ? 'quiet' : wsState, solUsd, tracking: tokens.size, live: subscribed.size, delaySec: feedDelay() }),
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
      wsState = 'stopped';
      ws?.close();
    },
  };
}
