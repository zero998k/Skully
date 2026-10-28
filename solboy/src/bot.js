import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { parseTrades, looksLikeSwap, WSOL } from './detect.js';
import { getQuote, buildSwap } from './jupiter.js';
import { log, short, recordTrade, notify, c } from './log.js';
import { checkWallet, saveWallets } from './config.js';

const LAMPORTS = 1e9;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The copy-trading engine. Everything it talks to is passed in so it can be tested without a network.
 * The book says whether we're paper or real-money trading, and holds the trading keypair.
 */
export function createBot({ cfg, connection, book, rpcFetch, pulse = null }) {
  const positions = book.positions;
  const seen = new Set();
  const locks = new Map();
  let ignored = 0;
  let buyingPaused = false;
  const tag = () => (cfg.dryRun ? 'PAPER ' : '');

  // Run trades for the same token one at a time, so a fast buy-then-sell can't overlap.
  function withLock(mint, fn) {
    const next = (locks.get(mint) ?? Promise.resolve()).catch(() => {}).then(fn);
    locks.set(mint, next);
    next.finally(() => locks.get(mint) === next && locks.delete(mint)).catch(() => {});
    return next;
  }

  // Newest transaction format Solana uses that we ask for. The Solana library inside SolBoy only
  // understands formats up to 0, so transactions are fetched straight from the RPC instead. If an RPC
  // doesn't support version 1 yet, we drop back to 0 and remember that.
  let txVersion = 1;
  async function getTransaction(signature) {
    if (!rpcFetch) return connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
    const res = await rpcFetch(connection.rpcEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getTransaction',
        params: [signature, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: txVersion }],
      }),
    });
    const body = await res.json();
    if (body.error) {
      const msg = body.error.message ?? '';
      // A transaction newer than we asked for: say so, but keep asking for the newest format we know.
      if (/Transaction version \(\d+\) is not supported/i.test(msg)) throw new Error('this trade uses a newer Solana format than SolBoy can read yet. A SolBoy update is needed.');
      // The RPC itself doesn't accept version 1 yet: fall back to the older format.
      if (txVersion > 0 && /maxSupportedTransactionVersion|invalid param/i.test(msg)) {
        txVersion = 0;
        return getTransaction(signature);
      }
      throw new Error(msg || 'RPC error');
    }
    return body.result;
  }

  async function fetchTx(signature) {
    for (let i = 0; i < 4; i++) {
      try {
        const tx = await getTransaction(signature);
        if (tx) return tx;
      } catch (e) {
        if (i === 3) log(`Couldn't load transaction ${short(signature)}: ${e.message}`);
      }
      await sleep(400 * (i + 1));
    }
    return null;
  }

  async function handleSignature(w, signature, seenAt = Date.now()) {
    if (seen.has(signature)) return;
    seen.add(signature);
    if (seen.size > 5000) seen.delete(seen.values().next().value);

    const tx = await fetchTx(signature);
    if (!tx) return;
    const delay = tx.blockTime ? `~${((seenAt - tx.blockTime * 1000) / 1000).toFixed(1)}s after their trade` : '';

    const late = Date.now() - seenAt > cfg.maxCopyDelaySeconds * 1000;
    for (const t of parseTrades(tx, w.address)) {
      log(`${w.label} ${t.side.toUpperCase()} ${short(t.mint)} for ${t.solAmount.toFixed(3)} SOL ${delay}`);
      if (t.side === 'buy' && late) {
        log(`  skip: took over ${cfg.maxCopyDelaySeconds}s to load, too late to copy this buy`);
        continue;
      }
      if (t.side === 'buy') await withLock(t.mint, () => copyBuy(w, t));
      else await withLock(t.mint, () => copySell(w, t));
    }
  }

  function buySkipReason(w, t) {
    if (w.retiring) return `${w.label} was removed, so SolBoy only follows its sells for tokens you still hold`;
    if (buyingPaused) return 'copying is paused (from the dashboard)';
    if (cfg.onlyFirstBuy && t.heldBefore) return `${w.label} already held this coin and is adding more; SolBoy only copies their first buy`;
    if (positions.has(t.mint)) return 'already holding this token';
    if (cfg.blocklist.includes(t.mint)) return 'token is on your blocklist';
    if (t.solAmount < cfg.minSourceBuySol) return `their buy is under minSourceBuySol (${cfg.minSourceBuySol} SOL)`;
    if (positions.count() >= cfg.maxOpenPositions) return `already at maxOpenPositions (${cfg.maxOpenPositions})`;
    if (positions.todayPnl() <= -cfg.dailyLossLimitSol) return `daily loss limit of ${cfg.dailyLossLimitSol} SOL reached`;
    return null;
  }

  async function failsSafetyCheck(mint) {
    if (!cfg.skipIfMintAuthority && !cfg.skipIfFreezeAuthority) return false;
    try {
      const info = (await connection.getParsedAccountInfo(new PublicKey(mint))).value?.data?.parsed?.info;
      if (!info) return log('  skip: could not read token info'), true;
      if (cfg.skipIfMintAuthority && info.mintAuthority) return log('  skip: creator can still mint more of this token'), true;
      if (cfg.skipIfFreezeAuthority && info.freezeAuthority) return log("  skip: creator can freeze holders' tokens"), true;
      return false;
    } catch (e) {
      log(`  skip: token check failed (${e.message})`);
      return true;
    }
  }

  async function executeSwap(quote) {
    const { swapTransaction, lastValidBlockHeight } = await buildSwap(
      quote,
      book.keypair.publicKey.toBase58(),
      cfg.priorityFeeMaxLamports,
    );
    const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
    tx.sign([book.keypair]);
    const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 2 });
    const { value } = await connection.confirmTransaction(
      { signature, blockhash: tx.message.recentBlockhash, lastValidBlockHeight },
      'confirmed',
    );
    if (value.err) throw new Error(`transaction ${signature} failed on-chain (often slippage): ${JSON.stringify(value.err)}`);
    return signature;
  }

  /**
   * Price a trade with Jupiter and (in real-money mode) send it. Brand-new Pump.fun coins aren't on Jupiter yet, so
   * when Jupiter can't quote: paper mode prices from the coin's live bonding curve, and real-money mode has
   * PumpPortal build the transaction. A trade that was sent is never retried another way.
   */
  async function swap(side, mint, amountRaw, slippageBps) {
    const [inputMint, outputMint] = side === 'buy' ? [WSOL, mint] : [mint, WSOL];
    let quote;
    try {
      quote = await getQuote({ inputMint, outputMint, amount: amountRaw.toString(), slippageBps });
    } catch (e) {
      const c = pulse?.curveOf(mint);
      if (!c) throw e;
      if (cfg.dryRun) return { outRaw: curveOut(side, c, amountRaw), sig: null, via: 'curve' };
      return pumpPortalSwap(side, mint, amountRaw, slippageBps);
    }
    const sig = cfg.dryRun ? null : await executeSwap(quote);
    return { outRaw: BigInt(quote.outAmount), sig, via: 'jupiter' };
  }

  // Pump.fun curve maths (constant product on virtual reserves, ~1% fee). Tokens have 6 decimals.
  function curveOut(side, { vSol, vTokens }, amountRaw) {
    const k = vSol * vTokens;
    if (side === 'buy') return BigInt(Math.floor((vTokens - k / (vSol + (Number(amountRaw) / LAMPORTS) * 0.99)) * 1e6));
    return BigInt(Math.floor((vSol - k / (vTokens + Number(amountRaw) / 1e6)) * 0.99 * LAMPORTS));
  }

  async function pumpPortalSwap(side, mint, amountRaw, slippageBps) {
    const owner = book.keypair.publicKey;
    const before = side === 'buy' ? await tokenBalance(mint) : BigInt(await connection.getBalance(owner));
    const res = await fetch(`${process.env.PUMPPORTAL_API_URL || 'https://pumpportal.fun/api'}/trade-local`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publicKey: owner.toBase58(), action: side, mint, pool: 'auto',
        amount: side === 'buy' ? Number(amountRaw) / LAMPORTS : Number(amountRaw) / 1e6,
        denominatedInSol: side === 'buy' ? 'true' : 'false',
        slippage: Math.round(slippageBps / 100), priorityFee: Math.min(cfg.priorityFeeMaxLamports, 2_000_000) / LAMPORTS,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`PumpPortal couldn't build the trade (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const tx = VersionedTransaction.deserialize(new Uint8Array(await res.arrayBuffer()));
    tx.sign([book.keypair]);
    const { lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 2 });
    const { value } = await connection.confirmTransaction({ signature: sig, blockhash: tx.message.recentBlockhash, lastValidBlockHeight }, 'confirmed');
    if (value.err) throw new Error(`transaction ${sig} failed on-chain (often slippage): ${JSON.stringify(value.err)}`);
    const after = side === 'buy' ? await tokenBalance(mint) : BigInt(await connection.getBalance(owner));
    return { outRaw: after > before ? after - before : 0n, sig, via: 'pumpportal' };
  }

  /** What selling `tokensRaw` would return right now, in lamports (null if no price). */
  async function valueOf(mint, tokensRaw) {
    try {
      const q = await getQuote({ inputMint: mint, outputMint: WSOL, amount: String(tokensRaw), slippageBps: cfg.sellSlippageBps });
      return BigInt(q.outAmount);
    } catch {
      const c = pulse?.curveOf(mint);
      if (c) return curveOut('sell', c, BigInt(tokensRaw));
      const p = pulse?.priceSol(mint);
      return p ? BigInt(Math.floor((Number(tokensRaw) / 1e6) * p * LAMPORTS)) : null;
    }
  }

  /** A buy or sell you made yourself (Pulse quick trade). Sells reuse the normal sell path. */
  async function manualTrade({ mint, side, sol, percent, slippagePct }) {
    new PublicKey(mint);
    const slip = slippagePct ? Math.round(Number(slippagePct) * 100) : null;
    if (side === 'sell') {
      if (!positions.get(mint)) throw new Error("You don't hold this coin.");
      const fraction = Math.min(1, Math.max(0.01, Number(percent ?? 100) / 100));
      return withLock(mint, () => sellPosition(mint, fraction, 'sold by you (Pulse)', slip, true));
    }
    const amount = Number(sol);
    if (!(amount > 0) || amount > 1000) throw new Error('Enter how much SOL to buy with, like 0.1.');
    if (cfg.blocklist?.includes(mint)) throw new Error("That coin is on your blocklist.");
    return withLock(mint, async () => {
      const lamports = BigInt(Math.round(amount * LAMPORTS));
      const { outRaw, sig } = await swap('buy', mint, lamports, slip ?? cfg.buySlippageBps);
      const pos = positions.get(mint);
      if (pos) positions.update(mint, { solSpent: pos.solSpent + amount, tokens: (BigInt(pos.tokens) + outRaw).toString() });
      else positions.open(mint, { source: 'manual', sourceLabel: 'You (Pulse)', solSpent: amount, tokens: outRaw.toString(), openedAt: new Date().toISOString() });
      log(c.green(`  ${tag()}BOUGHT ${amount} SOL of ${short(mint)}`) + ' (you, from Pulse)' + (sig ? `  tx: ${sig}` : ''));
      recordTrade(book.tradeLogFile, { action: `${tag()}buy`, mint, wallet: 'You (Pulse)', sol: amount, reason: 'bought by you (Pulse)', tx: sig });
      return { ok: true, side: 'buy', sol: amount, tokens: outRaw.toString(), sig };
    });
  }

  async function copyBuy(w, t) {
    const why = buySkipReason(w, t);
    if (why) return log(`  skip: ${why}`);
    if (await failsSafetyCheck(t.mint)) return;

    const lamports = Math.round((w.buyAmountSol ?? cfg.buyAmountSol) * LAMPORTS);
    try {
      const { outRaw, sig } = await swap('buy', t.mint, BigInt(lamports), cfg.buySlippageBps);
      const sol = lamports / LAMPORTS;
      positions.open(t.mint, {
        source: w.address,
        sourceLabel: w.label,
        solSpent: sol,
        tokens: outRaw.toString(),
        openedAt: new Date().toISOString(),
      });
      log(c.green(`  ${tag()}BOUGHT ${sol} SOL of ${short(t.mint)}`) + (sig ? `  tx: ${sig}` : ''));
      recordTrade(book.tradeLogFile, { action: `${tag()}buy`, mint: t.mint, wallet: w.label, sol, reason: `copied ${w.label}`, tx: sig });
      notify(`${tag()}BUY ${sol} SOL of ${t.mint}\ncopied ${w.label}\nhttps://dexscreener.com/solana/${t.mint}`);
    } catch (e) {
      log(`  buy failed: ${e.message}`);
    }
  }

  async function copySell(w, t) {
    const pos = positions.get(t.mint);
    if (!pos || !cfg.followSells) return;
    if (pos.source !== w.address) return log(`  not selling: this position was copied from ${pos.sourceLabel}`);
    // Selling 90%+ counts as out: many traders keep a tiny "moon bag" forever, which would never free the slot.
    const out = t.fractionSold >= 0.9;
    if (cfg.sellOnlyOnFullExit) {
      if (!out) return log(`  not selling yet: ${w.label} sold ${Math.round(t.fractionSold * 100)}% and still holds most of it. SolBoy sells when they sell 90% or more`);
      return sellPosition(t.mint, 1, `${w.label} sold out`);
    }
    const fraction = cfg.sellMode === 'all' ? 1 : t.fractionSold;
    await sellPosition(t.mint, fraction, `${w.label} sold ${Math.round(t.fractionSold * 100)}%`);
  }

  async function tokenBalance(mint) {
    const res = await connection.getParsedTokenAccountsByOwner(book.keypair.publicKey, { mint: new PublicKey(mint) });
    return res.value.reduce((sum, a) => sum + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
  }

  async function sellPosition(mint, fraction, reason, slippageBps = null, throwErrors = false) {
    const pos = positions.get(mint);
    if (!pos) return;
    try {
      const held = cfg.dryRun ? BigInt(pos.tokens) : await tokenBalance(mint);
      if (held === 0n) {
        positions.close(mint);
        finishRetiring(pos.source);
        return log(`  ${short(mint)}: no tokens left, position closed`);
      }
      const full = fraction >= 0.98;
      const amount = full ? held : (held * BigInt(Math.round(fraction * 10_000))) / 10_000n;
      if (amount === 0n) return;

      const { outRaw, sig } = await swap('sell', mint, amount, slippageBps ?? cfg.sellSlippageBps);
      const solOut = Number(outRaw) / LAMPORTS;
      const cost = pos.solSpent * (full ? 1 : Number(amount) / Number(held));
      const pnl = solOut - cost;
      positions.recordPnl(pnl);
      if (full) {
        positions.close(mint);
        finishRetiring(pos.source);
      }
      else positions.update(mint, { solSpent: pos.solSpent - cost, tokens: (held - amount).toString() });

      const pnlText = `${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL`;
      log(c.yellow(`  ${tag()}SOLD ${full ? 'all' : `${Math.round(fraction * 100)}%`} of ${short(mint)} for ${solOut.toFixed(4)} SOL`) + ` (${(pnl >= 0 ? c.green : c.red)(pnlText)}) - ${reason}${sig ? `  tx: ${sig}` : ''}`);
      recordTrade(book.tradeLogFile, { action: `${tag()}sell`, mint, wallet: pos.sourceLabel, sol: solOut.toFixed(6), pnl: pnl.toFixed(6), reason, tx: sig });
      notify(`${tag()}SELL ${short(mint)} for ${solOut.toFixed(4)} SOL (${pnlText})\n${reason}`);
      return { ok: true, side: 'sell', sol: solOut, pnl, sig };
    } catch (e) {
      log(`  sell failed for ${short(mint)}: ${e.message}`);
      if (throwErrors) throw e;
    }
  }

  let checking = false;
  async function checkExits() {
    if (checking || !(cfg.takeProfitPct || cfg.stopLossPct)) return;
    checking = true;
    try {
      for (const [mint, pos] of positions.entries()) {
        try {
          const value = await valueOf(mint, pos.tokens);
          if (value == null) throw new Error('no price yet');
          const pct = ((Number(value) / LAMPORTS - pos.solSpent) / pos.solSpent) * 100;
          if (cfg.takeProfitPct && pct >= cfg.takeProfitPct) {
            await withLock(mint, () => sellPosition(mint, 1, `take-profit hit (+${pct.toFixed(0)}%)`));
          } else if (cfg.stopLossPct && pct <= -cfg.stopLossPct) {
            await withLock(mint, () => sellPosition(mint, 1, `stop-loss hit (${pct.toFixed(0)}%)`));
          }
        } catch (e) {
          log(`price check failed for ${short(mint)}: ${e.message}`);
        }
      }
    } finally {
      checking = false;
    }
  }

  const subscriptions = new Map();
  const holdingFrom = (address) => positions.entries().filter(([, p]) => p.source === address).length;

  function watch(w) {
    const id = connection.onLogs(
      new PublicKey(w.address),
      (logs) => {
        if (logs.err) return;
        if (!looksLikeSwap(logs.logs)) {
          ignored++;
          return;
        }
        const seenAt = Date.now();
        handleSignature(w, logs.signature, seenAt).catch((e) => log(`Error handling ${short(logs.signature)}: ${e.message}`));
      },
      'confirmed',
    );
    subscriptions.set(w.address, id);
    log(`Watching ${w.label} (${w.address})${w.retiring ? ', for sells only' : ''}`);
  }

  function dropWallet(w) {
    const id = subscriptions.get(w.address);
    if (id !== undefined) connection.removeOnLogsListener(id).catch(() => {});
    subscriptions.delete(w.address);
    cfg.wallets.splice(cfg.wallets.indexOf(w), 1);
    saveWallets(cfg.wallets);
    log(`Stopped watching ${w.label}.`);
  }

  function finishRetiring(address) {
    const w = cfg.wallets.find((x) => x.address === address);
    if (w?.retiring && !holdingFrom(address)) dropWallet(w);
  }

  /** Start copying a new wallet right away and save it for next time. */
  function addWallet(input) {
    const address = String(input.address ?? '').trim();
    const retired = cfg.wallets.find((w) => w.address === address && w.retiring);
    if (retired) {
      delete retired.retiring;
      saveWallets(cfg.wallets);
      log(`${retired.label} is back: copying its buys again.`);
      return retired;
    }
    const w = checkWallet(input, cfg.wallets);
    if (book.keypair && w.address === book.keypair.publicKey.toBase58()) throw new Error("That's your own trading wallet. SolBoy can't copy itself.");
    cfg.wallets.push(w);
    saveWallets(cfg.wallets);
    watch(w);
    if (cfg.wallets.length > 10) log('Heads up: over 10 wallets can hit the free Helius limit. Drop the weakest ones on the Wallets tab.');
    return w;
  }

  /**
   * Stop copying a wallet. If you still hold tokens copied from it, keep following its sells
   * for those (so you're never stuck holding), and finish removing it once they're sold.
   */
  function removeWallet(key) {
    const k = String(key ?? '').trim().toLowerCase();
    const w = cfg.wallets.find((x) => x.address.toLowerCase() === k || x.label.toLowerCase() === k);
    if (!w) throw new Error(`No wallet called "${String(key).slice(0, 44)}".`);
    const holding = holdingFrom(w.address);
    if (!holding) {
      dropWallet(w);
      return { removed: true, holding: 0 };
    }
    w.retiring = true;
    saveWallets(cfg.wallets);
    log(`${w.label} removed: no new buys. Still following its sells for the ${holding} token(s) you hold from it.`);
    return { removed: false, holding };
  }

  function start() {
    for (const w of [...cfg.wallets]) {
      if (w.retiring && !holdingFrom(w.address)) dropWallet(w);
      else watch(w);
    }
    // Always scheduled, so take-profit / stop-loss can be switched on while SolBoy is running.
    setInterval(checkExits, cfg.priceCheckSeconds * 1000);
    setInterval(() => {
      log(`Status: ${positions.count()} open position(s), today's P&L ${positions.todayPnl().toFixed(4)} SOL, ${ignored} non-trade transactions ignored`);
    }, 10 * 60 * 1000);
  }

  /** Start profit/loss from zero (paper and real money): totals, today, and the daily loss limit. */
  function resetPnl() {
    for (const mode of ['paper', 'live']) book.positionsFor(mode).resetPnl();
    log(`Profit/loss reset to 0. Totals and today start fresh, and the daily loss limit is full again (${cfg.dailyLossLimitSol} SOL). Your trade history is kept.`);
  }

  return {
    start,
    resetPnl,
    handleSignature,
    checkExits,
    setBuyingPaused(value) {
      buyingPaused = value;
      log(value ? 'Copying PAUSED. Sells still follow the copied wallets.' : 'Copying RESUMED.');
    },
    isBuyingPaused: () => buyingPaused,
    sellNow: (mint) => withLock(mint, () => sellPosition(mint, 1, 'sold by you from the dashboard')),
    manualTrade,
    valueOf,
    addWallet,
    removeWallet,
  };
}
