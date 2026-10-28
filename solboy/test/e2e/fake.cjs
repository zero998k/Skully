// Fake world for end-to-end tests of the packaged SolBoy: Solana RPC + websocket, Jupiter (quote AND real
// signed-able swap transactions), DexScreener, Pump.fun, X embeds, IPFS metadata, a website, and Groq.
const http = require('http');
const { createRequire } = require('module');
const req = createRequire(require('path').join(__dirname, '../../package.json'));
const WS = req('ws'); const WebSocketServer = WS.WebSocketServer || WS.Server;
const web3 = req('@solana/web3.js'); const bs58 = req('bs58');
const WHALE = 'AqzPs1UDhnK2Ga37PphobfMukGtN53erw5N3KhoR6qky';
const MINT = 'CkVfySiwbXr8uosL9W9vtuiKSSd4WqhvBr2YjyQKv8u3';
const DEV = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const S = { groq413: 1, groqdown: 0, apidown: 0, release: 0, corrupt: 0, mult: 1, balanceLamports: 0, held: 0n, sent: [], groq: [], swaps: [], log: [] };
// ---- fake Pump.fun world for Pulse (PumpPortal-style feed) ----
const P0 = Date.now(); const slotNow = () => 1000 + Math.floor((Date.now() - P0) / 400);
const P = { chainTx: new Map(), coins: new Map(), names: new Map(), accts: new Map(), funds: new Map(), fundSigs: new Map(), clients: new Set(), noroute: new Set(), vaults: new Map() };
P.seed = web3.Keypair.generate().publicKey.toBase58(); P.grad = web3.Keypair.generate().publicKey.toBase58();
const pk = () => web3.Keypair.generate().publicKey.toBase58();
const who = (name) => { if (!P.names.has(name)) P.names.set(name, pk()); return P.names.get(name); };
const acctFor = (mint, owner) => { const k = mint + owner; if (!P.accts.has(k)) { const a = pk(); P.accts.set(k, a); P.accts.set(a, owner); } return P.accts.get(k); };
const ppSend = (msg, filter) => { let n = 0; for (const c of P.clients) if (c.ws.readyState === 1 && filter(c)) { c.ws.send(JSON.stringify(msg)); n++; } return n; };
function ppCurveBuy(c, solIn) { const k = c.vSol * c.vTokens; const out = c.vTokens - k / (c.vSol + solIn); c.vSol += solIn; c.vTokens -= out; return out; }
function ppCurveSell(c, tok) { const k = c.vSol * c.vTokens; const out = c.vSol - k / (c.vTokens + tok); c.vTokens += tok; c.vSol -= out; return out; }
const ppState = (c) => ({ bondingCurveKey: c.curve, vTokensInBondingCurve: c.vTokens, vSolInBondingCurve: c.vSol, marketCapSol: (c.vSol / c.vTokens) * 1e9 });
const txs = {}; const subs = new Map(); let nextSub = 1; let n = 0;
const MINT2 = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const tb = (amt, mint = MINT) => ({ accountIndex: 1, mint, owner: WHALE, uiTokenAmount: { amount: String(amt), decimals: 6, uiAmount: amt / 1e6 } });
function makeTx(side, frac = 1, held = 0, mint = MINT) {
  const sig = bs58.encode(Buffer.from(require('crypto').randomBytes(64)));
  const buy = side === 'buy';
  const pre = buy ? Math.round(held * 1e6) : 1e6, post = buy ? pre + 1e6 : Math.round(1e6 * (1 - frac));
  txs[sig] = { slot: 1, blockTime: Math.floor(Date.now() / 1000), transaction: { signatures: [sig], message: { accountKeys: [{ pubkey: WHALE, signer: true, writable: true }, { pubkey: mint, signer: false, writable: false }], instructions: [], recentBlockhash: '11111111111111111111111111111111' } },
    meta: { err: null, fee: 5000, preBalances: [5e9, 0], postBalances: [buy ? 5e9 - 5e8 - 5000 : 5e9 + 6e8 * frac - 5000, 0], preTokenBalances: pre ? [tb(pre, mint)] : [], postTokenBalances: [tb(post, mint)], innerInstructions: [], logMessages: [] } };
  return sig;
}
const ok = (value) => ({ context: { slot: 1 }, value });
// an SPL token account (165 bytes) with the amount at byte 64, as the RPC sends it in base64
function vaultAcct(c, key) { const d = Buffer.alloc(165); new web3.PublicKey(key === c.vaultQuote ? 'So11111111111111111111111111111111111111112' : c.mint).toBuffer().copy(d, 0); new web3.PublicKey(c.pair).toBuffer().copy(d, 32);
  d.writeBigUInt64LE(BigInt(Math.round(key === c.vaultQuote ? c.ammQuote * 1e9 : c.ammBase * 1e6)), 64); d[108] = 1;
  return { data: [d.toString('base64'), 'base64'], executable: false, lamports: 2039280, owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', rentEpoch: 0, space: 165 }; }
function rpc(method, params) {
  switch (method) {
    case 'getSlot': return 123;
    case 'getBlockHeight': return 50;
    case 'getBalance': return ok(S.balanceLamports);
    case 'getTransaction': {
      if (P.chainTx.has(params[0])) { const x = P.chainTx.get(params[0]); const tb2 = (amt) => ({ accountIndex: 1, mint: x.mint, owner: x.owner, programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', uiTokenAmount: { amount: String(Math.round(amt * 1e6)), decimals: 6, uiAmount: amt, uiAmountString: String(amt) } });
        return { slot: x.slot, blockTime: Math.floor(Date.now() / 1000), version: 0, transaction: { signatures: [params[0]], message: { accountKeys: [{ pubkey: x.owner, signer: true, writable: true, source: 'transaction' }, { pubkey: x.mint, signer: false, writable: false, source: 'transaction' }], instructions: [], recentBlockhash: '11111111111111111111111111111111' } }, meta: { err: null, fee: 5000, preBalances: [1e9, 0], postBalances: [1e9, 0], innerInstructions: [], logMessages: [], preTokenBalances: x.pre ? [tb2(x.pre)] : [], postTokenBalances: [tb2(x.post)], status: { Ok: null } } }; }
      if (P.fundSigs.has(params[0])) { const f = P.fundSigs.get(params[0]); return { slot: 1, blockTime: Math.floor(Date.now() / 1000) - 3600, version: 0, transaction: { signatures: [params[0]], message: { accountKeys: [{ pubkey: f.from, signer: true, writable: true, source: 'transaction' }, { pubkey: f.to, signer: false, writable: true, source: 'transaction' }], instructions: [{ program: 'system', programId: '11111111111111111111111111111111', parsed: { type: 'transfer', info: { source: f.from, destination: f.to, lamports: 100000000 } }, stackHeight: null }], recentBlockhash: '11111111111111111111111111111111' } }, meta: { err: null, fee: 5000, preBalances: [2e9, 0], postBalances: [1.9e9, 1e8], innerInstructions: [], logMessages: [], preTokenBalances: [], postTokenBalances: [], status: { Ok: null } } }; }
      if (!(params[1]?.maxSupportedTransactionVersion >= 1)) throw new Error('Transaction version (1) is not supported by the requesting client.');
      return txs[params[0]] ? { ...txs[params[0]], version: 1 } : null;
    }
    case 'getAccountInfo': return ok({ data: { parsed: { info: { mintAuthority: null, freezeAuthority: null, decimals: 6, supply: '1000000000000', isInitialized: true }, type: 'mint' }, program: 'spl-token', space: 82 }, executable: false, lamports: 1, owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', rentEpoch: 0 });
    case 'getLatestBlockhash': return ok({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 100 });
    case 'getAsset': return { content: { json_uri: 'http://127.0.0.1:18903/ipfs/QmFakeMeta', metadata: { name: 'SolBoy Cat', symbol: 'BOYZ', description: '' }, links: {} } };
    case 'getSignaturesForAddress': { if (P.coins.has(params[0])) return [...P.coins.get(params[0]).sigs].reverse().map((x) => ({ ...x, err: null, memo: null, blockTime: Math.floor(Date.now() / 1000), confirmationStatus: 'confirmed' }));
      const f = P.funds.get(params[0]); if (!f) return []; return [{ signature: f, slot: 1, err: null, memo: null, blockTime: Math.floor(Date.now() / 1000) - 3600, confirmationStatus: 'finalized' }]; }
    case 'getMultipleAccounts': return ok(params[0].map((a) => ({ data: { program: 'spl-token', parsed: { type: 'account', info: { owner: P.accts.get(a) ?? a, mint: 'x', tokenAmount: { amount: '1', decimals: 6, uiAmount: 0.000001, uiAmountString: '0.000001' } } }, space: 165 }, executable: false, lamports: 2039280, owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', rentEpoch: 0, space: 165 })));
    case 'getTokenLargestAccounts': if (P.coins.has(params[0])) { const c = P.coins.get(params[0]); const list = [[c.curve, Math.max(0, c.vTokens - 279900191)], ...c.bal].filter(([, b]) => b > 0).sort((a, b) => b[1] - a[1]).slice(0, 20);
      return ok(list.map(([owner, b]) => ({ address: acctFor(params[0], owner), amount: String(Math.round(b * 1e6)), decimals: 6, uiAmount: b, uiAmountString: String(b) }))); }
      return ok([{ address: DEV, amount: '600000000', decimals: 6, uiAmount: 600, uiAmountString: '600' }, { address: WHALE, amount: '100000000', decimals: 6, uiAmount: 100, uiAmountString: '100' }]);
    case 'getTokenSupply': if (P.coins.has(params[0])) return ok({ amount: '1000000000000000', decimals: 6, uiAmount: 1e9, uiAmountString: '1000000000' });
      return ok({ amount: '1000000000', decimals: 6, uiAmount: 1000, uiAmountString: '1000' });
    case 'getTokenAccountsByOwner': { const c = [...P.coins.values()].find((x) => x.pair && x.pair === params[0]); if (c) { const quote = params[1]?.mint?.startsWith('So111'); const key = quote ? c.vaultQuote : c.vaultBase; return ok([{ pubkey: key, account: vaultAcct(c, key) }]); } }
      if (params[2]?.encoding === 'base64') return ok([]); // a pool SolBoy guessed that isn't on this fake chain
      return ok(S.held > 0n ? [{ pubkey: DEV, account: { data: { program: 'spl-token', parsed: { type: 'account', info: { mint: MINT, owner: params[0], tokenAmount: { amount: S.held.toString(), decimals: 6, uiAmount: Number(S.held) / 1e6, uiAmountString: String(Number(S.held) / 1e6) } } }, space: 165 }, executable: false, lamports: 2039280, owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', rentEpoch: 0, space: 165 } }] : []);
    case 'sendTransaction': {
      const raw = Buffer.from(params[0], 'base64'); const sig = bs58.encode(raw.subarray(1, 65));
      // A plain SOL transfer (withdraw): take the amount off the balance.
      try { const t = web3.Transaction.from(raw); const ix = t.instructions[0]; if (ix.programId.equals(web3.SystemProgram.programId)) { const lam = Number(ix.data.readBigUInt64LE(4)); S.balanceLamports -= lam + 5000; S.sent.push({ kind: 'transfer', to: ix.keys[1].pubkey.toBase58(), lamports: lam, sig }); return sig; } } catch {}
      S.sent.push({ kind: 'swap', sig }); return sig;
    }
    case 'getBlockTime': return Math.floor(Date.now() / 1000) - 1; // the fake feed runs about a second behind
    case 'getSignatureStatuses': return ok(params[0].map(() => ({ slot: 1, confirmations: null, err: null, confirmationStatus: 'confirmed' })));
    default: S.log.push('unhandled ' + method); return null;
  }
}
const json = (res, x) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(x)); };
const body = (r) => new Promise((ok) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => ok(b)); });
const mainHttp = http.createServer(async (r, res) => { const b = await body(r); const u = new URL(r.url, 'http://x');
  if (u.pathname === '/emit') { const side = u.searchParams.get('side'); const sig = makeTx(side, Number(u.searchParams.get('frac') ?? 1), Number(u.searchParams.get('held') ?? 0), u.searchParams.get('mint') === '2' ? MINT2 : MINT);
    for (const [id, s] of subs) if (s.ws.readyState === 1 && s.kind === 'logs') s.ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'logsNotification', params: { result: { context: { slot: 1 }, value: { signature: sig, err: null, logs: ['Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [1]', `Program log: Instruction: ${side === 'buy' ? 'Buy' : 'Sell'}`] } }, subscription: id } }));
    return json(res, { sig, subs: [...subs.values()].filter((s) => s.kind === 'logs').length }); }
  if (u.pathname === '/set') { for (const k of ['release', 'corrupt', 'apidown', 'groq413', 'groqdown']) if (u.searchParams.has(k)) S[k] = Number(u.searchParams.get(k)); if (u.searchParams.has('mult')) S.mult = Number(u.searchParams.get('mult')); if (u.searchParams.has('sol')) S.balanceLamports = Math.round(Number(u.searchParams.get('sol')) * 1e9); return json(res, { ok: true }); }
  if (u.pathname === '/state') return json(res, { ...S, held: S.held.toString() });
  if (u.pathname === '/pp/create') { const q = Object.fromEntries(u.searchParams); const mint = pk(); const dev = who(q.dev || 'dev1');
    const c = { mint, name: q.name, symbol: q.symbol, curve: pk(), vSol: 30, vTokens: 1073000191, bal: new Map(), creator: dev }; P.coins.set(mint, c);
    const initial = Number(q.initial ?? 0); const got = initial ? ppCurveBuy(c, initial) : 0; if (got) c.bal.set(dev, got);
    c.sigs = []; const csig = bs58.encode(require('crypto').randomBytes(64)); c.launchSlot = slotNow(); c.sigs.push({ signature: csig, slot: c.launchSlot }); P.chainTx.set(csig, { mint, owner: dev, pre: 0, post: got, slot: c.launchSlot });
    const n = ppSend({ signature: csig, mint, traderPublicKey: dev, txType: 'create', initialBuy: got, solAmount: initial, ...ppState(c), name: q.name, symbol: q.symbol, uri: `http://127.0.0.1:18903/meta/${q.symbol}`, pool: 'pump' }, (cl) => cl.newToken);
    return json(res, { mint, delivered: n }); }
  if (u.pathname === '/pp/trade') { const q = Object.fromEntries(u.searchParams); const c = P.coins.get(q.mint); const w = who(q.wallet); const buy = q.side !== 'sell';
    const pre = c.bal.get(w) ?? 0;
    let tok, sol; if (buy) { sol = Number(q.sol); tok = ppCurveBuy(c, sol); c.bal.set(w, (c.bal.get(w) ?? 0) + tok); } else { tok = (c.bal.get(w) ?? 0) * Number(q.pct ?? 100) / 100; sol = ppCurveSell(c, tok); c.bal.set(w, (c.bal.get(w) ?? 0) - tok); }
    const tsig = bs58.encode(require('crypto').randomBytes(64)); const tslot = q.bundle ? c.launchSlot : slotNow(); c.sigs.push({ signature: tsig, slot: tslot }); P.chainTx.set(tsig, { mint: q.mint, owner: w, pre, post: c.bal.get(w), slot: tslot });
    if (q.hidden) return json(res, { delivered: 0, wallet: w, hidden: true });
    const n = ppSend({ signature: tsig, mint: q.mint, traderPublicKey: w, txType: buy ? 'buy' : 'sell', tokenAmount: tok, solAmount: sol, newTokenBalance: c.bal.get(w), ...ppState(c), pool: 'pump' }, (cl) => cl.keys.has(q.mint));
    return json(res, { delivered: n, wallet: w, mc: ppState(c).marketCapSol }); }
  if (u.pathname === '/pp/migrate') { const c = P.coins.get(u.searchParams.get('mint')); c.migrated = true; c.pair = pk(); c.vaultBase = pk(); c.vaultQuote = pk(); c.ammBase = 200e6; c.ammQuote = 80; P.vaults.set(c.vaultBase, c); P.vaults.set(c.vaultQuote, c); return json(res, { delivered: ppSend({ signature: pk(), mint: c.mint, txType: 'migrate', pool: 'pump-amm' }, (cl) => cl.migration) }); }
  if (u.pathname === '/pp/amm') { const c = P.coins.get(u.searchParams.get('mint')); const sol = Number(u.searchParams.get('sol')); const buy = u.searchParams.get('side') !== 'sell';
    const k = c.ammBase * c.ammQuote; if (buy) { c.ammQuote += sol; c.ammBase = k / c.ammQuote; } else { c.ammQuote -= sol; c.ammBase = k / c.ammQuote; }
    const slot = slotNow(); let sent = 0;
    for (const [id, s2] of subs) if (s2.kind === 'account' && s2.ws.readyState === 1 && (s2.key === c.vaultBase || s2.key === c.vaultQuote)) { sent++;
      s2.ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'accountNotification', params: { result: { context: { slot }, value: vaultAcct(c, s2.key) }, subscription: id } })); }
    return json(res, { sent, mcSol: (c.ammQuote / c.ammBase) * 1e9 }); }
  if (u.pathname === '/pp/fund') { const to = who(u.searchParams.get('holder')); const from = who(u.searchParams.get('from')); const sig = bs58.encode(require('crypto').randomBytes(64)); P.funds.set(to, sig); P.fundSigs.set(sig, { from, to }); return json(res, { to, from }); }
  if (u.pathname === '/pp/noroute') { P.noroute.add(u.searchParams.get('mint')); return json(res, { ok: true }); }
  if (u.pathname === '/pp/who') return json(res, { address: who(u.searchParams.get('name')) });
  if (u.pathname === '/pp/subs') return json(res, [...P.clients].map((c) => ({ newToken: c.newToken, migration: c.migration, keys: c.keys.size })));
  const q = JSON.parse(b || '{}'); const handle = (x) => { try { return { jsonrpc: '2.0', id: x.id, result: rpc(x.method, x.params) }; } catch (e) { return { jsonrpc: '2.0', id: x.id, error: { code: -32015, message: e.message } }; } };
  json(res, Array.isArray(q) ? q.map(handle) : handle(q));
}).listen(18900, '127.0.0.1');
const onConn = (ws) => ws.on('message', (m) => { const r = JSON.parse(m);
  if (r.method === 'logsSubscribe') { const id = nextSub++; subs.set(id, { ws, kind: 'logs' }); ws.send(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: id })); }
  else if (r.method === 'signatureSubscribe') { const id = nextSub++; ws.send(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: id }));
    setTimeout(() => ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'signatureNotification', params: { result: { context: { slot: 1 }, value: { err: null } }, subscription: id } })), 50); }
  else if (r.method === 'accountSubscribe') { const id = nextSub++; subs.set(id, { ws, kind: 'account', key: r.params[0] }); ws.send(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: id })); }
  else if (r.method === 'accountUnsubscribe') { subs.delete(r.params[0]); ws.send(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: true })); }
  else ws.send(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: true }));
});
new WebSocketServer({ server: mainHttp }).on('connection', onConn);
new WebSocketServer({ port: 18901, host: '127.0.0.1' }).on('connection', onConn);
new WebSocketServer({ port: 18904, host: '127.0.0.1' }).on('connection', (ws) => {
  const c = { ws, newToken: false, migration: false, keys: new Set() }; P.clients.add(c);
  ws.on('close', () => P.clients.delete(c));
  ws.on('message', (m) => { const r = JSON.parse(m);
    if (r.method === 'subscribeNewToken') { c.newToken = true; ws.send(JSON.stringify({ message: 'Successfully subscribed to token creation events.' })); }
    else if (r.method === 'subscribeMigration') { c.migration = true; ws.send(JSON.stringify({ message: 'Successfully subscribed to migration events.' })); }
    else if (r.method === 'subscribeTokenTrade') for (const k of r.keys ?? []) c.keys.add(k);
    else if (r.method === 'unsubscribeTokenTrade') for (const k of r.keys ?? []) c.keys.delete(k);
  });
});

// Jupiter: 1 lamport buys 1 token; selling returns tokens * mult lamports. /swap returns a real v0 transaction.
http.createServer(async (r, res) => { const b = await body(r); const u = new URL(r.url, 'http://x');
  if (u.pathname.endsWith('/quote') && (P.noroute.has(u.searchParams.get('inputMint')) || P.noroute.has(u.searchParams.get('outputMint')))) { res.statusCode = 400; return res.end('{"error":"Could not find any route","errorCode":"COULD_NOT_FIND_ANY_ROUTE"}'); }
  if (u.pathname.endsWith('/quote')) { const amt = BigInt(u.searchParams.get('amount') ?? '0'); const buy = u.searchParams.get('inputMint').startsWith('So111');
    const out = buy ? amt : BigInt(Math.floor(Number(amt) * S.mult));
    return json(res, { inputMint: u.searchParams.get('inputMint'), outputMint: u.searchParams.get('outputMint'), inAmount: amt.toString(), outAmount: out.toString() }); }
  if (u.pathname.endsWith('/swap')) { const { quoteResponse: qr, userPublicKey } = JSON.parse(b); const user = new web3.PublicKey(userPublicKey);
    const msg = new web3.TransactionMessage({ payerKey: user, recentBlockhash: '11111111111111111111111111111111', instructions: [new web3.TransactionInstruction({ programId: new web3.PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'), keys: [{ pubkey: user, isSigner: true, isWritable: true }], data: Buffer.from([1]) })] }).compileToV0Message();
    if (qr.inputMint.startsWith('So111')) { S.held += BigInt(qr.outAmount); S.balanceLamports -= Number(qr.inAmount); } else { S.held -= BigInt(qr.inAmount); S.balanceLamports += Number(qr.outAmount); }
    S.swaps.push({ in: qr.inputMint.slice(0, 4), inAmount: qr.inAmount, outAmount: qr.outAmount });
    return json(res, { swapTransaction: Buffer.from(new web3.VersionedTransaction(msg).serialize()).toString('base64'), lastValidBlockHeight: 100 }); }
  res.statusCode = 404; res.end('{}');
}).listen(18902, '127.0.0.1');

// DexScreener, Pump.fun, X embeds, IPFS, a website and Groq, on one port.
const pair = (sym, addr, mc, extra = {}) => ({ chainId: 'solana', dexId: 'pumpswap', pairAddress: addr, baseToken: { address: addr, name: `${sym} token`, symbol: sym }, priceUsd: '0.001', marketCap: mc, liquidity: { usd: mc / 10 }, volume: { h24: mc }, txns: { h24: { buys: 100, sells: 50 } }, priceChange: { h1: 12 }, pairCreatedAt: Date.now() - 3600e3, ...extra });
http.createServer(async (r, res) => { const b = await body(r); const u = new URL(r.url, 'http://x'); const p = u.pathname;
  const REL = process.env.REL_TAG || 'solboy-v1.1.1';
  if (p === '/gh/releases.atom') { res.setHeader('content-type', 'application/atom+xml');
    return res.end(!S.release ? '<feed></feed>' : `<feed><entry><link rel="alternate" type="text/html" href="https://github.com/zero998k/Skully/releases/tag/solboy-v1.0.9"/><content type="html"></content></entry><entry><link rel="alternate" type="text/html" href="https://github.com/zero998k/Skully/releases/tag/${REL}"/><title>SolBoy</title><content type="html">&lt;p&gt;&lt;strong&gt;New:&lt;/strong&gt; auto-updates from the dashboard.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Faster research&lt;/li&gt;&lt;/ul&gt;</content></entry></feed>`); }
  if (p.startsWith(`/gh/releases/download/${REL}/`)) { const name = p.split('/').pop(); let data = require('fs').readFileSync((process.env.FAKE_REL_DIR || __dirname + '/rel') + '/' + name); if (S.corrupt && name !== 'SHA256SUMS') data = Buffer.concat([data, Buffer.from('x')]); res.setHeader('content-type', 'application/octet-stream'); return res.end(data); }
  if (p === '/repos/zero998k/Skully/releases' && S.apidown) { res.statusCode = 403; return res.end('{"message":"API rate limit exceeded"}'); }
  if (p === '/repos/zero998k/Skully/releases') { const base = 'http://127.0.0.1:18903/dl/';
    return json(res, !S.release ? [] : [{ tag_name: 'solboy-v1.0.9', draft: false, prerelease: false, assets: [] }, { tag_name: 'v9.9.9', draft: false, prerelease: false, assets: [] }, { tag_name: REL, draft: false, prerelease: false, html_url: 'https://github.com/zero998k/Skully/releases/tag/' + REL, body: '**New:** auto-updates from the dashboard.\n- Faster research', assets: ['SolBoy-Linux-x64', 'SHA256SUMS'].map((n) => ({ name: n, browser_download_url: base + n })) }]); }
  if (p.startsWith('/dl/')) { const name = p.slice(4); let data = require('fs').readFileSync((process.env.FAKE_REL_DIR || __dirname + '/rel') + '/' + name); if (S.corrupt && name !== 'SHA256SUMS') data = Buffer.concat([data, Buffer.from('x')]); res.setHeader('content-type', 'application/octet-stream'); return res.end(data); }
  if (p.startsWith('/tokens/v1/solana/') && [...P.coins.values()].some((c) => c.migrated && p.includes(c.mint))) return json(res, [...P.coins.values()].filter((c) => c.migrated && p.includes(c.mint)).map((c) => ({ chainId: 'solana', dexId: 'pumpswap', pairAddress: c.pair, baseToken: { address: c.mint, name: c.name, symbol: c.symbol }, priceUsd: '0.00008', marketCap: 80000, liquidity: { usd: 30000 }, volume: { h24: 120000 }, txns: { h24: { buys: 900, sells: 400 } }, priceChange: { h1: 20 }, pairCreatedAt: Date.now() - 600000, info: { imageUrl: 'http://127.0.0.1:18903/img.png', websites: [{ url: 'https://example.com' }], socials: [{ type: 'twitter', url: 'https://x.com/dexpaid' }] } })));
  if (p === '/pp-api/trade-local') { const q = JSON.parse(b); P.tradeLocal = [...(P.tradeLocal ?? []), q]; const user = new web3.PublicKey(q.publicKey);
    const msg = new web3.TransactionMessage({ payerKey: user, recentBlockhash: '11111111111111111111111111111111', instructions: [new web3.TransactionInstruction({ programId: new web3.PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'), keys: [{ pubkey: user, isSigner: true, isWritable: true }], data: Buffer.from([2]) })] }).compileToV0Message();
    if (q.action === 'buy') { S.held += BigInt(Math.round(q.amount * 3e10)); S.balanceLamports -= Math.round(q.amount * 1e9); } else { const t = BigInt(Math.round(q.amount * 1e6)); S.held -= t > S.held ? S.held : t; S.balanceLamports += 5e7; }
    res.setHeader('content-type', 'application/octet-stream'); return res.end(Buffer.from(new web3.VersionedTransaction(msg).serialize())); }
  if (p === '/pp/tradelocal') return json(res, P.tradeLocal ?? []);
  if (p === '/price') return json(res, { So11111111111111111111111111111111111111112: { usdPrice: 150 } });
  if (p.startsWith('/meta/')) { const sym = p.slice(6); return json(res, { name: sym, symbol: sym, description: `${sym} is a test coin`, image: 'http://127.0.0.1:18903/img.png', twitter: sym === 'MCAT' ? 'https://x.com/mooncat' : undefined, website: sym === 'MCAT' ? 'https://mooncat.fun' : undefined, telegram: sym === 'MCAT' ? 'https://t.me/mooncat' : undefined }); }
  if (p === '/img.png') { res.setHeader('content-type', 'image/png'); return res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')); }
  if (p === '/pump-api/coins') { const q = u.searchParams; const vt = 1073000191 - 0.8 * 793100191, vs = (30 * 1073000191) / vt;
    const coin = (mint, name, symbol, extra) => ({ mint, name, symbol, metadata_uri: `http://127.0.0.1:18903/meta/${symbol}`, image_uri: 'http://127.0.0.1:18903/img.png', creator: who('seeddev'), created_timestamp: Date.now() - 1800e3, bonding_curve: pk(), virtual_sol_reserves: Math.round(vs * 1e9), virtual_token_reserves: Math.round(vt * 1e6), market_cap: (vs / vt) * 1e9, last_trade_timestamp: Date.now() - 5000, complete: false, twitter: 'https://x.com/seedcoin', ...extra });
    if (q.get('complete') === 'false') return json(res, [coin(P.seed, 'Seed Stretch', 'SEED')]);
    if (q.get('complete') === 'true') return json(res, [coin(P.grad, 'Graduated One', 'GRAD', { complete: true, market_cap: 600 })]);
    return json(res, []); }
  if (p === `/gecko/networks/solana/tokens/${P.seed}/pools`) return json(res, { data: [{ attributes: { address: 'GeckoSeedPool' } }] });
  if (p === '/gecko/networks/solana/pools/GeckoSeedPool/trades') return json(res, { data: Array.from({ length: 30 }, (_, i) => ({ attributes: { tx_hash: `seedtx${i}`, tx_from_address: who(`seedw${i % 7}`), kind: i % 3 ? 'buy' : 'sell', from_token_amount: i % 3 ? '0.5' : '1000000', to_token_amount: i % 3 ? '1000000' : '0.45', price_to_in_usd: '0.000025', price_from_in_usd: '0.000025', block_timestamp: new Date(Date.now() - (30 - i) * 20e3).toISOString() } })) });
  if (p.startsWith('/gecko/')) return json(res, { data: [] });
  if (p.startsWith('/tokens/v1/solana/')) return json(res, p.includes(MINT) ? [pair('BOYZ', MINT, 250000, { priceChange: { m5: 12, h1: 85, h6: 140, h24: 140 }, volume: { m5: 9000, h1: 60000, h6: 90000, h24: 90000 }, txns: { m5: { buys: 40, sells: 12 }, h1: { buys: 300, sells: 110 } }, boosts: { active: 2 } })] : []);
  if (p === '/latest/dex/search') { const qq = (u.searchParams.get('q') || '').toUpperCase();
    return json(res, { pairs: qq === 'BOYZ' ? [pair('BOYZ', 'Copy1111111111111111111111111111111111111111', 90000), pair('boyz', 'Copy2222222222222222222222222222222222222222', 3000), pair('BOYZ', MINT, 8000)] : qq === 'WIF' ? [pair('WIF', 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', 2000000000)] : [] }); }
  if (p === '/token-boosts/top/v1') return json(res, []);
  if (p === `/coins/${MINT}`) return json(res, { mint: MINT, name: 'SolBoy Cat', symbol: 'BOYZ', description: 'the cat that copies whales', twitter: 'https://x.com/catguy/status/1850000000000000000', website: 'http://127.0.0.1:18903/site', creator: DEV, created_timestamp: Date.now() - 120000, usd_market_cap: 8123.4, complete: false, reply_count: 12, king_of_the_hill_timestamp: null, metadata_uri: 'http://127.0.0.1:18903/ipfs/QmFakeMeta' });
  if (p === `/coins/user-created-coins/${DEV}`) return json(res, [{ mint: MINT, symbol: 'BOYZ' }, ...Array.from({ length: 7 }, (_, i) => ({ mint: `old${i}`, symbol: `RUG${i}`, name: `Rug ${i}`, complete: i === 0, usd_market_cap: 4000, created_timestamp: Date.now() - (i + 1) * 86400e3 }))]);
  if (p === '/tweet-result') return json(res, { text: 'my cat just learned to copy trade whales lol', user: { name: 'Cat Guy', screen_name: 'catguy', is_blue_verified: true }, favorite_count: 4200, conversation_count: 300, created_at: new Date(Date.now() - 3600e3).toUTCString() });
  if (p === '/ipfs/QmFakeMeta') return json(res, { name: 'SolBoy Cat', symbol: 'BOYZ', description: 'the cat that copies whales', twitter: 'https://x.com/catguy/status/1850000000000000000', website: 'http://127.0.0.1:18903/site', createdOn: 'https://pump.fun' });
  if (p === '/site') { res.setHeader('content-type', 'text/html'); return res.end('<html><head><title>BOYZ - the copy cat</title><meta property="og:description" content="A cat that copies whales. Join the pack."></head><body>hi</body></html>'); }
  if (p === '/openai/v1/models') return json(res, { data: [{ id: 'openai/gpt-oss-120b' }, { id: 'llama-3.3-70b-versatile' }] });
  if (p === '/openai/v1/chat/completions') { const q = JSON.parse(b); S.groq.push({ stream: !!q.stream, tools: !!q.tools, last: q.messages.at(-1) });
    const promptTokens = Math.round(JSON.stringify(q.messages).length / 4);
    if (q.stream && (S.groqdown || (S.groq413 && q.model === 'openai/gpt-oss-120b' && promptTokens + (q.max_tokens ?? 0) > 3000))) {
      S.groq.push({ refused: q.model, promptTokens, max: q.max_tokens });
      res.statusCode = S.groqdown ? 429 : 413; return json(res, { error: { message: `Request too large for model \`${q.model}\` on tokens per minute (TPM): Limit 8000, Requested ${promptTokens + q.max_tokens}`, type: 'tokens' } }); }
    if (q.stream) { const user = q.messages.at(-1).content; let snap = {}; try { snap = JSON.parse(user.slice(user.indexOf('{'))); } catch {}
      const mv = snap.movement ?? {};
      const seenMv = `direction=${mv.direction} signals=${(mv.signals ?? []).length} first=[${(mv.signals ?? [])[0]}] spike=${(mv.signals ?? []).some((x) => /volume spike/.test(x))} x=${snap.xAccount}`;
      const seen = `tweet=${/copy trade whales/.test(snap.linkedTweet?.text ?? '')} dev=${snap.creatorHistory?.otherCoinsLaunched} copycats=${snap.sameTickerTokens?.count} launchpad=${snap.launchpad?.platform} site=${snap.website?.title} replies=${snap.launchpad?.pumpFunReplies}`;
      const text = `### 🪙 $BOYZ | SolBoy Cat\n**What it is:** A cat meme coin from @catguy's viral post about his cat copy trading whales.\n**Why it's pumping:** ${seenMv}. ${seen}.\n**Biggest risk:** The creator launched 7 other coins.\n\n### 💡 Quick Verdict\n**Viral post** vs. **Serial dev**`;
      res.setHeader('content-type', 'text/event-stream');
      for (const piece of text.match(/.{1,20}/gs)) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
      return res.end('data: [DONE]\n\n'); }
    const last = q.messages.at(-1); const said = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
    const reply = (message) => json(res, { choices: [{ message }] });
    const call = (name, args) => reply({ role: 'assistant', content: '', tool_calls: [{ id: 'c' + Date.now(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
    if (last.role === 'tool') return reply({ role: 'assistant', content: `Looked it up: ${said.slice(0, 160)}` });
    if (/reset/i.test(said)) return call('reset_pnl', {});
    if (/stop loss/i.test(said)) return call('change_setting', { setting: 'stopLossPct', value: '25' });
    if (/price|wif/i.test(said)) return call('lookup_token', { query: 'WIF' });
    return reply({ role: 'assistant', content: 'gm from fake groq' }); }
  res.statusCode = 404; res.end('{}');
}).listen(18903, '127.0.0.1');
console.log('fake world up');
