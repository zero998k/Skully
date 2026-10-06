// Scout for iPad · rule tests. Run: node --test scout-ipad-tests/
process.env.TZ = 'UTC';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../docs/core.js');

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const POOL = '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2';
const EVM = '0x1b54e762aa34cf6e28e9c082f2848e28e45da6b8';
const NOW = Date.UTC(2026, 9, 6, 15, 0, 0);
const MAC_COSTS = {feePct: 0.3, slippagePct: 1, solanaFeeUsd: 0.03};

function pair(overrides) {
  return {chainId: 'solana', dexId: 'raydium', pairAddress: POOL, baseToken: {address: SOL, name: 'Test Coin', symbol: 'TEST'},
    priceUsd: '0.001', liquidity: {usd: 40000}, volume: {m5: 6000, h24: 900000}, priceChange: {m5: 3, h1: 12, h24: 40},
    txns: {m5: {buys: 60, sells: 30}}, marketCap: 400000, fdv: 420000, pairCreatedAt: NOW - 3 * 3600000,
    info: {imageUrl: 'https://dd.dexscreener.com/ds-data/tokens/solana/x.png', socials: [{type: 'twitter', url: 'https://x.com/test'}]}, ...overrides};
}
const market = overrides => ({...C.normalizeMarket([pair()], 'solana', SOL, NOW), ...overrides});
const clean = {status: 'available', provider: 'RugCheck', allowed: true, riskDetected: false, flags: [], label: 'ok', providerSignals: {creatorLaunches: 1}};
const blitz = C.strategyConfig('blitz', {});
const items = result => Object.fromEntries(result.groups.flatMap(group => group.items).map(item => [item.label, item]));
const rules = overrides => C.rulesConfig({...overrides});

test('addresses: Solana mints, EVM addresses and pasted links', () => {
  assert.ok(C.validMint(SOL));
  assert.ok(C.validMint(USDC));
  assert.ok(!C.validMint('So1111111111111111111111111111111111111111'));
  assert.ok(!C.validMint('0OIl' + SOL.slice(4)));
  assert.ok(C.addressOk('ethereum', EVM));
  assert.ok(!C.addressOk('solana', EVM));
  assert.equal(C.findAddress('  ' + SOL + '\n'), SOL);
  assert.equal(C.findAddress('https://dexscreener.com/solana/' + POOL), POOL);
  assert.equal(C.findAddress('https://pump.fun/coin/' + USDC + '?ref=abc'), USDC);
  assert.equal(C.findAddress('https://etherscan.io/token/' + EVM), EVM);
  assert.equal(C.findAddress('pepe'), 'pepe');
  assert.ok(C.poolIdOk('ethereum', '0x' + 'ab'.repeat(32)));
  assert.ok(!C.poolIdOk('solana', '0x' + 'ab'.repeat(32)));
  assert.equal(C.axiomUrl({chain: 'solana', pair: POOL}), 'https://axiom.trade/meme/' + POOL);
  assert.equal(C.axiomUrl({chain: 'base', pair: EVM}), null);
});

test('formatting matches what traders read on DexScreener', () => {
  assert.equal(C.priceText(1234.5), '$1,234.50');
  assert.equal(C.priceText(0.5), '$0.5');
  assert.equal(C.priceText(0.00012346), '$0.0001235');
  assert.equal(C.priceText(0.00001234), '$0.0₄1234');
  assert.equal(C.priceText(0.000000005), '$0.0₈5');
  assert.equal(C.usd(1500), '$1,500');
  assert.equal(C.usd(-5.016), '−$5.02');
  assert.equal(C.signedUsd(3.99), '+$3.99');
  assert.equal(C.pct(12.4), '12%');
  assert.equal(C.pct(3), '3%');
  assert.equal(C.pct(3.25), '3.3%');
  assert.equal(C.compactUsd(4950000), '$5.0M');
  assert.equal(C.duration(3 * 3600), '3 hours');
  assert.equal(C.plain(0.00001234), '0.00001234');
  assert.equal(C.clock(125), '2:05');
});

test('market: deepest pool wins, and EVM coins pick the chain with the most money', () => {
  const pairs = [pair({liquidity: {usd: 1000}, pairAddress: USDC}), pair()];
  assert.equal(C.normalizeMarket(pairs, 'solana', SOL, NOW).pair, POOL);
  const m = market();
  assert.equal(m.symbol, 'TEST');
  assert.equal(m.valuationUsd, 400000);
  assert.equal(m.hasSocials, true);
  assert.equal(m.sourceUrl, 'https://dexscreener.com/solana/' + POOL);
  assert.equal(C.normalizeMarket([pair({priceUsd: '0'})], 'solana', SOL, NOW), null);
  const evm = (chain, liquidity) => ({chainId: chain, pairAddress: '0x' + '1'.repeat(40), baseToken: {address: EVM.toUpperCase().replace('0X', '0x'), symbol: 'CLAUS'},
    priceUsd: '0.005', liquidity: {usd: liquidity}});
  assert.equal(C.pickMarket([evm('base', 5000), evm('ethereum', 90000)], EVM, null, NOW).chain, 'ethereum');
  assert.equal(C.pickMarket([evm('base', 5000)], EVM, null, NOW).chain, 'base');
  assert.equal(C.safeImage('https://evil.example/x.png'), null);
});

test('costs: same round-trip math as the Mac Scout', () => {
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} vs ${b}`);
  close(C.costPct('solana', 25, 50000, rules(MAC_COSTS), C.strategyConfig('goal', {})), 2.996947932432547);
  close(C.costPct('solana', 30, 40000, rules(MAC_COSTS), blitz), 3.0548099249073897);
  close(C.costPct('ethereum', 100, 80000, rules(MAC_COSTS), blitz), 6.902960307978229);
  assert.equal(C.costPct('solana', 0, 1000, rules(), blitz), 100);
});

test('grade: a clean coin that fits Blitz passes, item for item like the Mac', () => {
  const r = rules(MAC_COSTS);
  const result = C.grade(market(), clean, blitz, {now: NOW, trades: [], sizeUsd: 100, costPct: C.costPct('solana', 100, 40000, r, blitz)});
  assert.equal(result.verdict.code, 'pass');
  const row = items(result);
  assert.equal(row['Contract scan'].status, 'pass');
  assert.equal(row["Developer's share"].status, 'unknown');
  assert.equal(row["Developer's other coins"].detail, 'The developer launched 1 other coin (your limit 2).');
  assert.equal(row.Liquidity.detail, '$40,000 in the pool (you want at least $25,000). Less money means bigger price jumps and easier rugs.');
  assert.equal(row['Pool vs market cap'].detail, 'The pool holds 10% of the market cap (you want 3%).');
  assert.equal(row['Coin age'].detail, 'The pool is 3 hours old (you want 10 minutes to 30 days).');
  assert.equal(row['Last 5 minutes'].detail, 'Price moved +3.0% in 5 minutes (you want 0% to 30%).');
  assert.equal(row['Buyers vs sellers'].detail, '67% of trades are buys (you want at least 50%).');
  assert.match(row['Fees to buy and sell'].detail, /^Buying and selling \$100\.00 costs about 3\.6% /);
  assert.equal(result.counts.failed, 0);
});

test('grade: red flags mean skip, rule misses mean no, an unchecked contract means careful', () => {
  const ctx = {now: NOW, trades: [], sizeUsd: 30, costPct: 3};
  const honeypot = {...clean, allowed: false, riskDetected: true, flags: [{name: 'Honeypot: you may not be able to sell', level: 'danger'}]};
  assert.equal(C.grade(market(), honeypot, blitz, ctx).verdict.code, 'skip');
  const warned = {...clean, allowed: false, flags: [{name: 'Low amount of LP Providers', level: 'warn'}]};
  const warnResult = C.grade(market(), warned, blitz, ctx);
  assert.equal(warnResult.verdict.code, 'rules');
  assert.equal(items(warnResult)['Contract scan'].hard, false);
  assert.equal(C.grade(market({liquidity: 9000}), clean, blitz, ctx).verdict.code, 'rules');
  assert.equal(C.grade(market(), C.riskUnavailable("Couldn't reach rugcheck.xyz"), blitz, ctx).verdict.code, 'caution');
  const dumped = C.grade(market({buys5m: 95, sells5m: 1}), clean, blitz, ctx);
  assert.equal(dumped.verdict.code, 'skip');
  assert.match(items(dumped)['Buyers vs sellers'].detail, /honeypot/);
  const pump = C.grade(market({change5m: 45}), clean, blitz, ctx);
  assert.match(items(pump)['Last 5 minutes'].detail, /vertical pump/);
  const v4 = C.grade(market({labels: ['v4']}), clean, blitz, ctx);
  assert.equal(items(v4)['Pool add-on code'].status, 'warn');
  const top = C.grade(market(), {...clean, providerSignals: {top10HolderShare: 0.6, creatorPercent: 0.12}}, blitz, ctx);
  assert.equal(top.verdict.code, 'skip');
  assert.equal(items(top)['Top 10 holders'].status, 'fail');
  assert.equal(items(top)["Developer's share"].status, 'fail');
});

test('grade: your journal shows up in the check', () => {
  const trade = {chain: 'solana', address: SOL, status: 'closed', pnlUsd: -4.2, closedAt: NOW - 3600000};
  const result = C.grade(market(), clean, blitz, {now: NOW, trades: [trade], sizeUsd: 30, costPct: 3});
  assert.equal(items(result)['Your journal'].status, 'warn');
  assert.equal(result.memory, 'You traded this coin 1 time: −$4.20 net.');
});

test('radar quick read skips the contract scan and unknown socials', () => {
  const gecko = {...market(), hasSocials: null};
  const result = C.grade(gecko, {status: 'skipped'}, blitz, {now: NOW, trades: [], sizeUsd: 30, costPct: 3});
  assert.ok(!items(result)['Contract scan']);
  assert.equal(items(result)['Website or socials'].status, 'unknown');
  assert.equal(result.verdict.code, 'pass');
});

test('contract scans: RugCheck and GoPlus reports become plain-English flags', () => {
  const report = {mint: SOL, risks: [{name: 'Mutable metadata', level: 'warn', description: 'Can be changed'}], creatorTokens: [{mint: USDC}]};
  const warned = C.parseRugcheck(report, SOL);
  assert.equal(warned.allowed, false);
  assert.equal(warned.riskDetected, false);
  assert.equal(warned.providerSignals.creatorLaunches, 1);
  const rugged = C.parseRugcheck({...report, rugged: true}, SOL);
  assert.equal(rugged.riskDetected, true);
  assert.equal(C.parseRugcheck({mint: SOL, risks: []}, SOL).allowed, true);
  assert.throws(() => C.parseRugcheck({mint: USDC, risks: []}, SOL));
  const fields = {is_open_source: '1', buy_tax: '0', sell_tax: '0'};
  for (const field of ['is_honeypot', 'cannot_sell_all', 'cannot_buy', 'is_blacklisted', 'is_mintable', 'owner_change_balance', 'hidden_owner',
    'is_proxy', 'transfer_pausable', 'slippage_modifiable', 'can_take_back_ownership', 'selfdestruct', 'external_call']) fields[field] = '0';
  const holders = [{percent: '0.2', is_contract: 0, is_locked: 0}, {percent: '0.5', is_contract: 1, is_locked: 0}, {percent: '0.1', is_contract: 0, is_locked: 1}];
  const ok = C.parseGoplus({code: 1, result: {[EVM]: {...fields, holders, creator_percent: '0.02'}}}, 'ethereum', EVM);
  assert.equal(ok.allowed, true);
  assert.equal(ok.providerSignals.top10HolderShare, 0.2);
  assert.equal(ok.providerSignals.creatorPercent, 0.02);
  const bad = C.parseGoplus({code: 1, result: {[EVM]: {...fields, is_proxy: '1', sell_tax: '0.1'}}}, 'ethereum', EVM);
  assert.equal(bad.riskDetected, true);
  assert.deepEqual(bad.flags.map(flag => flag.name), ['Contract code can be changed', 'Sell tax 10%']);
  const blank = C.parseGoplus({code: 1, result: {}}, 'base', EVM);
  assert.equal(blank.allowed, false);
  assert.equal(blank.flags.length, 0);
  assert.equal(C.grade(market(), blank, C.strategyConfig('goal', {}), {now: NOW, trades: [], sizeUsd: 30, costPct: 3}).groups[0].items[0].status, 'unknown');
});

test('GeckoTerminal pools become markets', () => {
  const payload = {data: [{id: 'solana_' + POOL, type: 'pool', attributes: {address: POOL, base_token_price_usd: '0.002', reserve_in_usd: '55000',
    pool_created_at: '2026-10-06T12:00:00Z', market_cap_usd: null, fdv_usd: '700000', price_change_percentage: {m5: '1.5', h1: '-3'},
    transactions: {m5: {buys: 40, sells: 22}}, volume_usd: {m5: '8000'}}, relationships: {base_token: {data: {id: 'solana_' + SOL, type: 'token'}}, dex: {data: {id: 'raydium'}}}}],
  included: [{id: 'solana_' + SOL, type: 'token', attributes: {address: SOL, symbol: 'GT', name: 'Gecko Test', image_url: 'missing.png'}}]};
  const [found] = C.geckoPairs(payload, 'solana');
  const m = C.normalizeMarket([found], 'solana', SOL, NOW);
  assert.equal(m.symbol, 'GT');
  assert.equal(m.valuationUsd, 700000);
  assert.equal(m.valuationKind, 'fully diluted value');
  assert.equal(m.hasSocials, null);
  assert.equal(m.change1h, -3);
  assert.equal(m.imageUrl, null);
});

test('plan: size comes from your risk, capped by your biggest trade', () => {
  const r = rules({bankrollUsd: 300, riskPct: 1, maxTradePct: 10});
  const ready = C.guard([], r, NOW);
  const plan = C.planFor(market(), r, blitz, ready);
  assert.ok(plan.sizeUsd <= 30 && plan.sizeUsd > 25, 'capped near $30: ' + plan.sizeUsd);
  assert.ok(plan.lossUsd <= 3.01, 'never risks more than 1%: ' + plan.lossUsd);
  assert.equal(plan.targetPct, 7);
  assert.equal(plan.stopPct, 2);
  assert.ok(Math.abs(plan.targetPrice - 0.00107) < 1e-12);
  assert.ok(plan.breakevenPct > 50);
  const wide = C.planFor(market(), rules({bankrollUsd: 300, riskPct: 1, maxTradePct: 100}), C.strategyConfig('momentum', {}), ready);
  assert.ok(Math.abs(wide.lossUsd - 3) < 0.02, 'loss equals the 1% risk: ' + wide.lossUsd);
  const net = C.planFor(market(), r, C.strategyConfig('goal', {}), ready);
  assert.ok(net.targetPct > 8 && net.stopPct < 6, 'net targets include fees');
  assert.ok(Math.abs(net.winUsd - net.sizeUsd * 0.08) < 0.02);
  const stopped = C.planFor(market(), r, blitz, {...ready, status: 'stop', lossLeftUsd: 0});
  assert.equal(stopped.sizeUsd, 0);
  assert.match(stopped.text, /guardrails/);
});

test('strategy tweaks stay inside their limits', () => {
  const custom = C.strategyConfig('blitz', {takeProfitPct: 15, stopLossPct: 5, trailingStopPct: 4, minLiquidity: -1});
  assert.equal(custom.takeProfitPct, 15);
  assert.equal(custom.trailingStopPct, 4);
  assert.equal(custom.minLiquidity, 25000);
  assert.equal(C.strategyConfig('blitz', {trailingStopPct: 0}).trailingStopPct, null);
  assert.equal(C.strategyConfig('nope', {}).takeProfitPct, 7);
  assert.equal(C.rulesConfig({bankrollUsd: 'abc', maxOpen: 2.5}).bankrollUsd, 300);
  assert.equal(C.rulesConfig({maxOpen: 2.5}).maxOpen, 2);
});

function closed(pnl, minutesAgo, extra) {
  return {id: 'c' + Math.random().toString(36).slice(2), status: 'closed', chain: 'solana', address: SOL, symbol: 'TEST', openedAt: NOW - (minutesAgo + 5) * 60000,
    closedAt: NOW - minutesAgo * 60000, pnlUsd: pnl, followedPlan: true, ruleBreaks: [], ...extra};
}

test('guardrails: daily loss limit, trades per day, open trades, and a break after losses', () => {
  const r = rules();
  assert.equal(C.guard([], r, NOW).status, 'ready');
  const down = C.guard([closed(-10, 300), closed(-6, 200)], r, NOW);
  assert.equal(down.status, 'stop');
  assert.match(down.reasons[0], /daily loss limit/);
  const streak = C.guard([closed(-2, 30), closed(-1, 20)], r, NOW);
  assert.equal(streak.status, 'cooldown');
  assert.equal(streak.lossStreak, 2);
  assert.match(streak.reasons[0], /41 more minutes/);
  const later = C.guard([closed(-2, 90), closed(-1, 80)], r, NOW);
  assert.equal(later.status, 'ready');
  const busy = C.guard(Array.from({length: 5}, (_, i) => closed(1, 10 + i)), r, NOW);
  assert.equal(busy.tradesLeft, 0);
  assert.equal(busy.status, 'stop');
  const open = C.guard([{status: 'open', openedAt: NOW - 60000}, {status: 'open', openedAt: NOW - 30000}], r, NOW);
  assert.match(open.reasons[0], /2 open trades/);
  const yesterday = C.guard([closed(-20, 24 * 60)], r, NOW);
  assert.equal(yesterday.status, 'ready');
});

function buy(extra, trades) {
  return C.openTrade({chain: 'solana', address: SOL, pair: POOL, symbol: 'TEST', entryPrice: '0.001', sizeUsd: '30', stopPct: '2', targetPct: '7',
    trailingPct: '0', holdMinutes: '30', costPct: 3, verdict: 'pass', ...extra}, trades || [], rules(), NOW, 'trade-1');
}

test('buying: breaking a rule needs a written reason', () => {
  const trade = buy();
  assert.equal(trade.status, 'open');
  assert.equal(trade.entryPrice, 0.001);
  assert.deepEqual(trade.ruleBreaks, []);
  assert.throws(() => buy({verdict: 'skip'}), /breaks your rules \(bought a coin the coach said to skip\)/);
  const forced = buy({verdict: 'skip', sizeUsd: '80', overrideReason: 'testing'});
  assert.equal(forced.ruleBreaks.length, 2);
  assert.match(forced.ruleBreaks[1], /more than your max size of \$30\.00/);
  assert.throws(() => buy({entryPrice: 'abc'}), /Your buy price must be a number/);
  assert.throws(() => buy({holdMinutes: '2.5'}), /whole number/);
  assert.throws(() => buy({address: EVM}), /Check the coin again/);
});

test('watching: stop, trailing stop, target and time signals', () => {
  const trade = buy({trailingPct: '5', targetPct: '20'});
  assert.equal(C.mark(trade, 0.00101, NOW + 8000), null);
  assert.equal(C.mark(trade, 0.00106, NOW + 16000), null);
  assert.equal(trade.peak, 0.00106);
  assert.equal(C.mark(trade, 0.001, NOW + 24000), 'trail');
  assert.equal(trade.firstSell, 'trail');
  assert.equal(C.mark(trade, 0.00097, NOW + 32000), 'stop');
  assert.equal(trade.firstSell, 'trail', 'the first sell signal is remembered');
  const target = buy();
  assert.equal(C.mark(target, 0.00108, NOW + 8000), 'target');
  const late = buy();
  assert.equal(C.mark(late, 0.001, NOW + 31 * 60000), 'time');
  const view = C.liveView(target, NOW + 9000);
  assert.ok(Math.abs(view.changePct - 8) < 1e-9);
  assert.equal(view.pnlUsd, 1.5);
});

test('catching up after the iPad paused Scout', () => {
  const trade = buy();
  trade.markAt = NOW;
  const candles = [[NOW, 0.001, 0.00102, 0.000995, 0.001], [NOW + 60000, 0.001, 0.001, 0.00097, 0.00099], [NOW + 120000, 0.00099, 0.00101, 0.00099, 0.001]];
  const missed = C.catchUp(trade, candles);
  assert.equal(missed.kind, 'stop');
  assert.equal(missed.low, 0.00097);
  assert.equal(trade.firstSell, 'stop');
  assert.equal(trade.peak, 0.00102);
  const calm = buy();
  calm.markAt = NOW;
  assert.equal(C.catchUp(calm, [[NOW, 0.001, 0.00103, 0.000995, 0.001]]), null);
  assert.equal(calm.peak, 0.00103);
});

test('selling: profit after fees, rule breaks and lessons', () => {
  const winner = buy();
  C.closeTrade(winner, {exitPrice: '0.00105', feeling: 'calm'}, NOW + 600000);
  assert.equal(winner.pnlUsd, 0.6);
  assert.equal(winner.exitReason, 'manual');
  assert.equal(winner.followedPlan, true);
  assert.match(winner.lessons[0], /took profit before the target/);
  const holder = buy();
  C.mark(holder, 0.00097, NOW + 60000);
  C.closeTrade(holder, {exitPrice: '0.0009', feeling: 'fomo'}, NOW + 9 * 60000);
  assert.equal(holder.pnlUsd, -3.9);
  assert.equal(holder.exitReason, 'stop');
  assert.deepEqual(holder.ruleBreaks, ['Held 8 min past your stop']);
  assert.equal(holder.followedPlan, false);
  assert.match(holder.lessons.join(' '), /FOMO/);
  assert.throws(() => C.closeTrade(holder, {exitPrice: '0.001'}, NOW), /isn't open/);
  assert.throws(() => C.closeTrade(buy(), {exitPrice: '0.001', feeling: 'happy'}, NOW), /Pick how you felt/);
});

test('journal: stats and the daily debrief', () => {
  const trades = [closed(3, 60, {feeling: 'calm', verdict: 'pass'}), closed(-2, 50, {feeling: 'fomo', verdict: 'skip', followedPlan: false, ruleBreaks: ['Bought a coin the coach said to skip']}),
    closed(1.5, 40, {exitReason: 'stop'}), closed(-1, 24 * 60 + 10)];
  const stats = C.stats(trades);
  assert.equal(stats.closes, 4);
  assert.equal(stats.netUsd, 1.5);
  assert.equal(stats.winRatePct, 50);
  assert.equal(stats.followedNetUsd, 3.5);
  assert.equal(stats.brokeNetUsd, -2);
  assert.equal(stats.byFeeling.fomo.netUsd, -2);
  assert.deepEqual(C.stats([]), {closes: 0});
  const review = C.review(trades, NOW);
  assert.equal(review.closes, 3);
  assert.equal(review.netUsd, 2.5);
  assert.equal(review.tomorrow, 'Respect Skip it. Close the chart and find the next coin.');
  assert.equal(C.review([], NOW).closes, 0);
  const held = C.review([closed(-3, 30, {ruleBreaks: ['Held 12 min past your stop'], followedPlan: false})], NOW);
  assert.equal(held.tomorrow, 'Sell the moment Scout says SELL NOW. Hoping is not a plan.');
});

test('GeckoTerminal backup: chain from the pool id, price from either side of the pool', () => {
  assert.equal(C.geckoChain('eth_0xabc'), 'ethereum');
  assert.equal(C.geckoChain('solana_' + POOL), 'solana');
  assert.equal(C.geckoChain('polygon_pos_0xabc'), null);
  const pool = {attributes: {address: POOL, base_token_price_usd: '0.0021', quote_token_price_usd: '150.5'},
    relationships: {base_token: {data: {id: 'solana_' + SOL}}, quote_token: {data: {id: 'solana_' + USDC}}}};
  assert.equal(C.poolPrice(pool, 'solana', SOL), 0.0021);
  assert.equal(C.poolPrice(pool, 'solana', USDC), 150.5);
  assert.equal(C.poolPrice(pool, 'solana', POOL), null);
  const evm = {attributes: {base_token_price_usd: '0.005'}, relationships: {base_token: {data: {id: 'eth_' + EVM.toUpperCase().replace('0X', '0x')}}}};
  assert.equal(C.poolPrice(evm, 'ethereum', EVM), 0.005);
});

// Discover: coin database, signals, feed and alerts -------------------------------------
const PREFS = C.alertSettings({});
function coin(overrides, marketOverrides) {
  const rec = C.trackCoin(null, {...market(), ...marketOverrides}, NOW);
  return Object.assign(rec, overrides || {});
}

test('alert settings and narratives stay inside their limits', () => {
  assert.deepEqual(C.alertSettings({}), C.ALERT_DEFAULTS);
  const custom = C.alertSettings({catalyst: false, strength: 9, minLiquidity: -5, narratives: 'AI, ai ,  Dog,,x'});
  assert.equal(custom.catalyst, false);
  assert.equal(custom.strength, 4);
  assert.equal(custom.minLiquidity, 10000);
  assert.deepEqual(C.narrativeList(custom.narratives), ['ai', 'dog']);
});

test('the coin database tracks price history, peak and low', () => {
  let rec = C.trackCoin(null, market({price: 0.001}), NOW);
  rec = C.trackCoin(rec, market({price: 0.002}), NOW + 30000);
  rec = C.trackCoin(rec, market({price: 0.0009}), NOW + 60000);
  rec = C.trackCoin(rec, market({price: 0.00095}), NOW + 70000);
  assert.equal(rec.peak, 0.002);
  assert.equal(rec.low, 0.0009);
  assert.equal(rec.history.length, 3, 'readings closer than 20 seconds replace the last one');
  assert.equal(rec.history[2][1], 0.00095);
  const gecko = C.trackCoin(rec, market({hasSocials: null}), NOW + 90000);
  assert.equal(gecko.market.hasSocials, true, 'an unknown socials reading keeps the last known one');
});

test('catalysts: volume spikes, buyer rushes, takeovers and narratives add up', () => {
  const quiet = C.signals(coin({}, {volume5m: 500, volume1h: 6000, buys5m: 10, sells5m: 8, change1h: 2}), PREFS, NOW);
  assert.equal(quiet.score, 0);
  assert.equal(quiet.strong, false);
  const hot = C.signals(coin({tags: {cto: true, description: 'The first AI agent on Solana'}}, {volume5m: 30000, volume1h: 40000, buys5m: 120, sells5m: 30}), PREFS, NOW);
  assert.equal(hot.score, 7);
  assert.equal(hot.strong, true);
  assert.match(hot.reasons.join(' '), /Volume spike: \$30K in 5 minutes, 9\.0× its pace/);
  assert.match(hot.reasons.join(' '), /narrative you follow: "ai"/);
  const thin = C.signals(coin({tags: {cto: true}}, {liquidity: 4000, volume5m: 30000, volume1h: 40000, buys5m: 120, sells5m: 30}), PREFS, NOW);
  assert.equal(thin.strong, false);
  assert.match(thin.risky, /Only \$4\.0K in the pool/);
  const trap = C.signals(coin({tags: {cto: true}}, {volume5m: 30000, volume1h: 40000, buys5m: 120, sells5m: 1}), PREFS, NOW);
  assert.match(trap.risky, /honeypot/);
  assert.equal(C.signals(coin({name: 'Catwalk'}, {buys5m: 10, sells5m: 8}), {...PREFS, narratives: 'cat'}, NOW).score, 0, 'short words match whole words only');
  assert.equal(C.signals(coin({name: 'Agentic Dog'}, {buys5m: 10, sells5m: 8}), {...PREFS, narratives: 'agent'}, NOW).score, 2, 'longer words match the start of a word');
});

test('comebacks: from the 24-hour change, or from what Scout watched', () => {
  const bounce = C.signals(coin({}, {change24h: -60, change1h: 25, change5m: 3, buys5m: 50, sells5m: 30}), PREFS, NOW);
  assert.match(bounce.comeback, /Fell 60% over 24 hours, now up 25%/);
  let rec = C.trackCoin(null, market({price: 0.002, change24h: 5}), NOW);
  rec = C.trackCoin(rec, market({price: 0.0008, change24h: 5}), NOW + 60000);
  rec = C.trackCoin(rec, market({price: 0.0011, change5m: 4, change24h: 5}), NOW + 120000);
  assert.match(C.signals(rec, PREFS, NOW + 120000).comeback, /Dropped 60% from its high while Scout watched, now 38% back up/);
  const falling = C.signals(coin({}, {change24h: -60, change1h: 25, change5m: -2}), PREFS, NOW);
  assert.equal(falling.comeback, null);
});

test('feed filters, search and alert limits', () => {
  const hot = coin({key: 'solana:hot', symbol: 'HOT', tags: {cto: true}}, {volume5m: 30000, volume1h: 40000, buys5m: 120, sells5m: 30});
  const back = coin({key: 'solana:back', symbol: 'BACK', createdAt: NOW - 600000}, {change24h: -60, change1h: 25, change5m: 3, buys5m: 50, sells5m: 30, volume1h: 900});
  const plain = coin({key: 'base:plain', chain: 'base', symbol: 'PLAIN'}, {});
  const ctx = {chain: 'solana', watch: ['solana:back'], signals: rec => C.signals(rec, PREFS, NOW)};
  const all = [plain, back, hot];
  assert.deepEqual(C.feed(all, 'foryou', '', ctx).map(rec => rec.symbol), ['HOT', 'BACK']);
  assert.deepEqual(C.feed(all, 'catalysts', '', ctx).map(rec => rec.symbol), ['HOT']);
  assert.deepEqual(C.feed(all, 'comebacks', '', ctx).map(rec => rec.symbol), ['BACK']);
  assert.deepEqual(C.feed(all, 'watch', '', ctx).map(rec => rec.symbol), ['BACK']);
  assert.deepEqual(C.feed(all, 'new', '', ctx).map(rec => rec.symbol), ['BACK', 'HOT']);
  assert.deepEqual(C.feed(all, 'foryou', 'ho', ctx).map(rec => rec.symbol), ['HOT']);
  const sent = {};
  const alerts = C.alertsFor(hot, ctx.signals(hot), PREFS, sent, NOW);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].title, 'HOT: strong catalyst (5)');
  sent['solana:hot|catalyst'] = NOW - 3600000;
  assert.equal(C.alertsFor(hot, ctx.signals(hot), PREFS, sent, NOW).length, 0, 'no repeat within two hours');
  assert.equal(C.alertsFor(hot, ctx.signals(hot), {...PREFS, catalyst: false}, {}, NOW).length, 0);
  assert.equal(C.alertsFor(back, ctx.signals(back), PREFS, {}, NOW)[0].kind, 'comeback');
});
