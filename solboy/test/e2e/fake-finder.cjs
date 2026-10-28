// A small fixed piece of fake chain for the Wallet Finder tests: two coins that ran, the wallets that bought
// them early (a smart trader, its sibling wallet funded by the same wallet, a loser, the dev), and the smart
// trader's own history over the last month (so its PnL calendar has green and red days).
const { createRequire } = require('module');
const req = createRequire(require('path').join(__dirname, '../../package.json'));
const web3 = req('@solana/web3.js'); const bs58 = req('bs58');
const pk = () => web3.Keypair.generate().publicKey.toBase58();
const sigOf = () => bs58.encode(require('crypto').randomBytes(64));
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const NOW = Math.floor(Date.now() / 1000), DAY = 86400;

const A = { COIN_A: pk(), COIN_B: pk(), SMART: pk(), SIB: pk(), LOSER: pk(), DEV: pk(), FUNDER: pk() };
const OTHER = Array.from({ length: 5 }, () => pk());
const TX = new Map(); // sig -> record
const BY = new Map(); // address -> [sig] (any order; sorted on read)
const HOLD = new Map(); // owner -> Map(mint -> tokens)
const COINS = new Map([[A.COIN_A, { symbol: 'RUNA', name: 'Runner A', price: 4e-7 }], [A.COIN_B, { symbol: 'RUNB', name: 'Runner B', price: 6e-7 }],
  ...OTHER.map((m, i) => [m, { symbol: `OTH${i + 1}`, name: `Other ${i + 1}`, price: 1e-7 }])]);
const tok = new Map(); // owner+mint -> tokens held, to fill pre/post balances
let slot = 5000;
const link = (addr, sig) => { if (!BY.has(addr)) BY.set(addr, []); BY.get(addr).push(sig); };
function trade(payer, mint, buy, sol, tokens, time, s = slot++) {
  const k = payer + mint, pre = tok.get(k) ?? 0, post = buy ? pre + tokens : pre - tokens;
  tok.set(k, post);
  const sig = sigOf();
  TX.set(sig, { kind: 't', payer, mint, buy, sol, pre, post, time, slot: s });
  link(payer, sig); link(mint, sig);
  return sig;
}
function xfer(from, to, sol, time) {
  const sig = sigOf();
  TX.set(sig, { kind: 'x', from, to, sol, time, slot: slot++ });
  link(from, sig); link(to, sig);
}

// funding, 30 days ago: one wallet pays both the smart trader and its sibling
xfer(A.FUNDER, A.SMART, 5, NOW - 30 * DAY);
xfer(A.FUNDER, A.SIB, 4, NOW - 30 * DAY + 60);
// coin A, 10 days ago: dev launches, the sibling and the smart wallet snipe in the same block, a loser buys high
const tA = NOW - 10 * DAY;
trade(A.DEV, A.COIN_A, true, 1, 30e6, tA, 5100);
trade(A.SIB, A.COIN_A, true, 0.5, 10e6, tA, 5102);
trade(A.SMART, A.COIN_A, true, 0.5, 10e6, tA + 1, 5102);
slot = 5200;
trade(A.LOSER, A.COIN_A, true, 2, 5e6, tA + 600);
trade(A.SMART, A.COIN_A, false, 3, 10e6, tA + 3600);
trade(A.SIB, A.COIN_A, false, 2.8, 10e6, tA + 3700);
trade(A.LOSER, A.COIN_A, false, 0.5, 5e6, tA + 7200);
// coin B, 6 days ago: same two wallets in the same block again; the smart one still holds half
const tB = NOW - 6 * DAY;
slot = 8000;
trade(A.DEV, A.COIN_B, true, 1, 30e6, tB, 8000);
trade(A.SIB, A.COIN_B, true, 0.4, 8e6, tB, 8002);
trade(A.SMART, A.COIN_B, true, 0.4, 8e6, tB + 1, 8002);
slot = 8100;
trade(A.SMART, A.COIN_B, false, 1.5, 4e6, tB + 5400);
// the smart wallet's other trades: 4 wins and 1 loss on different days
slot = 9000;
[[OTHER[0], 20, 0.5, 1.2], [OTHER[1], 15, 0.5, 0.2], [OTHER[2], 4, 0.3, 0.9], [OTHER[3], 2, 0.3, 0.6], [OTHER[4], 1, 0.2, 0.5]].forEach(([m, d, cost, back]) => {
  trade(A.SMART, m, true, cost, 5e6, NOW - d * DAY);
  trade(A.SMART, m, false, back, 5e6, NOW - d * DAY + 1800);
});
// it also sends its sibling some SOL directly
xfer(A.SMART, A.SIB, 1, NOW - 3 * DAY);
for (const [sig, t] of TX) if (t.kind === 't') { const m = HOLD.get(t.payer) ?? new Map(); m.set(t.mint, tok.get(t.payer + t.mint)); HOLD.set(t.payer, m); }

const ok = (value) => ({ context: { slot: 1 }, value });
const tb = (owner, mint, amt) => ({ accountIndex: 1, mint, owner, programId: TOKEN, uiTokenAmount: { amount: String(Math.round(amt * 1e6)), decimals: 6, uiAmount: amt, uiAmountString: String(amt) } });
function parsedTx(sig) {
  const t = TX.get(sig);
  if (t.kind === 'x') {
    return { slot: t.slot, blockTime: t.time, version: 0, transaction: { signatures: [sig], message: { accountKeys: [{ pubkey: t.from, signer: true, writable: true, source: 'transaction' }, { pubkey: t.to, signer: false, writable: true, source: 'transaction' }],
      instructions: [{ program: 'system', programId: '11111111111111111111111111111111', parsed: { type: 'transfer', info: { source: t.from, destination: t.to, lamports: Math.round(t.sol * 1e9) } }, stackHeight: null }], recentBlockhash: '11111111111111111111111111111111' } },
      meta: { err: null, fee: 5000, preBalances: [20e9, 1e9], postBalances: [20e9 - t.sol * 1e9 - 5000, 1e9 + t.sol * 1e9], innerInstructions: [], logMessages: [], preTokenBalances: [], postTokenBalances: [], status: { Ok: null } } };
  }
  const lam = Math.round(t.sol * 1e9), pre = 20e9;
  return { slot: t.slot, blockTime: t.time, version: 0, transaction: { signatures: [sig], message: { accountKeys: [{ pubkey: t.payer, signer: true, writable: true, source: 'transaction' }, { pubkey: t.mint, signer: false, writable: false, source: 'transaction' }], instructions: [], recentBlockhash: '11111111111111111111111111111111' } },
    meta: { err: null, fee: 5000, preBalances: [pre, 0], postBalances: [t.buy ? pre - lam - 5000 : pre + lam - 5000, 0], innerInstructions: [], logMessages: [],
      preTokenBalances: t.pre ? [tb(t.payer, t.mint, t.pre)] : [], postTokenBalances: [tb(t.payer, t.mint, t.post)], status: { Ok: null } } };
}
function sigList(addr, opts = {}) {
  let list = (BY.get(addr) ?? []).map((s) => ({ s, t: TX.get(s) })).sort((a, b) => b.t.slot - a.t.slot || b.t.time - a.t.time);
  if (opts.before) { const i = list.findIndex((x) => x.s === opts.before); if (i >= 0) list = list.slice(i + 1); }
  if (opts.until) { const i = list.findIndex((x) => x.s === opts.until); if (i >= 0) list = list.slice(0, i); }
  return list.slice(0, opts.limit ?? 1000).map(({ s, t }) => ({ signature: s, slot: t.slot, err: null, memo: null, blockTime: t.time, confirmationStatus: 'finalized' }));
}
const known = (a) => BY.has(a) || COINS.has(a);
// token accounts (ATAs) of every holder, so a holdings lookup by account address works
const ATA = new Map();
const ATA_PROGRAM = new web3.PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWAN6qDZTWnPC9DH');
for (const [owner, m] of HOLD) for (const [mint, n] of m) {
  const key = web3.PublicKey.findProgramAddressSync([new web3.PublicKey(owner).toBuffer(), new web3.PublicKey(TOKEN).toBuffer(), new web3.PublicKey(mint).toBuffer()], ATA_PROGRAM)[0].toBase58();
  ATA.set(key, { owner, mint, n });
}
const S = { fastHistory: true, fastCalls: 0 };

/** Answer an RPC call if it's about the finder's fake world; undefined otherwise. */
function rpc(method, params) {
  const a = params?.[0];
  if (method === 'getTransaction' && TX.has(a)) return parsedTx(a);
  if (method === 'getMultipleAccounts' && Array.isArray(a) && a.some((k) => ATA.has(k))) return ok(a.map((k) => {
    const x = ATA.get(k); if (!x || x.n <= 0) return null;
    const d = Buffer.alloc(165); new web3.PublicKey(x.mint).toBuffer().copy(d, 0); new web3.PublicKey(x.owner).toBuffer().copy(d, 32); d.writeBigUInt64LE(BigInt(Math.round(x.n * 1e6)), 64); d[108] = 1;
    return { data: [d.toString('base64'), 'base64'], executable: false, lamports: 2039280, owner: TOKEN, rentEpoch: 0, space: 165 };
  }));
  if (method === 'getTransactionsForAddress' && COINS.has(a)) {
    S.fastCalls++;
    if (!S.fastHistory) throw new Error('getTransactionsForAddress is only available on paid plans');
    return { data: sigList(a, { limit: 100000 }).reverse().map((x) => parsedTx(x.signature)), paginationToken: null };
  }
  if (!known(a)) return undefined;
  switch (method) {
    case 'getSignaturesForAddress': return sigList(a, params[1]);
    case 'getAccountInfo': return ok(COINS.has(a) ? { data: [Buffer.alloc(82).toString('base64'), 'base64'], executable: false, lamports: 1461600, owner: TOKEN, rentEpoch: 0, space: 82 } : null);
    case 'getBalance': return ok(a === A.SMART ? 12.5e9 : 1e9);
    case 'getTokenAccountsByOwner': {
      const filter = params[1] ?? {}, held = [...(HOLD.get(a) ?? new Map())].filter(([m, n]) => n > 0 && (!filter.mint || filter.mint === m) && filter.programId !== 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCCEpPxuEb');
      return ok(held.map(([m, n]) => ({ pubkey: pk(), account: { data: { program: 'spl-token', parsed: { type: 'account', info: { mint: m, owner: a, isNative: false, state: 'initialized', tokenAmount: { amount: String(Math.round(n * 1e6)), decimals: 6, uiAmount: n, uiAmountString: String(n) } } }, space: 165 }, executable: false, lamports: 2039280, owner: TOKEN, rentEpoch: 0, space: 165 } })));
    }
    default: return undefined;
  }
}
/** DexScreener pairs for the finder's coins named in a /tokens/v1 path, or null. */
function dex(p) {
  if (!p.startsWith('/tokens/v1/solana/')) return null;
  const list = p.slice('/tokens/v1/solana/'.length).split(',').filter((m) => COINS.has(m));
  if (!list.length) return null;
  return list.map((m) => { const c = COINS.get(m); return { chainId: 'solana', dexId: 'pumpswap', pairAddress: pk(), baseToken: { address: m, name: c.name, symbol: c.symbol }, priceNative: String(c.price), priceUsd: String(c.price * 150), marketCap: c.price * 1e9 * 150, liquidity: { usd: 20000 } }; });
}
module.exports = { A, S, rpc, dex };
