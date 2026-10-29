import { PublicKey } from '@solana/web3.js';

export const WSOL = 'So11111111111111111111111111111111111111112';

// Tokens treated as "money" rather than something being bought.
const QUOTE_MINTS = new Set([
  WSOL,
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

// Ignore SOL movements smaller than this (0.001 SOL) so plain token transfers aren't read as trades.
const MIN_SOL_MOVE = 1_000_000n;

/**
 * Work out what `wallet` bought or sold for SOL in a parsed transaction.
 * Works for any exchange (Pump.fun, PumpSwap, Raydium, Jupiter...) because it only looks at
 * how the wallet's balances changed. Returns [] for anything that isn't a SOL <-> token swap.
 */
export function parseTrades(tx, wallet, extraQuotes = []) {
  if (!tx?.meta || tx.meta.err) return [];
  const { meta } = tx;

  // Account list: the message's keys, plus any loaded from lookup tables if the RPC lists those separately.
  const msg = tx.transaction?.message ?? {};
  const keys = (msg.accountKeys ?? msg.staticAccountKeys ?? []).map((k) => (k.pubkey ?? k).toString());
  if (keys.length < meta.preBalances.length && meta.loadedAddresses) keys.push(...(meta.loadedAddresses.writable ?? []), ...(meta.loadedAddresses.readonly ?? []));
  const idx = keys.indexOf(wallet);
  let solDelta = 0n;
  if (idx >= 0) {
    solDelta = BigInt(meta.postBalances[idx]) - BigInt(meta.preBalances[idx]);
    if (idx === 0) solDelta += BigInt(meta.fee); // don't count the network fee as SOL spent on the token
  }

  const tokens = new Map();
  const add = (list, field) => {
    for (const b of list ?? []) {
      if (b.owner !== wallet) continue;
      const t = tokens.get(b.mint) ?? { pre: 0n, post: 0n, decimals: b.uiTokenAmount.decimals };
      t[field] += BigInt(b.uiTokenAmount.amount);
      tokens.set(b.mint, t);
    }
  };
  add(meta.preTokenBalances, 'pre');
  add(meta.postTokenBalances, 'post');

  // Wrapped SOL counts as SOL.
  const wsol = tokens.get(WSOL);
  if (wsol) solDelta += wsol.post - wsol.pre;

  if (solDelta > -MIN_SOL_MOVE && solDelta < MIN_SOL_MOVE) return [];

  const trades = [];
  for (const [mint, t] of tokens) {
    if (QUOTE_MINTS.has(mint) || extraQuotes.includes(mint)) continue;
    const delta = t.post - t.pre;
    if (delta > 0n && solDelta < 0n) {
      trades.push({ side: 'buy', mint, solAmount: Number(-solDelta) / 1e9, tokenAmount: delta, heldBefore: t.pre * 10n > delta }); // dust left from an old trade doesn't count
    } else if (delta < 0n && solDelta > 0n) {
      const fractionSold = t.pre > 0n ? Math.min(1, Number(-delta) / Number(t.pre)) : 1;
      trades.push({ side: 'sell', mint, solAmount: Number(solDelta) / 1e9, tokenAmount: -delta, fractionSold });
    }
  }
  return trades;
}

// Exchanges and routers whose programs show up in a swap's logs, even when a trading bot calls them indirectly.
const DEX_PROGRAMS = [
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', // Pump.fun
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', // PumpSwap
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', // Raydium CPMM
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Raydium CLMM
  'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj', // Raydium LaunchLab
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // Jupiter
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', // Orca
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', // Meteora DLMM
  'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB', // Meteora pools
  'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG', // Meteora DAMM v2
  'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN', // Meteora bonding curve
  'MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG', // Moonshot
];
const SWAP_LOG = /Instruction: (Buy|Sell|Swap|\w*Route)|ray_log|Log truncated/i;

/**
 * Cheap check on a transaction's log lines (which arrive with the notification, before any download)
 * so transfers, spam airdrops and other non-trades are ignored without spending RPC requests.
 */
export function looksLikeSwap(lines = []) {
  return lines.some((line) => SWAP_LOG.test(line) || DEX_PROGRAMS.some((p) => line.includes(p)));
}

// Pump.fun writes every trade into the transaction's logs as an event ("Program data: ..."): the coin, the SOL and
// token amounts, buy or sell, and the trader. Reading it there needs no download, so a copy can start the moment the
// notification arrives. Layout: 8-byte event id, mint (32), sol (u64), tokens (u64), is_buy (u8), user (32), ...
const PUMP_TRADE_EVENT = Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]); // sha256("event:TradeEvent")[0..8]

/** Pump.fun trades made by `wallet`, straight from a notification's log lines. [] when there are none. */
export function pumpTradesFromLogs(lines = [], wallet) {
  const byKey = new Map(), stack=[];
  const pump='6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
  for (const line of lines) {
    const invoke=line.match(/^Program (\w+) invoke \[\d+\]/);if(invoke){stack.push(invoke[1]);continue;}
    const done=line.match(/^Program (\w+) (?:success|failed:)/);if(done){const index=stack.lastIndexOf(done[1]);if(index>=0)stack.length=index;continue;}
    if (!line.startsWith('Program data: ')||stack.at(-1)!==pump) continue;
    const b = Buffer.from(line.slice(14), 'base64');
    if (b.length < 89 || !b.subarray(0, 8).equals(PUMP_TRADE_EVENT)) continue;
    let mint, user;
    try {
      mint = new PublicKey(b.subarray(8, 40)).toBase58();
      user = new PublicKey(b.subarray(57, 89)).toBase58();
    } catch {
      continue;
    }
    if (user !== wallet) continue; // only the watched wallet's own trades (also guards against a misread event)
    const sol = b.readBigUInt64LE(40);
    const tokens = b.readBigUInt64LE(48);
    const side = b[56] === 1 ? 'buy' : b[56] === 0 ? 'sell' : null;
    let quoteMint=null;
    if(b.length>=262){
      const size=b.readUInt32LE(258),end=262+size;
      if(size>100||end+37>b.length)continue;
      const shareholders=b.readUInt32LE(end+33),offset=end+37+shareholders*34;
      if(shareholders>100||offset+56>b.length)continue;
      quoteMint=new PublicKey(b.subarray(offset,offset+32)).toBase58();
    }
    const nonSol=quoteMint&&quoteMint!==PublicKey.default.toBase58()&&quoteMint!==WSOL;
    if (!side || (!nonSol&&sol === 0n) || tokens === 0n || sol > 100_000n * 1_000_000_000n) continue;
    const k = `${side}:${mint}`;
    const t = byKey.get(k) ?? { side, mint, solAmount: 0, tokenAmount: 0n, fast: true };
    if(nonSol){t.requiresReceipt=true;t.quoteMint=quoteMint;}
    t.solAmount += Number(sol) / 1e9;
    t.tokenAmount += tokens;
    // the bonding curve right after the trade (timestamp i64 at 89, then virtual SOL and virtual tokens)
    if (!nonSol&&b.length >= 113) {
      const vSol = Number(b.readBigUInt64LE(97)) / 1e9, vTokens = Number(b.readBigUInt64LE(105)) / 1e6;
      if (vSol > 0 && vTokens > 0) t.curve = { vSol, vTokens };
    }
    byKey.set(k, t);
  }
  return [...byKey.values()];
}
