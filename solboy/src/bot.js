import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { parseTrades, looksLikeSwap, pumpTradesFromLogs, WSOL } from './detect.js';
import { getQuote, buildSwap } from './jupiter.js';
import { log, short, recordTrade, notify, c } from './log.js';
import { checkWallet, saveWallets } from './config.js';

const LAMPORTS = 1e9;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The copy-trading engine. Everything it talks to is passed in so it can be tested without a network.
 * The book says whether we're paper or real-money trading, and holds the trading keypair.
 */
const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

export function createBot({ cfg, connection, book, rpcFetch }) {
  const positions = book.positions;
  const seen = new Set();
  const locks = new Map();
  let ignored = 0;
  let buyingPaused = false;
  const speeds = []; // seconds from seeing a watched wallet's trade to sending the copy, for the dashboard
  let buysInFlight = 0; // copy buys still being sent, so several at once can't go past maxOpenPositions
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

  // Trades are seen at "processed", a moment before the network serves them as "confirmed": ask again every 250ms.
  async function fetchTx(signature) {
    for (let i = 0; i < 12; i++) {
      try {
        const tx = await getTransaction(signature);
        if (tx) return tx;
      } catch (e) {
        if (i === 11) log(`Couldn't load transaction ${short(signature)}: ${e.message}`);
      }
      await sleep(250);
    }
    return null;
  }

  async function handleSignature(w, signature, seenAt = Date.now(), logLines = null) {
    if (seen.has(signature)) return;
    seen.add(signature);
    if (seen.size > 5000) seen.delete(seen.values().next().value);

    // Fast path: Pump.fun trades are read straight from the notification's logs, no download needed.
    const fast = logLines ? pumpTradesFromLogs(logLines, w.address) : [];
    if (fast.length) {
      for (const t of fast) {
        t.seenAt = seenAt;
        if (t.curve) rememberCurve(t.mint, t.curve);
        log(`${w.label} ${t.side.toUpperCase()} ${short(t.mint)} for ${t.solAmount.toFixed(3)} SOL (seen live)`);
        if (t.side === 'buy') await withLock(t.mint, () => copyBuy(w, t));
        else await withLock(t.mint, () => copySell(w, t));
      }
      return;
    }

    const tx = await fetchTx(signature);
    if (!tx) return;
    const delay = tx.blockTime ? `~${((seenAt - tx.blockTime * 1000) / 1000).toFixed(1)}s after their trade` : '';

    const late = Date.now() - seenAt > cfg.maxCopyDelaySeconds * 1000;
    for (const t of parseTrades(tx, w.address)) {
      t.seenAt = seenAt;
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
    if (w.paused) return `copying is switched off for ${w.label} (Wallets tab)`;
    if (cfg.onlyFirstBuy && t.heldBefore) return `${w.label} already held this coin and is adding more; SolBoy only copies their first buy`;
    if (positions.has(t.mint)) return 'already holding this token';
    if (cfg.blocklist.includes(t.mint)) return 'token is on your blocklist';
    if (t.solAmount < cfg.minSourceBuySol) return `their buy is under minSourceBuySol (${cfg.minSourceBuySol} SOL)`;
    if (positions.count() + buysInFlight >= cfg.maxOpenPositions) return `already at maxOpenPositions (${cfg.maxOpenPositions})`;
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

  async function executeSwap(quote, prioLamports = null) {
    const { swapTransaction, lastValidBlockHeight } = await buildSwap(
      quote,
      book.keypair.publicKey.toBase58(),
      prioLamports ?? cfg.priorityFeeMaxLamports,
    );
    const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
    tx.sign([book.keypair]);
    const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 2 });
    const sentAt = Date.now();
    const { value } = await connection.confirmTransaction(
      { signature, blockhash: tx.message.recentBlockhash, lastValidBlockHeight },
      'confirmed',
    );
    if (value.err) throw new Error(`transaction ${signature} failed on-chain (often slippage): ${JSON.stringify(value.err)}`);
    return { signature, sentAt };
  }

  /**
   * Price a trade with Jupiter and (in real-money mode) send it. Brand-new Pump.fun coins aren't on Jupiter yet, so
   * when Jupiter can't quote: paper mode prices from the coin's live bonding curve, and real-money mode has
   * PumpPortal build the transaction. A trade that was sent is never retried another way.
   */
  async function swap(side, mint, amountRaw, slippageBps, prefetched = null, prioLamports = null) {
    const [inputMint, outputMint] = side === 'buy' ? [WSOL, mint] : [mint, WSOL];
    let quote;
    try {
      quote = prefetched ? await prefetched : await getQuote({ inputMint, outputMint, amount: amountRaw.toString(), slippageBps });
      if (quote instanceof Error) throw quote;
    } catch (e) {
      const c = await curveOf(mint);
      if (!c) throw e;
      if (cfg.dryRun) return { outRaw: curveOut(side, c, amountRaw), sig: null, via: 'curve', sentAt: Date.now() };
      return pumpPortalSwap(side, mint, amountRaw, slippageBps, prioLamports);
    }
    if (cfg.dryRun) return { outRaw: BigInt(quote.outAmount), sig: null, via: 'jupiter', sentAt: Date.now() };
    const { signature, sentAt } = await executeSwap(quote, prioLamports);
    return { outRaw: BigInt(quote.outAmount), sig: signature, via: 'jupiter', sentAt };
  }

  /** Trade straight on a Pump.fun curve: priced from the curve in paper mode, built by PumpPortal with real money. */
  async function curveSwap(side, mint, amountRaw, slippageBps, curve) {
    if (cfg.dryRun) return { outRaw: curveOut(side, curve, amountRaw), sig: null, via: 'curve', sentAt: Date.now() };
    return pumpPortalSwap(side, mint, amountRaw, slippageBps);
  }

  // A Pump.fun coin's bonding curve, read straight from the chain (or from the last trade seen in the logs), so
  // brand-new coins Jupiter can't price yet still get a price. null once the curve is complete (or for other coins).
  const curves = new Map();
  function rememberCurve(mint, curve) {
    curves.set(mint, { at: Date.now(), curve });
    if (curves.size > 500) curves.delete(curves.keys().next().value);
  }
  async function curveOf(mint) {
    const hit = curves.get(mint);
    if (hit && Date.now() - hit.at < 2000) return hit.curve;
    let curve = null;
    try {
      const [pda] = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()], PUMP_PROGRAM);
      const info = await connection.getAccountInfo(pda, 'processed');
      const d = info?.data;
      // layout: 8-byte id, virtual tokens, virtual SOL, real tokens, real SOL, supply (u64 each), complete (bool at 48)
      if (d?.length >= 49 && d[48] === 0) {
        const vTokens = Number(d.readBigUInt64LE(8)) / 1e6, vSol = Number(d.readBigUInt64LE(16)) / 1e9;
        if (vTokens > 0 && vSol > 0) curve = { vSol, vTokens };
      }
    } catch {}
    rememberCurve(mint, curve);
    return curve;
  }

  // Pump.fun curve maths (constant product on virtual reserves, ~1% fee). Tokens have 6 decimals.
  function curveOut(side, { vSol, vTokens }, amountRaw) {
    const k = vSol * vTokens;
    if (side === 'buy') return BigInt(Math.floor((vTokens - k / (vSol + (Number(amountRaw) / LAMPORTS) * 0.99)) * 1e6));
    return BigInt(Math.floor((vSol - k / (vTokens + Number(amountRaw) / 1e6)) * 0.99 * LAMPORTS));
  }

  async function pumpPortalSwap(side, mint, amountRaw, slippageBps, prioLamports = null) {
    const owner = book.keypair.publicKey;
    const beforeP = (side === 'buy' ? tokenBalance(mint) : connection.getBalance(owner).then(BigInt)).catch(() => null);
    const res = await fetch(`${process.env.PUMPPORTAL_API_URL || 'https://pumpportal.fun/api'}/trade-local`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publicKey: owner.toBase58(), action: side, mint, pool: 'auto',
        amount: side === 'buy' ? Number(amountRaw) / LAMPORTS : Number(amountRaw) / 1e6,
        denominatedInSol: side === 'buy' ? 'true' : 'false',
        slippage: Math.max(1, Math.round(slippageBps / 100)), priorityFee: (prioLamports ?? Math.min(cfg.priorityFeeMaxLamports, 2_000_000)) / LAMPORTS,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`PumpPortal couldn't build the trade (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const tx = VersionedTransaction.deserialize(new Uint8Array(await res.arrayBuffer()));
    tx.sign([book.keypair]);
    const before = (await beforeP) ?? 0n; // read while PumpPortal built the trade, so this costs no time
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 2 });
    const sentAt = Date.now();
    const { lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed'); // only needed to wait for the result
    const { value } = await connection.confirmTransaction({ signature: sig, blockhash: tx.message.recentBlockhash, lastValidBlockHeight }, 'confirmed');
    if (value.err) throw new Error(`transaction ${sig} failed on-chain (often slippage): ${JSON.stringify(value.err)}`);
    // the RPC can take a moment to show the new balance after the trade confirms
    let after = before;
    for (let i = 0; i < 6 && after === before; i++) {
      if (i) await sleep(500);
      after = side === 'buy' ? await tokenBalance(mint) : BigInt(await connection.getBalance(owner));
    }
    return { outRaw: after > before ? after - before : 0n, sig, via: 'pumpportal', sentAt };
  }

  /** What selling `tokensRaw` would return right now, in lamports (null if no price). */
  async function valueOf(mint, tokensRaw) {
    try {
      const q = await getQuote({ inputMint: mint, outputMint: WSOL, amount: String(tokensRaw), slippageBps: cfg.sellSlippageBps });
      return BigInt(q.outAmount);
    } catch {
      const c = await curveOf(mint);
      return c ? curveOut('sell', c, BigInt(tokensRaw)) : null;
    }
  }

  async function copyBuy(w, t) {
    const why = buySkipReason(w, t);
    if (why) return log(`  skip: ${why}`);
    buysInFlight++;
    try {
      // Everything that doesn't depend on each other runs at once: the price quote, the token safety check and
      // (for trades read from the logs) whether the wallet already held this coin.
      const lamports = Math.round((w.buyAmountSol ?? cfg.buyAmountSol) * LAMPORTS);
      // A coin still on its Pump.fun curve is bought straight on the curve (like the fast terminals do), without
      // waiting for a Jupiter quote; anything else gets its Jupiter quote fetched while the checks run.
      const quote = t.curve ? null : getQuote({ inputMint: WSOL, outputMint: t.mint, amount: String(lamports), slippageBps: cfg.buySlippageBps }).catch((e) => e);
      const [unsafe, heldBefore] = await Promise.all([
        failsSafetyCheck(t.mint),
        t.heldBefore ?? (cfg.onlyFirstBuy ? heldBeforeBuy(w, t).catch(() => false) : false),
      ]);
      if (unsafe) return;
      if (cfg.onlyFirstBuy && heldBefore) return log(`  skip: ${w.label} already held this coin and is adding more; SolBoy only copies their first buy`);
      await sendCopyBuy(w, t, lamports, quote);
    } finally {
      buysInFlight--;
    }
  }

  // The watched wallet's balance of a coin right now ("processed": includes the trade just seen).
  async function walletBalance(owner, mint) {
    const res = await connection.getParsedTokenAccountsByOwner(new PublicKey(owner), { mint: new PublicKey(mint) }, 'processed');
    return res.value.reduce((sum, a) => sum + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
  }
  async function heldBeforeBuy(w, t) {
    const before = (await walletBalance(w.address, t.mint)) - t.tokenAmount;
    return before * 10n > t.tokenAmount; // dust left from an old trade doesn't count
  }
  function noteSpeed(t, sentAt) {
    if (!t.seenAt) return '';
    const sec = Math.max(0, (sentAt - t.seenAt) / 1000);
    speeds.push(sec);
    if (speeds.length > 20) speeds.shift();
    return ` ⚡ copied in ${sec.toFixed(2)}s`;
  }

  async function sendCopyBuy(w, t, lamports, quote) {
    try {
      const { outRaw, sig, sentAt } = t.curve ? await curveSwap('buy', t.mint, BigInt(lamports), cfg.buySlippageBps, t.curve) : await swap('buy', t.mint, BigInt(lamports), cfg.buySlippageBps, quote);
      const sol = lamports / LAMPORTS;
      positions.open(t.mint, {
        source: w.address,
        sourceLabel: w.label,
        solSpent: sol,
        boughtTotal: sol,
        soldTotal: 0,
        tokens: outRaw.toString(),
        openedAt: new Date().toISOString(),
      });
      log(c.green(`  ${tag()}BOUGHT ${sol} SOL of ${short(t.mint)}`) + noteSpeed(t, sentAt) + (sig ? `  tx: ${sig}` : ''));
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
    if (t.fractionSold == null) {
      // read from the logs: what's left in their wallet right after the sell tells how much they sold
      const left = await walletBalance(w.address, t.mint).catch(() => null);
      t.fractionSold = left == null ? 1 : Math.min(1, Number(t.tokenAmount) / Number(left + t.tokenAmount));
    }
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

  async function sellPosition(mint, fraction, reason, slippageBps = null, throwErrors = false, prioLamports = null) {
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

      const { outRaw, sig } = await swap('sell', mint, amount, slippageBps ?? cfg.sellSlippageBps, null, prioLamports);
      const solOut = Number(outRaw) / LAMPORTS;
      const cost = pos.solSpent * (full ? 1 : Number(amount) / Number(held));
      const pnl = solOut - cost;
      positions.recordPnl(pnl);
      if (full) {
        positions.close(mint);
        finishRetiring(pos.source);
      }
      else positions.update(mint, { solSpent: pos.solSpent - cost, tokens: (held - amount).toString(), boughtTotal: pos.boughtTotal ?? pos.solSpent, soldTotal: (pos.soldTotal ?? 0) + solOut });

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

  /** Sell every open position (e.g. when pausing). Coins nobody will buy any more are written off so they stop taking a slot. */
  async function sellAll() {
    const out = { sold: 0, writtenOff: 0, failed: [] };
    for (const [mint, pos] of positions.entries()) {
      const r = await withLock(mint, () => sellPosition(mint, 1, 'sold all (from the dashboard)', null, true)).catch((e) => ({ error: e }));
      if (r?.ok || !positions.has(mint)) { out.sold++; continue; }
      const value = await valueOf(mint, pos.tokens).catch(() => null);
      if (!value) {
        positions.recordPnl(-pos.solSpent);
        positions.close(mint);
        finishRetiring(pos.source);
        log(c.yellow(`  ${short(mint)}: no buyers left, written off (-${pos.solSpent.toFixed(4)} SOL)`));
        recordTrade(book.tradeLogFile, { action: `${tag()}sell`, mint, wallet: pos.sourceLabel, sol: '0', pnl: (-pos.solSpent).toFixed(6), reason: 'written off: no buyers left', tx: null });
        out.writtenOff++;
      } else out.failed.push(short(mint));
    }
    return out;
  }

  let checking = false;
  async function checkExits() {
    if (checking || !(cfg.takeProfitPct || cfg.stopLossPct)) return;
    checking = true;
    try {
      for (const [mint, pos] of positions.entries()) {
        try {
          // a real-money position whose token count wasn't known yet: read it from the wallet first
          if (!cfg.dryRun && BigInt(pos.tokens ?? 0) === 0n) {
            const held = await tokenBalance(mint);
            if (held === 0n) continue;
            positions.update(mint, { tokens: held.toString() });
            pos.tokens = held.toString();
          }
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
        handleSignature(w, logs.signature, seenAt, logs.logs).catch((e) => log(`Error handling ${short(logs.signature)}: ${e.message}`));
      },
      'processed', // the earliest the network reports a trade: about half a second before "confirmed"
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
    copySpeed: () => (speeds.length ? { last: speeds.at(-1), avg: speeds.reduce((a, b) => a + b, 0) / speeds.length, n: speeds.length } : null),
    setWalletPaused(key, paused) {
      const k = String(key ?? '').trim().toLowerCase();
      const w = cfg.wallets.find((x) => x.address.toLowerCase() === k || x.label.toLowerCase() === k);
      if (!w) throw new Error(`No wallet called "${String(key).slice(0, 44)}".`);
      if (paused) w.paused = true;
      else delete w.paused;
      saveWallets(cfg.wallets);
      log(paused ? `Copying switched OFF for ${w.label}. Sells of coins you hold from it still follow.` : `Copying switched ON for ${w.label}.`);
      return w;
    },
    sellAll,
    sellNow: (mint) => withLock(mint, () => sellPosition(mint, 1, 'sold by you from the dashboard')),
    valueOf,
    addWallet,
    removeWallet,
  };
}
