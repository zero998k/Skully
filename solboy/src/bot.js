import bs58 from 'bs58';
import { randomUUID } from 'node:crypto';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { parseTrades, looksLikeSwap, pumpTradesFromLogs, WSOL } from './detect.js';
import { getQuote, buildSwap, getMarketPrices, backgroundPriceReady } from './jupiter.js';
import { log, short, recordTrade, notify, c } from './log.js';
import { checkWallet, saveWallets } from './config.js';
import { recordCopy } from './finder.js';
import { transactionFill } from './fills.js';
import { createLivePrices, positionPriceKey, decodeCurve } from './live-prices.js';

const LAMPORTS = 1e9;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The copy-trading engine. Everything it talks to is passed in so it can be tested without a network.
 * The book says whether we're paper or real-money trading, and holds the trading keypair.
 */
const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

export function createBot({ cfg, connection, book, rpcFetch, priceConnection }) {
  const positions = book.positions;
  const seen = new Set();
  const session = randomUUID(), sourceSells = new Map(), sourceBuys = new Map(), manualSells = new Map(), pendingReceipts = new Map(), activity = [];
  let sourceSequence = 0;
  const sourceKey = (w, mint) => `${w.address}:${mint}`;
  const newer = (a, b) => a && b && (a.slot && b.slot && a.slot !== b.slot ? a.slot > b.slot :
    a.session === b.session ? (a.sequence !== b.sequence ? a.sequence > b.sequence : (a.index ?? 0) > (b.index ?? 0)) : a.seenAt > b.seenAt);
  const deadline = (promise, ms, message) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    Promise.resolve(promise).then(resolve, reject).finally(() => clearTimeout(timer));
  });

  const locks = new Map();
  let ignored = 0;
  let buyingPaused = false;
  const speeds = []; // Sent and confirmation-observed times, measured from this bot receiving the trigger.
  const noRoutes = new Map();
  const buyReservations = new Set(); // Reserved slots before an on-chain pending position is saved.
  let buysInFlight = 0; // copy buys still being sent, so several at once can't go past maxOpenPositions
  book.isTrading=()=>buysInFlight>0||locks.size>0;
  const exitQueued=new Set(), lastReconcile=new Map();
  const balanceRepairs=new Set(),lastBalanceRepair=new Map();
  const prices=priceConnection?createLivePrices({connection:priceConnection,book,isTrading:()=>buysInFlight>0||locks.size>0,
    readQuote:(mint,tokens,signal)=>quoteFor({inputMint:mint,outputMint:WSOL,amount:tokens,slippageBps:cfg.sellSlippageBps,signal,background:true}),
    readMarket:getMarketPrices,canRequest:backgroundPriceReady,
    quotePriority:(pos,worth)=>{const pct=(worth/pos.solSpent-1)*100;return (cfg.takeProfitPct&&pct>=cfg.takeProfitPct)||(cfg.stopLossPct&&pct<=-Math.abs(cfg.stopLossPct))?1:0;},
    onCurve:(mint,curve)=>rememberCurve(mint,curve)}):null;
  const tag = () => (cfg.dryRun ? 'PAPER ' : '');

  function decision(w,t,status,reason){
    activity.push({at:Date.now(),wallet:w.label,address:w.address,mint:t?.mint??null,side:t?.side??null,status,reason,signature:t?.signature??null});
    if(activity.length>200)activity.shift();
  }

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

  async function handleSignature(w, signature, seenAt = Date.now(), logLines = null, slot = null, retryOrder = null) {
    const seenKey=`${w.address}:${signature}`;
    if (!retryOrder&&seen.has(seenKey)) return;
    seen.add(seenKey);
    if (seen.size > 5000) seen.delete(seen.values().next().value);
    if((w.paused||buyingPaused||w.retiring)&&!holdingFrom(w.address)&&!buysInFlight){
      const reason=buyingPaused?'copying is paused':`copying is switched off for ${w.label}`;
      decision(w,null,'Skipped',reason);log(`  skip: ${reason}`);return;
    }
    // Assign order BEFORE a transaction download: a slow old buy must not overtake a newer exit.
    const order = retryOrder ?? { seenAt, slot, sequence: ++sourceSequence, session };
    const events = logLines ? pumpTradesFromLogs(logLines,w.address) : [];
    const fast = events.some(t=>t.requiresReceipt) ? [] : events;
    const tx = fast.length ? null : await fetchTx(signature);
    if(!fast.length&&!tx){
      pendingReceipts.set(seenKey,{w,signature,seenAt,slot,order,logLines,attemptAt:Date.now()});
      if(pendingReceipts.size>500)pendingReceipts.delete(pendingReceipts.keys().next().value);
      decision(w,null,'Waiting','Source receipt is delayed; retrying without copying twice');return;
    }
    pendingReceipts.delete(seenKey);
    const trades = fast.length ? fast : parseTrades(tx,w.address,events.map(t=>t.quoteMint).filter(Boolean));
    if(!trades.length)decision(w,null,'Not copied',events.some(t=>t.requiresReceipt)?'Non-SOL swap had no verifiable SOL input/output; no price was invented':'No supported SOL swap found in this receipt');
    for (const [index, t] of trades.entries()) {
      Object.assign(t, { seenAt, order: { ...order, index }, signature });
      if (t.curve) rememberCurve(t.mint, t.curve);
      const map = t.side === 'sell' ? sourceSells : sourceBuys, key = sourceKey(w, t.mint);
      if (!map.has(key) || newer(t.order, map.get(key).order)) map.set(key, t);
      if (map.size > 5000) map.delete(map.keys().next().value);
      // Start the source balance read now, overlapping our buy's confirmation rather than delaying the exit.
      if (t.side === 'sell' && t.fractionSold == null && (positions.has(t.mint) || locks.has(t.mint))) {
        t.left = walletBalance(w.address, t.mint).catch(() => null);
      }
    }
    await Promise.all(trades.map(t => withLock(t.mint, async () => {
      log(`${w.label} ${t.side.toUpperCase()} ${short(t.mint)} for ${t.solAmount.toFixed(3)} SOL${fast.length ? ' (seen live)' : ''}`);
      if (t.side === 'buy') await copyBuy(w, t);
      else await copySell(w, t);
    })));
  }

  async function sourceFraction(w, t) {
    if (t.fractionSold != null) return t.fractionSold;
    // A subsequent re-entry can make a current-balance read misleading. Use this sell's own receipt.
    if (newer(sourceBuys.get(sourceKey(w, t.mint))?.order, t.order)) {
      const exact = parseTrades(await fetchTx(t.signature), w.address).find(x => x.mint === t.mint && x.side === 'sell');
      if (!exact) throw new Error('Could not verify the developer sell before their next buy');
      return t.fractionSold = exact.fractionSold;
    }
    const left = await (t.left ?? walletBalance(w.address, t.mint).catch(() => null));
    if (left == null) throw new Error('Could not verify the developer token balance; sell was not submitted');
    return t.fractionSold = Math.min(1, Number(t.tokenAmount) / Number(left + t.tokenAmount));
  }

  async function checkEntry(w, t) {
    if (Date.now() - t.seenAt > cfg.maxCopyDelaySeconds * 1000) throw new Error('Buy skipped: the source trade is too old');
    if (buyingPaused || w.paused || w.retiring) throw new Error('Buy skipped: copying was switched off');
    const exit = sourceSells.get(sourceKey(w, t.mint));
    if (cfg.followSells && newer(exit?.order, t.order)) {
      const fraction = await sourceFraction(w, exit);
      if (fraction >= 0.9 || (!cfg.sellOnlyOnFullExit && cfg.sellMode === 'all')) {
        throw new Error('Buy skipped: the developer already exited before our order was sent');
      }
    }
  }

  function buySkipReason(w, t) {
    if (w.retiring) return `${w.label} was removed, so SolBoy only follows its sells for tokens you still hold`;
    if (buyingPaused) return 'copying is paused (from the dashboard)';
    if (w.paused) return `copying is switched off for ${w.label} (Wallets tab)`;
    if (cfg.onlyFirstBuy && t.heldBefore) return `${w.label} already held this coin and is adding more; SolBoy only copies their first buy`;
    if (positions.has(t.mint)) return 'already holding this token';
    if(cfg.dryRun&&book.paperWallet&&!book.paperWallet.canSpend(Math.round((w.buyAmountSol??cfg.buyAmountSol)*LAMPORTS)))return 'not enough paper SOL; choose a smaller buy or reset Paper funds when your positions are closed';
    if (cfg.blocklist.includes(t.mint)) return 'token is on your blocklist';
    if (t.solAmount < cfg.minSourceBuySol) return `their buy is under minSourceBuySol (${cfg.minSourceBuySol} SOL)`;
    if (positions.count() + [...buyReservations].filter(m=>!positions.has(m)).length >= cfg.maxOpenPositions) return `already at maxOpenPositions (${cfg.maxOpenPositions})`;
    if (positions.todayPnl() <= -cfg.dailyLossLimitSol) return `daily loss limit of ${cfg.dailyLossLimitSol} SOL reached`;
    return null;
  }

  async function failsSafetyCheck(mint) {
    if (!cfg.skipIfMintAuthority && !cfg.skipIfFreezeAuthority) return false;
    try {
      // Launch logs arrive at processed. A confirmed-only mint lookup can still be null at that instant.
      let info;
      for(let attempt=0;attempt<3;attempt++){
        info=(await connection.getParsedAccountInfo(new PublicKey(mint),'processed')).value?.data?.parsed?.info;
        if(info)break;
        if(attempt<2)await sleep(75);
      }
      if (!info) return log('  skip: could not read token info'), true;
      if (cfg.skipIfMintAuthority && info.mintAuthority) return log('  skip: creator can still mint more of this token'), true;
      if (cfg.skipIfFreezeAuthority && info.freezeAuthority) return log("  skip: creator can freeze holders' tokens"), true;
      return false;
    } catch (e) {
      log(`  skip: token check failed (${e.message})`);
      return true;
    }
  }

  async function quoteFor(args) {
    try {
      const quote = await getQuote(args);
      noRoutes.delete(args.inputMint === WSOL ? args.outputMint : args.inputMint);
      return quote;
    } catch (e) {
      if (/no route|could not find any route/i.test(e.message)) {
        noRoutes.set(args.inputMint === WSOL ? args.outputMint : args.inputMint, Date.now());
        if (noRoutes.size > 500) noRoutes.delete(noRoutes.keys().next().value);
      }
      throw e;
    }
  }

  async function executeSwap(quote, prioLamports = null, hooks = {}) {
    const { swapTransaction, lastValidBlockHeight } = await buildSwap(
      quote,
      book.keypair.publicKey.toBase58(),
      prioLamports ?? cfg.priorityFeeMaxLamports,
    );
    const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
    tx.sign([book.keypair]);
    await hooks.beforeSubmit?.();
    hooks.onSubmitted?.({ sig: bs58.encode(tx.signatures[0]), blockhash: tx.message.recentBlockhash });
    const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 2 });
    const sentAt = Date.now();
    return {signature,sentAt,confirm:()=>connection.confirmTransaction({signature,blockhash:tx.message.recentBlockhash,lastValidBlockHeight},'confirmed')};
  }

  /**
   * Price a trade with Jupiter and (in real-money mode) send it. Brand-new Pump.fun coins aren't on Jupiter yet, so
   * when Jupiter can't quote: paper mode prices from the coin's live bonding curve, and real-money mode has
   * PumpPortal build the transaction. A trade that was sent is never retried another way.
   */
  async function swap(side, mint, amountRaw, slippageBps, prefetched = null, prioLamports = null, hooks = {}) {
    const [inputMint, outputMint] = side === 'buy' ? [WSOL, mint] : [mint, WSOL];
    // Only bypass a quote when it just explicitly said there is no route AND a fresh Pump event
    // tells us the curve is active. Routed coins keep their existing path and settings.
    const activeCurve = curves.get(mint);
    if (side === 'sell' && Date.now() - (noRoutes.get(mint) ?? 0) < 2000 && activeCurve && Date.now() - activeCurve.at < 2000) {
      return curveSwap(side, mint, amountRaw, slippageBps, activeCurve.curve, prioLamports, hooks);
    }
    let quote;
    try {
      quote = prefetched ? await prefetched : await quoteFor({ inputMint, outputMint, amount: amountRaw.toString(), slippageBps });
      if (quote instanceof Error) throw quote;
    } catch (e) {
      const c = await curveOf(mint);
      if (!c) throw e;
      await hooks.beforeSubmit?.();
      if (cfg.dryRun) return { outRaw: curveOut(side, c, amountRaw), sig: null, via: 'curve', sentAt: Date.now(), confirmedAt: null };
      return pumpPortalSwap(side, mint, amountRaw, slippageBps, prioLamports, hooks);
    }
    await hooks.beforeSubmit?.();
    if (cfg.dryRun) return { outRaw: BigInt(quote.outAmount), sig: null, via: 'jupiter', sentAt: Date.now(), confirmedAt: null };
    const { signature, sentAt, confirm } = await executeSwap(quote, prioLamports, hooks);
    return receiptFill(side,mint,{sig:signature,via:'jupiter',sentAt},hooks,confirm);
  }

  /** Trade straight on a Pump.fun curve: priced from the curve in paper mode, built by PumpPortal with real money. */
  async function curveSwap(side, mint, amountRaw, slippageBps, curve, prioLamports = null, hooks = {}) {
    await hooks.beforeSubmit?.();
    if (cfg.dryRun) return { outRaw: curveOut(side, curve, amountRaw), sig: null, via: 'curve', sentAt: Date.now(), confirmedAt: null };
    return pumpPortalSwap(side, mint, amountRaw, slippageBps, prioLamports, hooks);
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
      const c=decodeCurve(info);
      if(c&&!c.complete)curve={vSol:Number(c.sol)/LAMPORTS,vTokens:Number(c.tokens)/1e6};
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

  async function pumpPortalSwap(side, mint, amountRaw, slippageBps, prioLamports = null, hooks = {}) {
    const owner = book.keypair.publicKey;
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
    await hooks.beforeSubmit?.();
    hooks.onSubmitted?.({ sig: bs58.encode(tx.signatures[0]), blockhash: tx.message.recentBlockhash });
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 2 });
    const sentAt = Date.now();
    return receiptFill(side,mint,{sig,via:'pumpportal',sentAt},hooks,()=>connection.confirmTransaction(sig,'confirmed'));
  }

  async function receiptFill(side,mint,timing,hooks,confirm) {
    let subscription,observedAt=null,notified=false,rejectFailure,wake;
    const ready=new Promise(resolve=>wake=resolve),failure=new Promise((_,reject)=>rejectFailure=reject);
    try{
      if(typeof connection.onSignature==='function'){
        subscription=connection.onSignature(timing.sig,result=>{
          notified=true;
          if(result.err){hooks.onFailed?.();rejectFailure(Object.assign(new Error(`Transaction failed on-chain: ${JSON.stringify(result.err)}`),{onChainFailure:true}));}
          else{observedAt=Date.now();wake();}
        },'confirmed');
      }else{
        const {value}=await deadline(confirm(),20_000,'Confirmation is taking longer than expected');
        if(value.err){hooks.onFailed?.();throw new Error(`transaction ${timing.sig} failed on-chain (often slippage): ${JSON.stringify(value.err)}`);}
        observedAt=Date.now();
      }
      // A confirmed receipt proves both confirmation and the fill. Do not spend another urgent RPC
      // slot polling signature status first. The WS wakes the next read as soon as confirmation arrives.
      const read=async()=>{
        for(let i=0;i<12;i++){
          const tx=await getTransaction(timing.sig);if(tx)return tx;
          if(i<11)await Promise.race([ready,sleep(250)]);
          // A resolved wake must not turn a lagging receipt into a hot retry loop.
          if(observedAt&&i<11)await sleep(75);
        }
        return null;
      };
      const tx=await deadline(Promise.race([read(),failure]),20_000,'Confirmation receipt is delayed');
      const fill=transactionFill(tx,book.keypair.publicKey.toBase58(),mint,side);
      if(!fill)throw new Error('Trade confirmation or receipt is delayed. The pending trade is saved and will be checked again.');
      return {...timing,confirmedAt:observedAt??Date.now(),outRaw:side==='buy'?fill.tokensRaw:fill.solRaw,costRaw:side==='buy'?fill.solRaw:null,filledTokens:fill.tokensRaw};
    }catch(e){if(e.onChainFailure)hooks.onFailed?.();throw e;}
    finally{if(subscription!=null&&!notified)Promise.resolve(connection.removeSignatureListener(subscription)).catch(()=>{});}
  }

  /** What selling `tokensRaw` would return right now, in lamports (null if no price). */
  async function valueOf(mint, tokensRaw) {
    try {
      const q = await quoteFor({ inputMint: mint, outputMint: WSOL, amount: String(tokensRaw), slippageBps: cfg.sellSlippageBps });
      return BigInt(q.outAmount);
    } catch {
      const c = await curveOf(mint);
      return c ? curveOut('sell', c, BigInt(tokensRaw)) : null;
    }
  }

  async function copyBuy(w, t) {
    const why = buySkipReason(w, t);
    if (why) {decision(w,t,'Skipped',why);return log(`  skip: ${why}`);}
    buysInFlight++;buyReservations.add(t.mint);
    try {
      // Everything that doesn't depend on each other runs at once: the price quote, the token safety check and
      // (for trades read from the logs) whether the wallet already held this coin.
      const lamports = Math.round((w.buyAmountSol ?? cfg.buyAmountSol) * LAMPORTS);
      // A coin still on its Pump.fun curve is bought straight on the curve (like the fast terminals do), without
      // waiting for a Jupiter quote; anything else gets its Jupiter quote fetched while the checks run.
      const quote = t.curve ? null : quoteFor({ inputMint: WSOL, outputMint: t.mint, amount: String(lamports), slippageBps: cfg.buySlippageBps }).catch((e) => e);
      const [unsafe, heldBefore] = await Promise.all([
        failsSafetyCheck(t.mint),
        t.heldBefore ?? (cfg.onlyFirstBuy ? heldBeforeBuy(w, t).catch(() => false) : false),
      ]);
      if (unsafe) {decision(w,t,'Skipped','Token failed the configured mint/freeze authority safety check');return;}
      if (cfg.onlyFirstBuy && heldBefore) {decision(w,t,'Skipped','Source already held this coin; first-buy rule is on');return log(`  skip: ${w.label} already held this coin and is adding more; SolBoy only copies their first buy`);}
      await sendCopyBuy(w, t, lamports, quote);
    } finally {
      buysInFlight--;buyReservations.delete(t.mint);
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
  function noteSpeed(t, timing) {
    if (!t?.seenAt) return '';
    const sent = Math.max(0, (timing.sentAt - t.seenAt) / 1000);
    const confirmed = timing.confirmedAt == null ? null : Math.max(sent, (timing.confirmedAt - t.seenAt) / 1000);
    const complete = Math.max(sent, (Date.now() - t.seenAt) / 1000);
    speeds.push({ sent, confirmed, complete, side: t.side, paper: cfg.dryRun });
    if (speeds.length > 20) speeds.shift();
    return ` ⚡ sent in ${sent.toFixed(2)}s` + (confirmed == null ? ' (paper)' : `, confirmation observed in ${confirmed.toFixed(2)}s`);
  }

  async function sendCopyBuy(w, t, lamports, quote) {
    let paperReservation=null;
    try {
      if(cfg.dryRun)paperReservation=book.paperWallet?.reserve(lamports)??null;
      const hooks = {
        beforeSubmit:()=>checkEntry(w,t),
        onSubmitted:transaction=>positions.open(t.mint,{
          source:w.address,sourceLabel:w.label,sourceTrade:t.order,solSpent:lamports/LAMPORTS,boughtTotal:lamports/LAMPORTS,soldTotal:0,tokens:'0',openedAt:new Date().toISOString(),
          pendingBuy:{...transaction,seenAt:t.seenAt,submittedAt:Date.now()},
        }),
        onFailed:()=>positions.close(t.mint),
      };
      const timing = t.curve ? await curveSwap('buy', t.mint, BigInt(lamports), cfg.buySlippageBps, t.curve, null, hooks) : await swap('buy', t.mint, BigInt(lamports), cfg.buySlippageBps, quote, null, hooks);
      finishBuy(w,t,timing,lamports,paperReservation);

    } catch (e) {
      decision(w,t,positions.get(t.mint)?.pendingBuy?'Pending':'Not copied',e.message);
      log(`  ${positions.get(t.mint)?.pendingBuy?'buy pending':'buy failed'}: ${e.message}`);
    }finally{book.paperWallet?.release(paperReservation);}
  }

  function finishBuy(w,t,timing,expectedLamports,paperReservation=null) {
    const sol=Number(timing.costRaw??expectedLamports)/LAMPORTS;
    const opened={source:w.address,sourceLabel:w.label,sourceTrade:t.order,solSpent:sol,boughtTotal:sol,soldTotal:0,tokens:String(timing.outRaw),fillVerified:Boolean(timing.sig),balanceAt:Date.now(),openedAt:positions.get(t.mint)?.openedAt??new Date().toISOString()};
    if(cfg.dryRun&&book.paperWallet)book.paperWallet.commitBuy(paperReservation,t.mint,opened,expectedLamports);else positions.open(t.mint,opened);
    if(t.curve)prices?.seedCurve(t.mint,t.curve,t.order?.slot,t.seenAt);
    recordTrade(book.tradeLogFile,{action:`${tag()}buy`,mint:t.mint,wallet:w.label,sol,reason:`copied ${w.label}${cfg.dryRun?' (simulation estimate)':' (receipt verified, including network costs)'}`,tx:timing.sig});
    decision(w,t,'Copied',cfg.dryRun?'Practice buy priced as an estimate':'Buy receipt verified');
    recordCopy({mint:t.mint,wallet:w.label,source:w.address,sol,tokens:String(timing.outRaw)});
    log(c.green(`  ${tag()}BOUGHT ${sol} SOL of ${short(t.mint)}`)+noteSpeed(t,timing)+(timing.sig?`  tx: ${timing.sig}`:''));
    notify(`${tag()}BUY ${sol} SOL of ${t.mint}\ncopied ${w.label}\nhttps://dexscreener.com/solana/${t.mint}`);
  }

  async function reconcileBuy(mint) {
    const pos=positions.get(mint),pending=pos?.pendingBuy;if(!pending)return;
    const status=(await connection.getSignatureStatuses([pending.sig],{searchTransactionHistory:true})).value[0];
    if(status?.err){positions.close(mint);log(`Buy failed on-chain for ${short(mint)}; no tokens were bought.`);return;}
    if(status&&['confirmed','finalized'].includes(status.confirmationStatus)){
      const tx=await getTransaction(pending.sig),fill=transactionFill(tx,book.keypair.publicKey.toBase58(),mint,'buy');if(!fill)return;
      const exit=pos.queuedExit,sourceExit=pos.queuedSourceExit;
      finishBuy({address:pos.source,label:pos.sourceLabel},{mint,side:'buy',seenAt:pending.seenAt,order:pos.sourceTrade},
        {outRaw:fill.tokensRaw,costRaw:fill.solRaw,sig:pending.sig,sentAt:pending.submittedAt,confirmedAt:Date.now()},0);
      if(exit||sourceExit)positions.update(mint,{queuedExit:exit??null,queuedSourceExit:sourceExit??null});
    }else if(!status&&connection.isBlockhashValid&&!(await connection.isBlockhashValid(pending.blockhash,'finalized')).value){
      const again=(await connection.getSignatureStatuses([pending.sig],{searchTransactionHistory:true})).value[0];if(!again){positions.close(mint);log(`Buy expired without landing for ${short(mint)}.`);}
    }
  }

  const savedSourceExit=t=>({mint:t.mint,side:t.side,seenAt:t.seenAt,order:t.order,signature:t.signature,tokenAmount:String(t.tokenAmount),curve:t.curve,fractionSold:t.fractionSold});
  async function copySell(w,t){
    const pos=positions.get(t.mint);
    if(!pos||!cfg.followSells)return;
    if(pos.source!==w.address)return log(`  not selling: this position was copied from ${pos.sourceLabel}`);
    if(newer(pos.sourceTrade,t.order))return log('  not selling: this exit belongs to an earlier source entry');
    const id=JSON.stringify([t.signature??t.order?.seenAt??t.seenAt,t.order?.index??0]);
    if((pos.sourceExitIds??[]).includes(id)||newer(pos.lastSourceExitOrder,t.order))return;
    // An uncertain buy has no reliable token quantity yet. Keep the source instruction
    // until its own receipt supplies one; never turn a partial sell into a full exit.
    if(pos.pendingBuy){
      positions.update(t.mint,{queuedSourceExit:savedSourceExit(t)});await reconcileBuy(t.mint);
      if(positions.get(t.mint)?.pendingBuy||!positions.has(t.mint))return;
      return copySell(w,t);
    }
    try{t.fractionSold=await sourceFraction(w,t);}
    catch(error){
      const previous=pos.queuedSourceExit;
      if(!previous||newer(t.order,previous.order))positions.update(t.mint,{queuedSourceExit:savedSourceExit(t)});
      return log(`Developer sell is waiting for its receipt: ${error.message}`);
    }
    if(pos.queuedSourceExit)positions.update(t.mint,{queuedSourceExit:null});
    const out=t.fractionSold>=.9;
    if(cfg.sellOnlyOnFullExit&&!out)return log(`  not selling yet: ${w.label} sold ${Math.round(t.fractionSold*100)}% and still holds most of it. SolBoy sells when they sell 90% or more`);
    const fraction=cfg.sellOnlyOnFullExit||cfg.sellMode==='all'?1:Math.min(1,Math.max(0,t.fractionSold));
    if(!(fraction>0))return;
    const previous=pos.copiedExit,held=BigInt(pos.tokens),base=previous?BigInt(previous.targetRemaining)<held?BigInt(previous.targetRemaining):held:held;
    const target=fraction>=.98?0n:base-base*BigInt(Math.round(fraction*10000))/10000n;
    const reason=previous?.targetRemaining==='0'?previous.reason:out&&cfg.sellOnlyOnFullExit?`${w.label} sold out`:`${w.label} sold ${Math.round(t.fractionSold*100)}%`;
    positions.update(t.mint,{copiedExit:{id,targetRemaining:String(target),reason,trigger:{seenAt:t.seenAt,side:'sell',signature:t.signature,curve:t.curve},attempts:0,
      nextAttemptAt:previous?.lastError?previous.nextAttemptAt:Date.now(),lastError:previous?.lastError??null},
      sourceExitIds:[...(pos.sourceExitIds??[]),id].slice(-32),lastSourceExitOrder:t.order});
    await runCopiedExit(t.mint,id);
  }

  async function runCopiedExit(mint,id){
    const pos=positions.get(mint),exit=pos?.copiedExit;
    if(!exit||exit.id!==id||!cfg.followSells||Date.now()<(exit.nextAttemptAt??0)||pos.pendingSell)return;
    positions.update(mint,{copiedExit:{...exit,attempts:exit.attempts+1}});
    if(exit.attempts)log(`Copy sell retry for ${short(mint)} (attempt ${exit.attempts+1}).`);
    const trigger={...exit.trigger,copiedExitId:id};if(exit.attempts)delete trigger.curve;
    await sellPosition(mint,1,exit.reason,null,false,null,trigger);
  }

  async function tokenBalance(mint, reader = connection) {
    const res = await reader.getParsedTokenAccountsByOwner(book.keypair.publicKey, { mint: new PublicKey(mint) }, 'confirmed');
    return res.value.reduce((sum, a) => sum + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
  }

  async function sellPosition(mint, fraction, reason, slippageBps = null, throwErrors = false, prioLamports = null, trigger = null) {
    trigger ??= { seenAt: Date.now(), side: 'sell' };
    const pos = positions.get(mint);
    if (!pos) return;
    try {
      if(pos.pendingBuy){
        await reconcileBuy(mint);if(!positions.has(mint))return;
        if(positions.get(mint)?.pendingBuy)throw Object.assign(new Error('The buy receipt is still delayed. Your sell is queued until its tokens are confirmed.'),{code:'BALANCE_PENDING'});
        return sellPosition(mint,fraction,reason,slippageBps,throwErrors,prioLamports,trigger);
      }
      if (pos.pendingSell) {
        await reconcileSell(mint);
        if (positions.get(mint)?.pendingSell) throw new Error('Sell already submitted; confirmation is delayed. Use Check sell to check the same transaction.');
        if (!positions.has(mint)) return { ok: true };
        throw new Error('The earlier sell did not land. Sell now is available for a new attempt.');
      }
      // Fresh receipt quantities are authoritative. Re-reading a lagging balance here adds delay
      // and can falsely report zero immediately after a buy. Older/unverified positions are refreshed.
      const recentFill=pos.fillVerified&&Date.now()-(pos.balanceAt??0)<15_000;
      let held = cfg.dryRun||recentFill ? BigInt(pos.tokens) : await tokenBalance(mint);
      if (!cfg.dryRun && held === 0n && Date.now() - Date.parse(pos.openedAt) < 60_000) {
        for (let i = 0; i < 4 && held === 0n; i++) { await sleep(100); held = await tokenBalance(mint); }
        if (held === 0n) throw Object.assign(new Error('Your recent buy is confirmed, but the RPC has not shown the tokens yet. Your position is kept; the exit will be checked again.'), { code: 'BALANCE_PENDING' });
      }
      if (held === 0n) {
        positions.close(mint);
        finishRetiring(pos.source);
        return log(`  ${short(mint)}: no tokens left, position closed`);
      }
      if(!cfg.dryRun&&BigInt(pos.tokens)>0n&&held>BigInt(pos.tokens))held=BigInt(pos.tokens);
      const copied=trigger.copiedExitId&&positions.get(mint)?.copiedExit?.id===trigger.copiedExitId?positions.get(mint).copiedExit:null;
      const target=copied?BigInt(copied.targetRemaining):null;
      if(target!=null&&held<=target){positions.update(mint,{copiedExit:null,queuedExit:null});return {ok:true};}
      const amount=copied?held-target:fraction>=.98?held:(held*BigInt(Math.round(fraction*10000)))/10000n;
      const full=amount>=held;
      if (amount === 0n) return;

      const hooks = { onFailed: () => positions.update(mint, { pendingSell: null, fillVerified:false, balanceAt:0 }), onSubmitted: transaction => positions.update(mint, { pendingSell: {
        ...transaction, amount: String(amount), held: String(held), full, fraction, reason, trigger: { seenAt: trigger.seenAt, side: trigger.side, copiedExitId:trigger.copiedExitId }, submittedAt: Date.now(),
      } }) };
      // A fresh copied Pump sell already supplies the active venue and reserves: no quote detour.
      const freshCurve = trigger.curve && Date.now() - trigger.seenAt < 2000;
      const timing = freshCurve ? await curveSwap('sell', mint, amount, slippageBps ?? cfg.sellSlippageBps, trigger.curve, prioLamports, hooks) :
        await swap('sell', mint, amount, slippageBps ?? cfg.sellSlippageBps, null, prioLamports, hooks);
      return finishSell(mint, pos, { amount: String(amount), held: String(held), full, fraction, reason, trigger }, timing);

    } catch (e) {
      if (e.code === 'BALANCE_PENDING' && positions.has(mint)) positions.update(mint, { queuedExit: {
        fraction, reason, trigger: { seenAt: trigger.seenAt, side: trigger.side, copiedExitId:trigger.copiedExitId },
      } });
      const retry=positions.get(mint)?.copiedExit;
      if(retry&&retry.id===trigger.copiedExitId){
        const delay=e.code==='BALANCE_PENDING'?0:Math.max(e.retryAfterMs??0,Math.min(300*2**Math.min(retry.attempts-1,5),8000));
        positions.update(mint,{copiedExit:{...retry,nextAttemptAt:Date.now()+delay,lastError:String(e.message).slice(0,300)}});
        decision({address:pos.source,label:pos.sourceLabel},{mint,side:'sell',signature:retry.trigger.signature},'Sell retry',e.message);
      }
      log(`  sell failed for ${short(mint)}: ${e.message}`);
      if (throwErrors) throw new Error(pos.pendingSell ? `Sell submitted; confirmation is delayed. Check sell checks the same transaction. ${e.message}` : e.message);
    }
  }

  function finishSell(mint, pos, intent, timing) {
    const { outRaw, sig } = timing;
    const { reason, trigger } = intent, held=BigInt(pos.tokens||intent.held), actual=BigInt(timing.filledTokens??intent.amount),amount=actual>held?held:actual,full=amount>=held,fraction=Number(amount)/Number(held);
    const solOut = Number(outRaw) / LAMPORTS;
    const cost = pos.solSpent * (full ? 1 : Number(amount) / Number(held));
    const pnl = solOut - cost;
    const remaining=held-amount,exit=pos.copiedExit;
    const keepExit=exit&&remaining>BigInt(exit.targetRemaining)?{...exit,nextAttemptAt:Date.now(),lastError:null}:null;
    const next=full?null:{...pos,solSpent:pos.solSpent-cost,tokens:String(remaining),pendingSell:null,queuedExit:null,copiedExit:keepExit,
      fillVerified:Boolean(timing.sig),balanceAt:Date.now(),boughtTotal:pos.boughtTotal??pos.solSpent,soldTotal:(pos.soldTotal??0)+solOut};
    const settled=cfg.dryRun&&book.paperWallet?.settleSell(mint,next,outRaw,pnl);
    if(!settled){positions.recordPnl(pnl);if(full)positions.close(mint);else positions.update(mint,next);}
    if(full)finishRetiring(pos.source);

    const pnlText = `${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL`;
    recordTrade(book.tradeLogFile, { action: `${tag()}sell`, mint, wallet: pos.sourceLabel, sol: solOut.toFixed(6), pnl: pnl.toFixed(6), reason, tx: sig });
    log(c.yellow(`  ${tag()}SOLD ${full ? 'all' : `${Math.round(fraction * 100)}%`} of ${short(mint)} for ${solOut.toFixed(4)} SOL`) + ` (${(pnl >= 0 ? c.green : c.red)(pnlText)}) - ${reason}` + noteSpeed(trigger, timing) + (sig ? `  tx: ${sig}` : ''));
    notify(`${tag()}SELL ${short(mint)} for ${solOut.toFixed(4)} SOL (${pnlText})\n${reason}`);
    return { ok: true, side: 'sell', sol: Number(timing.outRaw) / LAMPORTS, sig: timing.sig };
  }

  async function reconcileSell(mint) {
    const pos = positions.get(mint), pending = pos?.pendingSell;
    if (!pending) return;
    const status = (await connection.getSignatureStatuses([pending.sig], { searchTransactionHistory: true })).value[0];
    if (status?.err) { positions.update(mint, { pendingSell: null }); throw new Error('The sell failed on-chain. You can try Sell now again.'); }
    if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) {
      const tx = await getTransaction(pending.sig);
      if (!tx) return; // Wait for the receipt before recording proceeds, never invent a fill.
      if (tx.meta?.err) { positions.update(mint, { pendingSell: null }); return; }
      const fill=transactionFill(tx,book.keypair.publicKey.toBase58(),mint,'sell');
      if(fill&&fill.tokensRaw>0n)finishSell(mint,pos,pending,{outRaw:fill.solRaw,filledTokens:fill.tokensRaw,sig:pending.sig,sentAt:pending.submittedAt,confirmedAt:Date.now()});
      return;
    }
    if (!status && connection.isBlockhashValid && !(await connection.isBlockhashValid(pending.blockhash, 'finalized')).value) {
      // Check history again after expiry, so a late landed transaction cannot be sent twice.
      const again = (await connection.getSignatureStatuses([pending.sig], { searchTransactionHistory: true })).value[0];
      if (!again) { positions.update(mint, { pendingSell: null }); log(`Sell expired without landing for ${short(mint)}. Sell now is available again.`); }
    }
  }

  /** Sell every open position (e.g. when pausing). Coins nobody will buy any more are written off so they stop taking a slot. */
  async function sellAll() {
    const out = { sold: 0, writtenOff: 0, failed: [] };
    for (const [mint, pos] of positions.entries()) {
      const r = await withLock(mint, () => sellPosition(mint, 1, 'sold all (from the dashboard)', null, true)).catch((e) => ({ error: e }));
      if (r?.ok || !positions.has(mint)) { out.sold++; continue; }
      if (positions.get(mint)?.pendingBuy || positions.get(mint)?.pendingSell || positions.get(mint)?.queuedExit || positions.get(mint)?.copiedExit) { out.failed.push(short(mint)); continue; }
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
  async function checkExits(recoveryOnly=false) {
    for(const [key,pending]of pendingReceipts)if(!pending.running&&Date.now()-pending.attemptAt>=2000){
      if(Date.now()-pending.seenAt>300_000){pendingReceipts.delete(key);decision(pending.w,null,'Not copied','Source receipt unavailable after five minutes');continue;}
      pending.running=true;void handleSignature(pending.w,pending.signature,pending.seenAt,pending.logLines,pending.slot,pending.order).catch(()=>{}).finally(()=>{const current=pendingReceipts.get(key);if(current)current.running=false;});
      break;
    }
    for (const [mint,pos]of positions.entries())if(pos.pendingBuy&&!locks.has(mint)&&Date.now()-(lastReconcile.get(mint)??0)>=2000){
      lastReconcile.set(mint,Date.now());void withLock(mint,()=>reconcileBuy(mint)).catch(e=>log(`Buy receipt for ${short(mint)}: ${e.message}`));
    }
    for (const [mint, pos] of positions.entries()) if (pos.pendingSell && !locks.has(mint) && Date.now()-(lastReconcile.get(mint)??0)>=2000) {
      lastReconcile.set(mint,Date.now());if(lastReconcile.size>200)lastReconcile.delete(lastReconcile.keys().next().value);
      void withLock(mint, () => reconcileSell(mint)).catch(e => log(`Sell status for ${short(mint)}: ${e.message}`));
    }
    for (const [mint, pos] of positions.entries()) if (pos.queuedExit && !pos.copiedExit && !pos.pendingSell && !locks.has(mint)) {
      const exit = pos.queuedExit;
      void withLock(mint, () => sellPosition(mint, exit.fraction, exit.reason, null, false, null, exit.trigger)).catch(() => {});
    }
    for(const [mint,pos]of positions.entries())if(pos.queuedSourceExit&&!pos.pendingSell&&!pos.queuedExit&&!locks.has(mint)&&Date.now()-(lastReconcile.get(mint)??0)>=2000){
      const w=cfg.wallets.find(w=>w.address===pos.source);if(!w)continue;
      lastReconcile.set(mint,Date.now());
      const exit={...pos.queuedSourceExit,tokenAmount:BigInt(pos.queuedSourceExit.tokenAmount)};
      void withLock(mint,()=>copySell(w,exit)).catch(()=>{});
    }
    for(const [mint,pos]of positions.entries())if(pos.copiedExit&&!pos.pendingBuy&&!pos.pendingSell&&!locks.has(mint)&&cfg.followSells&&Date.now()>=(pos.copiedExit.nextAttemptAt??0)){
      const id=pos.copiedExit.id;void withLock(mint,()=>runCopiedExit(mint,id)).catch(()=>{});
    }
    if(recoveryOnly)return;
    if (checking) return;
    if(prices){
      for(const [mint,pos]of positions.entries()){
        if(pos.pendingBuy||pos.pendingSell||pos.queuedExit||pos.queuedSourceExit||pos.copiedExit)continue;
        let tokens;try{tokens=BigInt(pos.tokens??0);}catch{continue;}
        if(!cfg.dryRun&&tokens===0n){
          const key=positionPriceKey(book.mode,mint,pos);
          if(!balanceRepairs.has(key)&&Date.now()-(lastBalanceRepair.get(key)??0)>2000){
            balanceRepairs.add(key);lastBalanceRepair.set(key,Date.now());
            if(lastBalanceRepair.size>200)lastBalanceRepair.delete(lastBalanceRepair.keys().next().value);
            void withLock(mint,async()=>{const current=positions.get(mint);if(!current||positionPriceKey(book.mode,mint,current)!==key)return;
              const held=await tokenBalance(mint,priceConnection??connection);if(held>0n)positions.update(mint,{tokens:held.toString()});
            }).catch(()=>{}).finally(()=>balanceRepairs.delete(key));
          }
          continue;
        }
        if(!(cfg.takeProfitPct||cfg.stopLossPct))continue;
        const mark=prices.get(mint,pos);if(!mark||mark.priceStale||mark.worth==null||!(pos.solSpent>0))continue;
        const pct=(mark.worth-pos.solSpent)/pos.solSpent*100;
        if(!((cfg.takeProfitPct&&pct>=cfg.takeProfitPct)||(cfg.stopLossPct&&pct<=-cfg.stopLossPct)))continue;
        const key=positionPriceKey(book.mode,mint,pos);if(exitQueued.has(key))continue;exitQueued.add(key);
        // Recheck the CURRENT position and CURRENT price after acquiring the same lock as manual/copied sells.
        void withLock(mint,async()=>{
          const current=positions.get(mint);if(!current||positionPriceKey(book.mode,mint,current)!==key)return;
          const latest=prices.get(mint,current);if(!latest||latest.priceStale||latest.worth==null||!(current.solSpent>0))return;
          const value=(latest.worth-current.solSpent)/current.solSpent*100;
          if(cfg.takeProfitPct&&value>=cfg.takeProfitPct)await sellPosition(mint,1,`take-profit hit (+${value.toFixed(1)}%)`);
          else if(cfg.stopLossPct&&value<=-cfg.stopLossPct)await sellPosition(mint,1,`stop-loss hit (${value.toFixed(1)}%)`);
        }).finally(()=>exitQueued.delete(key)).catch(()=>{});
      }
      return;
    }
    if(!(cfg.takeProfitPct||cfg.stopLossPct))return;
    checking = true;
    try {
      for (const [mint, pos] of positions.entries()) {
        try {
          if(pos.pendingBuy||pos.pendingSell||pos.queuedExit||pos.queuedSourceExit||pos.copiedExit)continue;
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
      (logs, context) => {
        if (logs.err) return;
        if (!looksLikeSwap(logs.logs)) {
          ignored++;
          return;
        }
        const seenAt = Date.now();
        handleSignature(w, logs.signature, seenAt, logs.logs, context?.slot).catch((e) => log(`Error handling ${short(logs.signature)}: ${e.message}`));
      },
      'processed', // the earliest the network reports a trade: about half a second before "confirmed"
    );
    subscriptions.set(w.address, id);
    log(`Watching ${w.label} (${w.address})${w.retiring ? ', for sells only' : ''}`);
  }

  let disconnectedAt=0,catchingUp=false;
  async function catchUpSources(since){
    if(catchingUp)return;catchingUp=true;
    try{for(const w of [...cfg.wallets]){
      if(w.paused&&!holdingFrom(w.address))continue;
      try{
        const reader=priceConnection??connection;
        const rows=(await reader.getSignaturesForAddress(new PublicKey(w.address),{limit:100})).filter(x=>!x.err&&x.blockTime!=null&&x.blockTime*1000>=since-2000);
        // Reserve source order oldest first, then resolve newest exits before any older catch-up entry.
        const ordered=[...rows].reverse().map(x=>({row:x,order:{seenAt:(x.blockTime??0)*1000,slot:x.slot,sequence:++sourceSequence,session}}));
        for(const {row,order}of ordered.reverse()){
          if(seen.has(`${w.address}:${row.signature}`))continue;
          decision(w,null,'Rechecking','Live connection returned; checking the source trades from the gap');
          await handleSignature(w,row.signature,order.seenAt,null,row.slot,order);
        }
      }catch(e){decision(w,null,'Waiting','Could not recheck source trades after reconnect; check the live feed');}
    }}finally{catchingUp=false;}
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
    // The pinned web3 client reconnects its socket automatically but does not replay missed logs.
    connection._rpcWebSocket?.on?.('close',()=>{disconnectedAt=Date.now();});
    connection._rpcWebSocket?.on?.('open',()=>{if(disconnectedAt){const since=disconnectedAt;disconnectedAt=0;void catchUpSources(since);}});
    for (const w of [...cfg.wallets]) {
      if (w.retiring && !holdingFrom(w.address)) dropWallet(w);
      else watch(w);
    }
    // Always scheduled, so take-profit / stop-loss can be switched on while SolBoy is running.
    setInterval(checkExits, cfg.priceCheckSeconds * 1000);
    setInterval(()=>{void checkExits(true);},250).unref?.();
    prices?.subscribe(()=>{void checkExits();});
    prices?.start();
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
    copyActivity:()=>[...activity].reverse(),
    checkExits,
    setBuyingPaused(value) {
      buyingPaused = value;
      log(value ? 'Copying PAUSED. Sells still follow the copied wallets.' : 'Copying RESUMED.');
    },
    isBuyingPaused: () => buyingPaused,
    copySpeed: () => {
      if (!speeds.length) return null;
      const last = speeds.at(-1), confirmed = speeds.filter(s => s.confirmed != null);
      return { last: last.sent, avg: speeds.reduce((a, b) => a + b.sent, 0) / speeds.length, n: speeds.length,
        side: last.side, paper: last.paper, confirmed: last.confirmed, complete: last.complete,
        confirmedAvg: confirmed.length ? confirmed.reduce((a, b) => a + b.confirmed, 0) / confirmed.length : null };
    },
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
    sellNow(mint) {
      if (manualSells.has(mint)) return manualSells.get(mint);
      const task = withLock(mint, () => sellPosition(mint, 1, 'sold by you from the dashboard', null, true));
      manualSells.set(mint, task);
      task.finally(() => { if (manualSells.get(mint) === task) manualSells.delete(mint); }).catch(() => {});
      return task;
    },
    valueOf,
    priceOf:(mint,pos)=>prices?.get(mint,pos)??null,
    onPrices:fn=>prices?.subscribe(fn)??(()=>{}),
    addWallet,
    removeWallet,
  };
}
