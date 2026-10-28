// Wallet Finder: a deep profile of any wallet (portfolio, trading record, PnL calendar, style, linked wallets),
// the early buyers of a coin that ran, and a replay of what copying a wallet would have made. Everything is read
// from the chain with the owner's own RPC key (on the background lane, so copy trading always goes first), plus
// DexScreener / Jupiter for prices. Results are saved in data/finder so a wallet opens instantly the next time.
import fs from 'node:fs';
import path from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { parseTrades, WSOL } from './detect.js';
import { dexApi } from './endpoints.js';
import { file } from './paths.js';
import { short } from './log.js';

const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCCEpPxuEb');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWAN6qDZTWnPC9DH');
const SOL_PRICE_URL = () => process.env.SOL_PRICE_URL || `https://lite-api.jup.ag/price/v3?ids=${WSOL}`;
const LAMPORTS = 1e9;
const HISTORY_SIGS = 1500; // transactions read for a profile
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Exchange hot wallets: money from or to these says nothing about who owns a wallet, so they never count as links.
const EXCHANGES = new Map([
  ['5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9', 'Binance'], ['9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', 'Binance'],
  ['2ojv9BAiHUrvsm9gxDe7fJSzbNZSJcxZvf8dqmWGHG8S', 'Binance'], ['H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS', 'Coinbase'],
  ['2AQdpHJ2JpcEgPiATUXjQxA8QmafFegfQwSLWSprPicm', 'Coinbase'], ['GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE', 'Coinbase'],
  ['FWznbcNXWQuHTawe9RxvQ2LdCENssh12dsznf4RiouN5', 'Kraken'], ['5VCwKtCXgCJ6kit5FybXjvriW3xELsFDhYrPSqtJNmcD', 'OKX'],
  ['AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2', 'Bybit'], ['ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ', 'MEXC'],
  ['u6PJ8DtQuPFnfmwHbGFULQ4u4EgjDiyYKjVEsynXq2w', 'Gate.io'], ['BmFdpraQhkiDQE6SnfG5omcA1VwzqfXrwtNYBwWTymy6', 'KuCoin'],
]);
const IGNORE = new Set(['11111111111111111111111111111111', WSOL, TOKEN_PROGRAM.toBase58(), TOKEN_2022.toBase58()]);

const dayKey = (sec) => {
  const d = new Date(sec * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const median = (list) => {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/** Remember the details of each copied buy (tokens received, source wallet) for Hypothetical PnL. */
export function recordCopy(row) {
  try {
    fs.mkdirSync(file('data'), { recursive: true });
    fs.appendFileSync(file('data/copies.jsonl'), JSON.stringify({ at: Date.now(), ...row }) + '\n');
  } catch {}
}
function readCopies() {
  try {
    return fs.readFileSync(file('data/copies.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

export function createFinder({ cfg, connection, bot }) {
  const dir = file('data/finder');
  const jobs = new Map(); // key -> { state, step, result, error, at }
  let solUsd = null, solUsdAt = 0;

  async function getJson(url, ms = 6000) {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(ms) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
  async function solPrice() {
    if (solUsd && Date.now() - solUsdAt < 60_000) return solUsd;
    try {
      const d = await getJson(SOL_PRICE_URL());
      const p = Number(Object.values(d)[0]?.usdPrice ?? d.data?.[WSOL]?.price);
      if (p > 0) { solUsd = p; solUsdAt = Date.now(); }
    } catch {}
    return solUsd;
  }
  // Names, pictures and prices (in SOL) from DexScreener, 30 coins per request.
  async function coinInfo(mints) {
    const out = new Map();
    const list = [...new Set(mints)];
    for (let i = 0; i < list.length; i += 30) {
      try {
        const pairs = await getJson(`${dexApi()}/tokens/v1/solana/${list.slice(i, i + 30).join(',')}`);
        for (const p of Array.isArray(pairs) ? pairs : []) {
          const m = p.baseToken?.address;
          if (!m) continue;
          const liq = Number(p.liquidity?.usd ?? 0);
          if (out.has(m) && out.get(m).liq >= liq) continue;
          out.set(m, { symbol: p.baseToken.symbol, name: p.baseToken.name, image: p.info?.imageUrl ?? null, priceSol: Number(p.priceNative) || null, mcUsd: Number(p.marketCap ?? p.fdv) || null, liq });
        }
      } catch {}
    }
    return out;
  }

  // ---- reading the chain ----
  async function signatures(address, max, until = null, onPage = null) {
    const all = [];
    let before;
    while (all.length < max) {
      const page = await connection.getSignaturesForAddress(new PublicKey(address), { limit: Math.min(1000, max - all.length), before, until: until ?? undefined });
      all.push(...page);
      onPage?.(all.length);
      if (page.length < 1000) break;
      before = page.at(-1).signature;
    }
    return all;
  }
  async function parsed(sigs, onStep) {
    const out = [];
    for (let i = 0; i < sigs.length; i += 10) {
      const batch = sigs.slice(i, i + 10);
      let txs;
      try {
        txs = await connection.getParsedTransactions(batch, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
      } catch {
        // one transaction in a newer format can fail the whole batch: read them one by one instead
        txs = [];
        for (const s of batch) txs.push(await connection.getParsedTransaction(s, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }).catch(() => null));
      }
      out.push(...txs);
      onStep?.(Math.min(sigs.length, i + 10), sigs.length);
    }
    return out;
  }
  const keyOf = (k) => (k?.pubkey ?? k)?.toString();
  // Plain SOL transfers in a transaction (top level and inner), as { from, to, sol }.
  function solTransfers(tx) {
    const out = [];
    const all = [...(tx?.transaction?.message?.instructions ?? []), ...(tx?.meta?.innerInstructions ?? []).flatMap((x) => x.instructions ?? [])];
    for (const ix of all) {
      if (ix.program === 'system' && ix.parsed?.type === 'transfer') out.push({ from: ix.parsed.info.source, to: ix.parsed.info.destination, sol: Number(ix.parsed.info.lamports) / LAMPORTS });
    }
    return out;
  }

  // ---- saved scans ----
  function load(address) {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, `${address}.json`), 'utf8'));
    } catch {
      return null;
    }
  }
  function save(address, data) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${address}.json.tmp`), JSON.stringify(data));
      fs.renameSync(path.join(dir, `${address}.json.tmp`), path.join(dir, `${address}.json`));
    } catch {}
  }

  /** The wallet's trades and SOL transfers, newest first; only transactions newer than the last scan are read. */
  async function history(address, step) {
    const saved = load(address);
    const fresh = Date.now() - (saved?.at ?? 0) < 60_000;
    if (fresh) return saved;
    step('Finding the wallet\'s transactions…');
    const sigs = (await signatures(address, HISTORY_SIGS, saved?.newest ?? null)).filter((s) => !s.err);
    const txs = await parsed(sigs.map((s) => s.signature), (n, total) => step(`Reading transactions: ${n} of ${total}…`));
    const events = [];
    txs.forEach((tx, i) => {
      if (!tx) return;
      const time = tx.blockTime ?? sigs[i].blockTime ?? 0;
      const slot = tx.slot ?? sigs[i].slot;
      for (const t of parseTrades(tx, address)) events.push({ k: 't', sig: sigs[i].signature, time, slot, side: t.side, mint: t.mint, sol: t.solAmount, tok: Number(t.tokenAmount) / 10 ** 6 });
      for (const x of solTransfers(tx)) if ((x.from === address || x.to === address) && x.sol >= 0.01) events.push({ k: 'x', sig: sigs[i].signature, time, ...x });
    });
    const all = [...events, ...(saved?.events ?? [])].slice(0, 20_000);
    const data = { at: Date.now(), newest: sigs[0]?.signature ?? saved?.newest ?? null, events: all, scanned: (saved?.scanned ?? 0) + sigs.length, capped: !saved && sigs.length >= HISTORY_SIGS };
    save(address, data);
    return data;
  }

  // Who first sent SOL to a wallet (its oldest transaction), if it's young enough to find.
  async function funderOf(address) {
    const sigs = await signatures(address, 3000);
    if (!sigs.length || sigs.length >= 3000) return null;
    const tx = await connection.getParsedTransaction(sigs.at(-1).signature, { maxSupportedTransactionVersion: 0 }).catch(() => null);
    const t = solTransfers(tx).find((x) => x.to === address);
    return t ? { wallet: t.from, sol: t.sol, at: tx.blockTime ?? null } : null;
  }

  // ---- the profile ----
  async function holdings(address) {
    const owner = new PublicKey(address);
    const [sol, a, b] = await Promise.all([
      connection.getBalance(owner).catch(() => 0),
      connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM }).catch(() => ({ value: [] })),
      connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022 }).catch(() => ({ value: [] })),
    ]);
    const byMint = new Map();
    for (const acc of [...a.value, ...b.value]) {
      const info = acc.account.data.parsed?.info;
      const amt = Number(info?.tokenAmount?.uiAmount ?? 0);
      if (!info || amt <= 0 || info.mint === WSOL) continue;
      byMint.set(info.mint, (byMint.get(info.mint) ?? 0) + amt);
    }
    return { sol: sol / LAMPORTS, tokens: byMint };
  }

  function coinsFrom(events) {
    const coins = new Map();
    for (const e of [...events].reverse()) {
      if (e.k !== 't') continue;
      const c = coins.get(e.mint) ?? { mint: e.mint, buys: 0, sells: 0, solIn: 0, solOut: 0, tokIn: 0, tokOut: 0, firstBuy: null, lastSell: null, lastTime: 0 };
      if (e.side === 'buy') { c.buys++; c.solIn += e.sol; c.tokIn += e.tok; c.firstBuy ??= e.time; }
      else { c.sells++; c.solOut += e.sol; c.tokOut += e.tok; c.lastSell = e.time; }
      c.lastTime = Math.max(c.lastTime, e.time);
      coins.set(e.mint, c);
    }
    return coins;
  }

  async function buildProfile(address, step) {
    const h = await history(address, step);
    step('Pricing what the wallet holds…');
    const [held, usd] = await Promise.all([holdings(address), solPrice()]);
    const coins = coinsFrom(h.events);
    const info = await coinInfo([...held.tokens.keys(), ...[...coins.values()].sort((a, b) => b.lastTime - a.lastTime).slice(0, 120).map((c) => c.mint)]);
    // coins DexScreener doesn't list yet (still on a Pump.fun curve): ask Jupiter or the curve
    for (const [mint, amt] of [...held.tokens].filter(([m]) => !info.get(m)?.priceSol).slice(0, 12)) {
      const v = await bot.valueOf(mint, BigInt(Math.round(amt * 1e6))).catch(() => null);
      if (v) info.set(mint, { ...(info.get(mint) ?? {}), priceSol: Number(v) / LAMPORTS / amt });
    }
    const now = Date.now() / 1000;
    const rows = [...coins.values()].map((c) => {
      const i = info.get(c.mint) ?? {};
      const holding = held.tokens.get(c.mint) ?? 0;
      const valueSol = i.priceSol ? holding * i.priceSol : 0;
      const closed = c.tokIn > 0 && c.tokOut >= c.tokIn * 0.9;
      const realized = closed ? c.solOut - c.solIn : null;
      return {
        mint: c.mint, symbol: i.symbol ?? null, name: i.name ?? null, image: i.image ?? null, buys: c.buys, sells: c.sells,
        solIn: c.solIn, solOut: c.solOut, holding, valueSol, pnlSol: c.solOut + valueSol - c.solIn, realized, closed,
        roi: c.solIn > 0 ? ((c.solOut + valueSol - c.solIn) / c.solIn) * 100 : null,
        entryMcUsd: c.tokIn > 0 && usd ? (c.solIn / c.tokIn) * 1e9 * usd : null, exitMcUsd: c.tokOut > 0 && usd ? (c.solOut / c.tokOut) * 1e9 * usd : null,
        holdSec: c.firstBuy && c.lastSell && c.lastSell >= c.firstBuy ? c.lastSell - c.firstBuy : c.firstBuy ? now - c.firstBuy : null,
        firstBuy: c.firstBuy, lastTime: c.lastTime, onlySold: c.buys === 0,
      };
    }).filter((r) => !r.onlySold || r.solOut > 0.001);
    const closed = rows.filter((r) => r.closed);
    const wins = closed.filter((r) => r.realized > 0);
    const sum = (list, f) => list.reduce((s, r) => s + (f(r) ?? 0), 0);
    const since = (days) => closed.filter((r) => r.lastTime >= now - days * 86400);
    const trades = h.events.filter((e) => e.k === 't');
    const times = trades.map((e) => e.time).filter(Boolean);
    const spanDays = times.length > 1 ? Math.max(1 / 24, (Math.max(...times) - Math.min(...times)) / 86400) : 1;
    const perSecond = new Map();
    for (const t of trades) perSecond.set(`${t.time}`, (perSecond.get(`${t.time}`) ?? 0) + 1);
    const burst = [...perSecond.values()].filter((n) => n >= 3).length;
    const hours = Array(24).fill(0);
    for (const t of times) hours[new Date(t * 1000).getHours()]++;
    // PnL calendar: each closed coin's profit on the day it was sold out
    const calendar = {};
    for (const r of closed) {
      const d = dayKey(r.lastTime);
      const c = (calendar[d] ??= { pnl: 0, trades: 0, wins: 0, losses: 0 });
      c.pnl += r.realized; c.trades++; r.realized > 0 ? c.wins++ : c.losses++;
    }
    const holdMed = median(closed.map((r) => r.holdSec).filter((x) => x != null));
    const fastFlips = closed.filter((r) => r.holdSec != null && r.holdSec < 15).length;
    const tradesPerDay = trades.length / spanDays;
    const botLike = tradesPerDay > 250 || burst > 10;
    const copyable = closed.length ? 1 - fastFlips / closed.length : null;
    const winRate = closed.length ? wins.length / closed.length : null;
    const realizedAll = sum(closed, (r) => r.realized);
    const style = holdMed == null ? 'Not enough trades yet' : holdMed < 60 ? 'Sniper / scalper (sells within a minute)' : holdMed < 3600 ? 'Day trader (holds minutes)' : holdMed < 86400 ? 'Swing trader (holds hours)' : 'Holder (holds days)';
    const verdict = closed.length < 5 ? { level: 'unknown', text: 'Not enough closed trades to judge yet' }
      : botLike ? { level: 'bad', text: 'Bot-like: trades too fast and too often to copy in time' }
      : copyable != null && copyable < 0.6 ? { level: 'bad', text: 'Flips too fast: most trades are sold within 15 seconds' }
      : winRate >= 0.5 && realizedAll > 0 ? { level: 'good', text: 'Looks good to copy' }
      : realizedAll > 0 ? { level: 'warn', text: 'Profitable, but loses more often than it wins' }
      : { level: 'bad', text: 'Losing money lately' };
    const portfolio = [...held.tokens].map(([mint, amt]) => {
      const i = info.get(mint) ?? {}, c = coins.get(mint);
      const value = i.priceSol ? amt * i.priceSol : null;
      return { mint, symbol: i.symbol ?? null, name: i.name ?? null, image: i.image ?? null, amount: amt, valueSol: value, costSol: c ? c.solIn - c.solOut : null, pnlSol: c && value != null ? value + c.solOut - c.solIn : null, boughtAt: c?.firstBuy ?? null };
    }).sort((a, b) => (b.valueSol ?? 0) - (a.valueSol ?? 0));
    const tokensValue = sum(portfolio, (p) => p.valueSol);
    const result = {
      address, solUsd: usd, scannedAt: h.at, scanned: h.scanned, capped: h.capped,
      sol: held.sol, tokensValueSol: tokensValue, netWorthSol: held.sol + tokensValue,
      stats: {
        coins: rows.length, closed: closed.length, winRate, realizedAll, pnl7d: sum(since(7), (r) => r.realized), pnl30d: sum(since(30), (r) => r.realized),
        unrealized: sum(rows.filter((r) => !r.closed), (r) => r.valueSol + r.solOut - r.solIn), avgBuySol: sum(rows, (r) => r.solIn) / Math.max(1, sum(rows, (r) => r.buys)),
        holdMedSec: holdMed, entryMcMedUsd: median(rows.map((r) => r.entryMcUsd).filter(Boolean)), tradesPerDay, trades: trades.length, copyable, botLike, style,
        rugged: rows.filter((r) => !r.closed && r.solIn > 0.05 && r.valueSol < r.solIn * 0.05).length,
      },
      verdict, hours, calendar, portfolio,
      coins: rows.sort((a, b) => b.lastTime - a.lastTime).slice(0, 200),
      best: [...closed].sort((a, b) => b.realized - a.realized).slice(0, 5), worst: [...closed].sort((a, b) => a.realized - b.realized).slice(0, 5),
    };
    return result;
  }

  // ---- linked wallets ----
  async function buildLinked(address, step) {
    const h = await history(address, step);
    const evidence = new Map(); // wallet -> { score, reasons: [] }
    const add = (w, score, reason) => {
      if (!w || w === address || EXCHANGES.has(w) || IGNORE.has(w)) return;
      const e = evidence.get(w) ?? { wallet: w, score: 0, reasons: [] };
      e.score += score;
      e.reasons.push(reason);
      evidence.set(w, e);
    };
    // 1. money moving directly between them
    const flows = new Map();
    for (const e of h.events) {
      if (e.k !== 'x') continue;
      const other = e.from === address ? e.to : e.from;
      const f = flows.get(other) ?? { sent: 0, got: 0, n: 0 };
      e.from === address ? (f.sent += e.sol) : (f.got += e.sol);
      f.n++;
      flows.set(other, f);
    }
    for (const [w, f] of flows) {
      if (EXCHANGES.has(w)) continue;
      const parts = [f.sent ? `sent it ${f.sent.toFixed(2)} SOL` : '', f.got ? `received ${f.got.toFixed(2)} SOL from it` : ''].filter(Boolean).join(' and ');
      add(w, Math.min(4, f.n >= 3 ? 3 : 2), `Direct transfers: ${parts} (${f.n} time${f.n === 1 ? '' : 's'})`);
    }
    // 2. funded by the same wallet
    step('Finding who funded this wallet…');
    const funder = await funderOf(address).catch(() => null);
    let funderInfo = null;
    if (funder) {
      const ex = EXCHANGES.get(funder.wallet);
      funderInfo = { wallet: funder.wallet, sol: funder.sol, at: funder.at, exchange: ex ?? null };
      if (!ex) {
        add(funder.wallet, 3, `Funded this wallet (first ${funder.sol.toFixed(2)} SOL)`);
        step('Checking other wallets the same funder paid…');
        const sigs = (await signatures(funder.wallet, 150)).filter((s) => !s.err);
        const txs = await parsed(sigs.map((s) => s.signature));
        for (const tx of txs) for (const x of solTransfers(tx)) if (x.from === funder.wallet && x.to !== address && x.sol >= 0.05) add(x.to, 3, `Funded by the same wallet (${short(funder.wallet)}) with ${x.sol.toFixed(2)} SOL`);
      }
    }
    // 3. buying the same coins in the same moment (one person, several wallets)
    step('Comparing its buys with other buyers…');
    const buys = h.events.filter((e) => e.k === 't' && e.side === 'buy');
    const recentCoins = [...new Map(buys.map((b) => [b.mint, b])).values()].slice(0, 8);
    const together = new Map();
    for (const b of recentCoins) {
      const around = (await connection.getSignaturesForAddress(new PublicKey(b.mint), { before: b.sig, limit: 12 }).catch(() => [])).filter((s) => !s.err && Math.abs((s.slot ?? 0) - b.slot) <= 1);
      if (!around.length) continue;
      const txs = await parsed(around.map((s) => s.signature));
      const seenHere = new Set();
      for (const tx of txs) {
        const payer = keyOf(tx?.transaction?.message?.accountKeys?.[0]);
        if (!payer || payer === address || seenHere.has(payer)) continue;
        if (parseTrades(tx, payer).some((t) => t.mint === b.mint && t.side === 'buy')) {
          seenHere.add(payer);
          together.set(payer, (together.get(payer) ?? 0) + 1);
        }
      }
    }
    for (const [w, n] of together) if (n >= 2) add(w, n >= 4 ? 4 : n, `Bought ${n} of the same coins in the same block`);
    const linked = [...evidence.values()].map((e) => ({ ...e, confidence: e.score >= 5 ? 'high' : e.score >= 3 ? 'medium' : 'low' })).sort((a, b) => b.score - a.score).slice(0, 25);
    return { address, funder: funderInfo, linked, checkedCoins: recentCoins.length };
  }

  // ---- early buyers of a coin (aim: done in under 15 seconds) ----
  let fastHistory = true; // Helius's oldest-first lookup (paid Helius plans); switched off after it's refused once
  async function earliestTrades(mint, step) {
    if (!fastHistory) return null;
    try {
      const out = [];
      let paginationToken;
      for (let page = 0; page < 3; page++) {
        const r = await connection._rpcRequest('getTransactionsForAddress', [mint, { transactionDetails: 'full', sortOrder: 'asc', limit: 100, encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed', filters: { status: 'succeeded' }, ...(paginationToken ? { paginationToken } : {}) }]);
        if (r.error || !Array.isArray(r.result?.data)) throw new Error(r.error?.message ?? 'no data');
        out.push(...r.result.data);
        step(`Reading the coin's first trades: ${out.length}…`);
        paginationToken = r.result.paginationToken;
        if (!paginationToken || r.result.data.length < 100) break;
      }
      return out;
    } catch {
      fastHistory = false;
      return null;
    }
  }
  /** Parsed transactions for many signatures, a few batches at a time. */
  async function parsedFast(sigs, onStep) {
    const out = new Array(sigs.length);
    let next = 0, done = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (next < sigs.length) {
        const i = next; next += 10;
        const part = await parsed(sigs.slice(i, i + 10));
        part.forEach((tx, k) => (out[i + k] = tx));
        done += part.length;
        onStep?.(done, sigs.length);
      }
    }));
    return out;
  }
  // How much of `mint` each wallet holds, from their token accounts (both token programs) in one or two requests.
  async function holdingsOf(wallets, mint) {
    const m = new PublicKey(mint), out = new Map(wallets.map((w) => [w, 0]));
    const keys = wallets.flatMap((w) => [TOKEN_PROGRAM, TOKEN_2022].map((prog) => [w, PublicKey.findProgramAddressSync([new PublicKey(w).toBuffer(), prog.toBuffer(), m.toBuffer()], ATA_PROGRAM)[0]]));
    for (let i = 0; i < keys.length; i += 100) {
      const part = keys.slice(i, i + 100);
      const infos = await connection.getMultipleAccountsInfo(part.map(([, k]) => k)).catch(() => []);
      infos.forEach((acc, k) => { if (acc?.data?.length >= 72) out.set(part[k][0], out.get(part[k][0]) + Number(acc.data.readBigUInt64LE(64)) / 1e6); });
    }
    return out;
  }

  async function buildCoin(mint, step) {
    const saved = load(`coin-${mint}`);
    if (saved && Date.now() - saved.at < 5 * 60_000) return saved.result;
    const began = Date.now();
    step('Finding the coin\'s first trades…');
    const infoP = Promise.all([solPrice(), coinInfo([mint])]); // prices load while the chain is read
    let txs = await earliestTrades(mint, step), fromLaunch = true;
    if (!txs) {
      // free plan: page back towards the launch, but only for about 7 seconds (a huge coin has too many trades)
      const all = [];
      let before;
      for (;;) {
        const page = await connection.getSignaturesForAddress(new PublicKey(mint), { limit: 1000, before });
        all.push(...page);
        step(`Going back to the coin's launch: ${all.length.toLocaleString()} trades so far…`);
        if (page.length < 1000) break;
        if (Date.now() - began > 7000) { fromLaunch = false; break; }
        before = page.at(-1).signature;
      }
      const early = all.filter((x) => !x.err).slice(-200).reverse();
      txs = await parsedFast(early.map((x) => x.signature), (n, total) => step(`Reading early trades: ${n} of ${total}…`));
    }
    txs = txs.filter(Boolean).sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));
    const launchSlot = txs[0]?.slot ?? null;
    const buyers = new Map();
    let dev = null;
    txs.forEach((tx, i) => {
      const payer = keyOf(tx?.transaction?.message?.accountKeys?.[0]);
      if (!payer) return;
      if (i === 0 && fromLaunch) dev = payer;
      for (const t of parseTrades(tx, payer)) {
        if (t.mint !== mint) continue;
        const b = buyers.get(payer) ?? { wallet: payer, buySol: 0, boughtTok: 0, sellSol: 0, soldTok: 0, firstSlot: tx.slot, firstTime: tx.blockTime, rank: buyers.size + 1 };
        if (t.side === 'buy') { b.buySol += t.solAmount; b.boughtTok += Number(t.tokenAmount) / 1e6; } else { b.sellSol += t.solAmount; b.soldTok += Number(t.tokenAmount) / 1e6; }
        buyers.set(payer, b);
      }
    });
    step('Checking what they still hold…');
    const list = [...buyers.values()].filter((b) => b.buySol > 0).sort((a, b) => a.rank - b.rank).slice(0, 40);
    const [[usd, info], held] = await Promise.all([infoP, holdingsOf(list.map((b) => b.wallet), mint)]);
    let priceSol = info.get(mint)?.priceSol ?? null;
    if (!priceSol) { const v = await bot.valueOf(mint, 1_000_000_000n).catch(() => null); if (v) priceSol = Number(v) / LAMPORTS / 1000; }
    for (const b of list) {
      b.holding = held.get(b.wallet) ?? 0;
      const entry = b.boughtTok ? b.buySol / b.boughtTok : null;
      b.entryMcUsd = entry && usd ? entry * 1e9 * usd : null;
      b.multiple = entry && priceSol ? priceSol / entry : null;
      b.valueSol = priceSol ? b.holding * priceSol : null;
      b.pnlSol = b.sellSol + (b.valueSol ?? 0) - b.buySol;
      b.status = b.holding <= b.boughtTok * 0.01 ? 'sold all' : b.soldTok > 0 ? 'sold some' : 'holding';
      b.tags = [b.wallet === dev ? 'dev' : null, fromLaunch && b.firstSlot === launchSlot && b.wallet !== dev ? 'bundle' : null, fromLaunch && b.firstSlot - launchSlot <= 10 && b.firstSlot !== launchSlot ? 'sniper' : null].filter(Boolean);
    }
    const i = info.get(mint) ?? {};
    const result = { mint, symbol: i.symbol ?? null, name: i.name ?? null, image: i.image ?? null, mcUsd: i.mcUsd ?? (priceSol && usd ? priceSol * 1e9 * usd : null), fromLaunch, scanned: txs.length, seconds: Math.round((Date.now() - began) / 100) / 10, buyers: list.sort((a, b) => b.pnlSol - a.pnlSol) };
    save(`coin-${mint}`, { at: Date.now(), result });
    return result;
  }

  // ---- "what if I'd copied them" ----
  async function buildReplay(address, days, step) {
    const h = await history(address, step);
    const now = Date.now() / 1000;
    const trades = h.events.filter((e) => e.k === 't' && e.time >= now - days * 86400).reverse();
    const w = cfg.wallets.find((x) => x.address === address);
    const size = w?.buyAmountSol ?? cfg.buyAmountSol;
    const DELAY_COST = 0.03; // copying a moment later: a slightly worse price in and out
    const open = new Map(), done = [], skipped = { tooFast: 0, alreadyHeld: 0, slotsFull: 0, small: 0 };
    const byDay = {};
    const lastSellOf = new Map();
    for (const t of trades) if (t.side === 'sell') lastSellOf.set(`${t.mint}`, t.time);
    for (const t of trades) {
      if (t.side === 'buy') {
        if (open.has(t.mint) || (cfg.onlyFirstBuy && done.some((d) => d.mint === t.mint))) { skipped.alreadyHeld++; continue; }
        if (t.sol < (cfg.minSourceBuySol ?? 0)) { skipped.small++; continue; }
        if (open.size >= cfg.maxOpenPositions) { skipped.slotsFull++; continue; }
        const firstSell = trades.find((x) => x.mint === t.mint && x.side === 'sell' && x.time >= t.time);
        if (firstSell && firstSell.time - t.time < 3) { skipped.tooFast++; continue; } // sold before a copy could land
        const price = (t.sol / t.tok) * (1 + DELAY_COST);
        open.set(t.mint, { mint: t.mint, price, tokens: size / price, cost: size, at: t.time, theirTok: t.tok, theirSold: 0 });
      } else {
        const p = open.get(t.mint);
        if (!p) continue;
        p.theirSold += t.tok;
        const price = (t.sol / t.tok) * (1 - DELAY_COST);
        const gainPct = ((price - p.price) / p.price) * 100;
        const tp = cfg.takeProfitPct && gainPct >= cfg.takeProfitPct, sl = cfg.stopLossPct && gainPct <= -cfg.stopLossPct;
        const out = p.theirSold >= p.theirTok * 0.9;
        if (out || tp || sl || (!cfg.sellOnlyOnFullExit && cfg.sellMode !== 'all')) {
          const fraction = out || tp || sl || cfg.sellMode === 'all' ? 1 : Math.min(1, t.tok / p.theirTok);
          const sold = p.tokens * fraction;
          const pnl = sold * price - p.cost * fraction;
          p.tokens -= sold; p.cost -= p.cost * fraction;
          const d = dayKey(t.time);
          (byDay[d] ??= { pnl: 0, trades: 0, wins: 0, losses: 0 }).pnl += pnl;
          byDay[d].trades++; pnl > 0 ? byDay[d].wins++ : byDay[d].losses++;
          done.push({ mint: t.mint, pnl, reason: tp ? 'take profit' : sl ? 'stop loss' : out ? 'they sold out' : 'partial sell' });
          if (p.tokens <= 1e-9) open.delete(t.mint);
        }
      }
    }
    const pnl = done.reduce((s, d) => s + d.pnl, 0);
    const wins = done.filter((d) => d.pnl > 0).length;
    return { address, days, size, copied: done.length, open: open.size, pnlSol: pnl, winRate: done.length ? wins / done.length : null, skipped, calendar: byDay, settings: { tp: cfg.takeProfitPct, sl: cfg.stopLossPct, onlyFirstBuy: cfg.onlyFirstBuy, maxOpen: cfg.maxOpenPositions } };
  }

  // ---- Hypothetical PnL: for every copied buy, what you made, what following their sells would have made, and holding ----
  async function buildHypo(trades, step) {
    const copies = readCopies();
    const buys = trades.map((t, i) => ({ ...t, i, at: Date.parse(t.time) })).filter((t) => /buy$/.test(t.action) && t.token && Number(t.sol) > 0).slice(-150);
    const addressOf = (label) => cfg.wallets.find((w) => w.label === label)?.address ?? null;
    const sources = new Map();
    for (const b of buys) {
      b.copy = copies.find((c) => c.mint === b.token && Math.abs(c.at - b.at) < 120_000) ?? null;
      b.source = b.copy?.source ?? addressOf(b.copied_wallet);
      if (b.source) sources.set(b.source, null);
    }
    let n = 0;
    for (const a of sources.keys()) {
      n++;
      sources.set(a, await history(a, (s) => step(`Wallet ${n} of ${sources.size}: ${s}`)).catch(() => null));
    }
    step('Pricing the coins…');
    const mints = [...new Set(buys.map((b) => b.token))];
    const info = await coinInfo(mints);
    for (const m of mints.filter((x) => !info.get(x)?.priceSol).slice(0, 15)) {
      const v = await bot.valueOf(m, 1_000_000_000n).catch(() => null);
      if (v) info.set(m, { ...(info.get(m) ?? {}), priceSol: Number(v) / LAMPORTS / 1000 });
    }
    const rows = buys.map((b) => {
      const price = info.get(b.token)?.priceSol ?? null;
      // what actually happened: the sells of this coin after this buy (until the next buy of it)
      const next = trades.findIndex((t, k) => k > b.i && t.token === b.token && /buy$/.test(t.action));
      const sells = trades.slice(b.i + 1, next < 0 ? undefined : next).filter((t) => t.token === b.token && /sell$/.test(t.action));
      const ev = (sources.get(b.source)?.events ?? []).filter((e) => e.k === 't' && e.mint === b.token).sort((x, y) => x.time - y.time);
      const t0 = b.at / 1000;
      const theirBuy = ev.filter((e) => e.side === 'buy' && e.time <= t0 + 5).at(-1) ?? ev.find((e) => e.side === 'buy') ?? null;
      const theirBuyPrice = theirBuy && theirBuy.tok ? theirBuy.sol / theirBuy.tok : null;
      const tokens = b.copy?.tokens ? Number(b.copy.tokens) / 1e6 : theirBuyPrice ? Number(b.sol) / theirBuyPrice : null;
      const sol = Number(b.sol);
      const open = !sells.length;
      const actual = open ? (tokens != null && price != null ? tokens * price - sol : null) : sells.reduce((s, t) => s + Number(t.pnl_sol || 0), 0);
      let withThem = null, theirStatus = 'unknown';
      if (theirBuy && tokens != null) {
        const theirSells = ev.filter((e) => e.side === 'sell' && e.time >= theirBuy.time);
        const theirTok = ev.filter((e) => e.side === 'buy' && e.time <= (theirSells[0]?.time ?? Infinity)).reduce((s, e) => s + e.tok, 0) || theirBuy.tok;
        const soldTok = theirSells.reduce((s, e) => s + e.tok, 0), soldSol = theirSells.reduce((s, e) => s + e.sol, 0);
        const frac = Math.min(1, soldTok / theirTok);
        if (soldTok > 0) withThem = tokens * frac * (soldSol / soldTok) + tokens * (1 - frac) * (price ?? 0) - sol;
        else if (price != null) withThem = tokens * price - sol;
        theirStatus = frac >= 0.9 ? 'sold all' : frac > 0 ? 'sold some' : 'still holding';
      }
      return {
        time: b.time, mint: b.token, symbol: info.get(b.token)?.symbol ?? null, image: info.get(b.token)?.image ?? null, wallet: b.copied_wallet, paper: /paper/.test(b.action),
        sol, open, actual, withThem, held: tokens != null && price != null ? tokens * price - sol : null, theirStatus, estimated: !b.copy,
      };
    }).reverse();
    const sum = (f) => rows.reduce((s, r) => s + (r[f] ?? 0), 0);
    return { rows, totals: { actual: sum('actual'), withThem: sum('withThem'), held: sum('held'), spent: sum('sol') }, at: Date.now() };
  }

  // ---- jobs: scans take a while, so they run in the background and the page asks how far along they are ----
  const queue = [];
  let running = false;
  function start(key, work) {
    const j = jobs.get(key);
    if (j && (j.state === 'running' || j.state === 'queued')) return j;
    if (j && j.state === 'done' && Date.now() - j.at < 60_000) return j;
    const job = { state: 'queued', step: 'Waiting for the scan before it…', result: j?.result ?? null, at: Date.now() };
    jobs.set(key, job);
    queue.push([job, work]);
    pump();
    return job;
  }
  async function pump() {
    if (running) return;
    running = true;
    while (queue.length) {
      const [job, work] = queue.shift();
      job.state = 'running';
      try {
        job.result = await work((s) => (job.step = s));
        job.state = 'done';
      } catch (e) {
        job.state = 'error';
        job.error = /Invalid param|WrongSize|not a valid/i.test(e.message) ? "That isn't a valid address." : e.message;
      }
      job.at = Date.now();
      await sleep(50);
    }
    running = false;
  }
  const view = (j) => ({ state: j.state, step: j.step, error: j.error ?? null, result: j.result });
  const check = (a) => new PublicKey(String(a ?? '').trim()).toBase58();

  return {
    /** Is this address a coin or a wallet? */
    async kind(address) {
      const a = check(address);
      const info = await connection.getAccountInfo(new PublicKey(a)).catch(() => null);
      const owner = info?.owner?.toString();
      return { address: a, kind: (owner === TOKEN_PROGRAM.toBase58() || owner === TOKEN_2022.toBase58()) && info.data.length >= 82 && info.data.length < 165 ? 'coin' : 'wallet' };
    },
    wallet: (a, refresh) => { const x = check(a); if (refresh) jobs.delete(`w:${x}`); return view(start(`w:${x}`, (s) => buildProfile(x, s))); },
    linked: (a) => { const x = check(a); return view(start(`l:${x}`, (s) => buildLinked(x, s))); },
    coin: (a) => { const x = check(a); return view(start(`c:${x}`, (s) => buildCoin(x, s))); },
    coinInfo,
    hypothetical: (trades, refresh) => { if (refresh && jobs.get('h')?.state === 'done') jobs.delete('h'); return view(start('h', (s) => buildHypo(trades, s))); },
    replay: (a, days) => { const x = check(a); const d = [7, 30].includes(Number(days)) ? Number(days) : 7; return view(start(`r:${x}:${d}`, (s) => buildReplay(x, d, s))); },
  };
}
