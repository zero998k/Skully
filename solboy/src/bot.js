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
export function createBot({ cfg, connection, book, onToken, rpcFetch }) {
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
      // Research starts the moment a watched wallet buys, alongside the copy, not after it.
      if (t.side === 'buy' && cfg.research.on === 'detected') {
        onToken?.(t.mint, { trigger: `watched wallet ${w.label} bought`, theirBuySol: t.solAmount });
      }
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

  async function copyBuy(w, t) {
    const why = buySkipReason(w, t);
    if (why) return log(`  skip: ${why}`);
    if (await failsSafetyCheck(t.mint)) return;

    const lamports = Math.round((w.buyAmountSol ?? cfg.buyAmountSol) * LAMPORTS);
    try {
      const quote = await getQuote({ inputMint: WSOL, outputMint: t.mint, amount: lamports, slippageBps: cfg.buySlippageBps });
      const sig = cfg.dryRun ? null : await executeSwap(quote);
      const sol = lamports / LAMPORTS;
      positions.open(t.mint, {
        source: w.address,
        sourceLabel: w.label,
        solSpent: sol,
        tokens: quote.outAmount,
        openedAt: new Date().toISOString(),
      });
      log(c.green(`  ${tag()}BOUGHT ${sol} SOL of ${short(t.mint)}`) + (sig ? `  tx: ${sig}` : ''));
      if (cfg.research.on === 'buys') {
        onToken?.(t.mint, { trigger: `copied a buy by watched wallet ${w.label}`, theirBuySol: t.solAmount, ourBuySol: sol });
      }
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
    const fraction = cfg.sellMode === 'all' ? 1 : t.fractionSold;
    await sellPosition(t.mint, fraction, `${w.label} sold ${Math.round(t.fractionSold * 100)}%`);
  }

  async function tokenBalance(mint) {
    const res = await connection.getParsedTokenAccountsByOwner(book.keypair.publicKey, { mint: new PublicKey(mint) });
    return res.value.reduce((sum, a) => sum + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
  }

  async function sellPosition(mint, fraction, reason) {
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

      const quote = await getQuote({ inputMint: mint, outputMint: WSOL, amount: amount.toString(), slippageBps: cfg.sellSlippageBps });
      const sig = cfg.dryRun ? null : await executeSwap(quote);

      const solOut = Number(quote.outAmount) / LAMPORTS;
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
    } catch (e) {
      log(`  sell failed for ${short(mint)}: ${e.message}`);
    }
  }

  let checking = false;
  async function checkExits() {
    if (checking || !(cfg.takeProfitPct || cfg.stopLossPct)) return;
    checking = true;
    try {
      for (const [mint, pos] of positions.entries()) {
        try {
          const quote = await getQuote({ inputMint: mint, outputMint: WSOL, amount: pos.tokens, slippageBps: cfg.sellSlippageBps });
          const pct = ((Number(quote.outAmount) / LAMPORTS - pos.solSpent) / pos.solSpent) * 100;
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

  return {
    start,
    handleSignature,
    checkExits,
    setBuyingPaused(value) {
      buyingPaused = value;
      log(value ? 'Copying PAUSED. Sells still follow the copied wallets.' : 'Copying RESUMED.');
    },
    isBuyingPaused: () => buyingPaused,
    sellNow: (mint) => withLock(mint, () => sellPosition(mint, 1, 'sold by you from the dashboard')),
    addWallet,
    removeWallet,
  };
}
