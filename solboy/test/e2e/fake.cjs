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
const txs = {}; const subs = new Map(); let nextSub = 1; let n = 0;
const tb = (amt) => ({ accountIndex: 1, mint: MINT, owner: WHALE, uiTokenAmount: { amount: String(amt), decimals: 6, uiAmount: amt / 1e6 } });
function makeTx(side, frac = 1, held = 0) {
  const sig = bs58.encode(Buffer.from(require('crypto').randomBytes(64)));
  const buy = side === 'buy';
  const pre = buy ? (held ? 1e6 : 0) : 1e6, post = buy ? pre + 1e6 : Math.round(1e6 * (1 - frac));
  txs[sig] = { slot: 1, blockTime: Math.floor(Date.now() / 1000), transaction: { signatures: [sig], message: { accountKeys: [{ pubkey: WHALE, signer: true, writable: true }, { pubkey: MINT, signer: false, writable: false }], instructions: [], recentBlockhash: '11111111111111111111111111111111' } },
    meta: { err: null, fee: 5000, preBalances: [5e9, 0], postBalances: [buy ? 5e9 - 5e8 - 5000 : 5e9 + 6e8 * frac - 5000, 0], preTokenBalances: pre ? [tb(pre)] : [], postTokenBalances: [tb(post)], innerInstructions: [], logMessages: [] } };
  return sig;
}
const ok = (value) => ({ context: { slot: 1 }, value });
function rpc(method, params) {
  switch (method) {
    case 'getSlot': return 123;
    case 'getBlockHeight': return 50;
    case 'getBalance': return ok(S.balanceLamports);
    case 'getTransaction': {
      if (!(params[1]?.maxSupportedTransactionVersion >= 1)) throw new Error('Transaction version (1) is not supported by the requesting client.');
      return txs[params[0]] ? { ...txs[params[0]], version: 1 } : null;
    }
    case 'getAccountInfo': return ok({ data: { parsed: { info: { mintAuthority: null, freezeAuthority: null, decimals: 6, supply: '1000000000000', isInitialized: true }, type: 'mint' }, program: 'spl-token', space: 82 }, executable: false, lamports: 1, owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', rentEpoch: 0 });
    case 'getLatestBlockhash': return ok({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 100 });
    case 'getAsset': return { content: { json_uri: 'http://127.0.0.1:18903/ipfs/QmFakeMeta', metadata: { name: 'SolBoy Cat', symbol: 'BOYZ', description: '' }, links: {} } };
    case 'getTokenLargestAccounts': return ok([{ address: DEV, amount: '600000000', decimals: 6, uiAmount: 600, uiAmountString: '600' }, { address: WHALE, amount: '100000000', decimals: 6, uiAmount: 100, uiAmountString: '100' }]);
    case 'getTokenSupply': return ok({ amount: '1000000000', decimals: 6, uiAmount: 1000, uiAmountString: '1000' });
    case 'getTokenAccountsByOwner': return ok(S.held > 0n ? [{ pubkey: DEV, account: { data: { program: 'spl-token', parsed: { type: 'account', info: { mint: MINT, owner: params[0], tokenAmount: { amount: S.held.toString(), decimals: 6, uiAmount: Number(S.held) / 1e6, uiAmountString: String(Number(S.held) / 1e6) } } }, space: 165 }, executable: false, lamports: 2039280, owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', rentEpoch: 0, space: 165 } }] : []);
    case 'sendTransaction': {
      const raw = Buffer.from(params[0], 'base64'); const sig = bs58.encode(raw.subarray(1, 65));
      // A plain SOL transfer (withdraw): take the amount off the balance.
      try { const t = web3.Transaction.from(raw); const ix = t.instructions[0]; if (ix.programId.equals(web3.SystemProgram.programId)) { const lam = Number(ix.data.readBigUInt64LE(4)); S.balanceLamports -= lam + 5000; S.sent.push({ kind: 'transfer', to: ix.keys[1].pubkey.toBase58(), lamports: lam, sig }); return sig; } } catch {}
      S.sent.push({ kind: 'swap', sig }); return sig;
    }
    case 'getSignatureStatuses': return ok(params[0].map(() => ({ slot: 1, confirmations: null, err: null, confirmationStatus: 'confirmed' })));
    default: S.log.push('unhandled ' + method); return null;
  }
}
const json = (res, x) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(x)); };
const body = (r) => new Promise((ok) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => ok(b)); });
const mainHttp = http.createServer(async (r, res) => { const b = await body(r); const u = new URL(r.url, 'http://x');
  if (u.pathname === '/emit') { const side = u.searchParams.get('side'); const sig = makeTx(side, Number(u.searchParams.get('frac') ?? 1), Number(u.searchParams.get('held') ?? 0));
    for (const [id, s] of subs) if (s.ws.readyState === 1 && s.kind === 'logs') s.ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'logsNotification', params: { result: { context: { slot: 1 }, value: { signature: sig, err: null, logs: ['Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [1]', `Program log: Instruction: ${side === 'buy' ? 'Buy' : 'Sell'}`] } }, subscription: id } }));
    return json(res, { sig, subs: [...subs.values()].filter((s) => s.kind === 'logs').length }); }
  if (u.pathname === '/set') { for (const k of ['release', 'corrupt', 'apidown', 'groq413', 'groqdown']) if (u.searchParams.has(k)) S[k] = Number(u.searchParams.get(k)); if (u.searchParams.has('mult')) S.mult = Number(u.searchParams.get('mult')); if (u.searchParams.has('sol')) S.balanceLamports = Math.round(Number(u.searchParams.get('sol')) * 1e9); return json(res, { ok: true }); }
  if (u.pathname === '/state') return json(res, { ...S, held: S.held.toString() });
  const q = JSON.parse(b || '{}'); const handle = (x) => { try { return { jsonrpc: '2.0', id: x.id, result: rpc(x.method, x.params) }; } catch (e) { return { jsonrpc: '2.0', id: x.id, error: { code: -32015, message: e.message } }; } };
  json(res, Array.isArray(q) ? q.map(handle) : handle(q));
}).listen(18900, '127.0.0.1');
const onConn = (ws) => ws.on('message', (m) => { const r = JSON.parse(m);
  if (r.method === 'logsSubscribe') { const id = nextSub++; subs.set(id, { ws, kind: 'logs' }); ws.send(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: id })); }
  else if (r.method === 'signatureSubscribe') { const id = nextSub++; ws.send(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: id }));
    setTimeout(() => ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'signatureNotification', params: { result: { context: { slot: 1 }, value: { err: null } }, subscription: id } })), 50); }
  else ws.send(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: true }));
});
new WebSocketServer({ server: mainHttp }).on('connection', onConn);
new WebSocketServer({ port: 18901, host: '127.0.0.1' }).on('connection', onConn);

// Jupiter: 1 lamport buys 1 token; selling returns tokens * mult lamports. /swap returns a real v0 transaction.
http.createServer(async (r, res) => { const b = await body(r); const u = new URL(r.url, 'http://x');
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
