// Scout for iPad · click-through test in a real browser with made-up market data.
// Run locally: node scout-ipad-tests/ui-smoke.cjs [screenshot-folder]
// Needs Playwright (npm i -g playwright, or set PLAYWRIGHT_MODULE).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {execSync} = require('node:child_process');

const playwright = require(process.env.PLAYWRIGHT_MODULE || path.join(execSync('npm root -g').toString().trim(), 'playwright'));
const docs = path.join(__dirname, '..', 'docs');
const shots = process.argv[2] || null;
const SOL = 'So11111111111111111111111111111111111111112';
const POOL = '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2';
const OTHER = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const types = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json'};

function serve() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const name = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
      const file = path.join(docs, name);
      if (!file.startsWith(docs) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, {'content-type': types[path.extname(file)] || 'application/octet-stream'});
      res.end(fs.readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// Made-up Solana addresses: base58 of 32 deterministic bytes.
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes) {
  let n = BigInt('0x' + Buffer.from(bytes).toString('hex')), out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const byte of bytes) { if (byte === 0) out = '1' + out; else break; }
  return out;
}
const fakeAddress = seed => base58(crypto.createHash('sha256').update(seed).digest());

let price = 0.001;
const now = Date.now();
// The Discover universe: 150 coins. Coin 0 has a catalyst, coin 1 is coming back, the rest are ordinary.
const universe = Array.from({length: 150}, (_, i) => {
  const base = {i, symbol: 'COIN' + i, name: 'Coin number ' + i, mint: fakeAddress('mint' + i), pool: fakeAddress('pool' + i),
    price: 0.0001 * (1 + i % 7), liquidity: 15000 + i * 900, cap: 60000 + i * 9000, m5: (i % 9) - 3, h1: (i % 13) - 4, h24: (i % 21) - 6,
    vol5m: 800 + i * 40, vol1h: 12000 + i * 300, buys: 20 + i % 15, sells: 15 + i % 11, age: (i + 1) * 7 * 60000};
  if (i === 0) Object.assign(base, {symbol: 'ROCKET', name: 'Rocket AI Agent', vol5m: 42000, vol1h: 50000, buys: 140, sells: 40, liquidity: 80000});
  if (i === 1) Object.assign(base, {symbol: 'PHOENIX', name: 'Phoenix', h24: -62, h1: 28, m5: 4, buys: 70, sells: 40, liquidity: 45000});
  return base;
});
function dexPair(c) {
  return {chainId: 'solana', dexId: 'raydium', pairAddress: c.pool, baseToken: {address: c.mint, name: c.name, symbol: c.symbol},
    priceUsd: String(c.price), liquidity: {usd: c.liquidity}, volume: {m5: c.vol5m, h1: c.vol1h, h24: c.vol1h * 10},
    priceChange: {m5: c.m5, h1: c.h1, h6: c.h1, h24: c.h24}, txns: {m5: {buys: c.buys, sells: c.sells}}, marketCap: c.cap, fdv: c.cap,
    pairCreatedAt: now - c.age, info: c.i % 3 ? {socials: [{type: 'twitter', url: 'https://x.com/coin' + c.i}]} : {}};
}
function geckoPage(list, page) {
  const start = ((list === 'new_pools' ? 0 : 75) + (page - 1) * 25) % 150;
  const coins = universe.slice(start, start + 25);
  return {data: coins.map(c => ({id: 'solana_' + c.pool, type: 'pool', attributes: {address: c.pool, base_token_price_usd: String(c.price),
    reserve_in_usd: String(c.liquidity), pool_created_at: new Date(now - c.age).toISOString(), market_cap_usd: String(c.cap), fdv_usd: String(c.cap),
    price_change_percentage: {m5: String(c.m5), h1: String(c.h1), h6: String(c.h1), h24: String(c.h24)}, transactions: {m5: {buys: c.buys, sells: c.sells}},
    volume_usd: {m5: String(c.vol5m), h1: String(c.vol1h), h24: String(c.vol1h * 10)}},
    relationships: {base_token: {data: {id: 'solana_' + c.mint, type: 'token'}}, dex: {data: {id: 'raydium'}}}})),
  included: coins.map(c => ({id: 'solana_' + c.mint, type: 'token', attributes: {address: c.mint, symbol: c.symbol, name: c.name, image_url: 'missing.png'}}))};
}
function testPair() {
  return {chainId: 'solana', dexId: 'raydium', pairAddress: POOL, baseToken: {address: SOL, name: 'TEST Coin', symbol: 'TEST'},
    priceUsd: String(price), liquidity: {usd: 40000}, volume: {m5: 6000, h1: 30000, h24: 900000}, priceChange: {m5: 3, h1: 12, h24: 40},
    txns: {m5: {buys: 60, sells: 30}}, marketCap: 400000, fdv: 420000, pairCreatedAt: now - 3 * 3600000, info: {socials: [{type: 'twitter', url: 'https://x.com/test'}]}};
}
function candles() {
  const list = [];
  let close = 0.00093;
  for (let i = 60; i > 0; i--) {
    const open = close;
    close = open * (1 + Math.sin(i / 5) * 0.004 + 0.0012);
    list.push([Math.floor((now - i * 60000) / 1000), open, Math.max(open, close) * 1.002, Math.min(open, close) * 0.998, close, 1000]);
  }
  return {data: {attributes: {ohlcv_list: list.reverse()}}};
}

async function routes(context) {
  await context.route('https://api.dexscreener.com/**', route => {
    const url = route.request().url();
    if (url.includes('/latest/dex/tokens/')) {
      const address = url.split('/').pop(), c = universe.find(item => item.mint === address);
      return route.fulfill({json: {schemaVersion: '1.0.0', pairs: c ? [dexPair(c)] : [testPair()]}});
    }
    if (url.includes('/latest/dex/pairs/')) return route.fulfill({json: {schemaVersion: '1.0.0', pairs: [testPair()]}});
    if (url.includes('/tokens/v1/')) {
      const wanted = new Set(url.split('/').pop().split(','));
      return route.fulfill({json: universe.filter(c => wanted.has(c.mint)).map(dexPair).concat(wanted.has(SOL) ? [testPair()] : [])});
    }
    if (url.includes('/community-takeovers/')) return route.fulfill({json: [{chainId: 'solana', tokenAddress: universe[0].mint, description: 'Community took over the first AI agent coin',
      links: [{type: 'twitter', url: 'https://x.com/rocket'}]}]});
    if (url.includes('/token-profiles/')) return route.fulfill({json: [{chainId: 'solana', tokenAddress: universe[5].mint, description: 'A friendly dog', links: [{label: 'Website', url: 'https://example.com'}]}]});
    if (url.includes('/token-boosts/')) return route.fulfill({json: [{chainId: 'solana', tokenAddress: universe[9].mint, amount: 50, totalAmount: 50}]});
    return route.fulfill({json: []});
  });
  await context.route('https://api.rugcheck.xyz/**', route => route.fulfill({json: {mint: route.request().url().split('/tokens/')[1].split('/')[0], risks: [], creatorTokens: [{mint: OTHER}]}}));
  await context.route('https://api.geckoterminal.com/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname.includes('/ohlcv/')) return route.fulfill({json: candles()});
    const list = url.pathname.split('/').pop();
    return route.fulfill({json: geckoPage(list, Number(url.searchParams.get('page') || 1))});
  });
}

async function run() {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await playwright.chromium.launch();
  const problems = [];
  const watch = page => {
    page.on('pageerror', error => problems.push('page error: ' + error.message));
    page.on('console', message => { if (message.type() === 'error') problems.push('console: ' + message.text()); });
  };
  const snap = async (page, name) => {
    // Every screen must read as words: no leaked code values.
    const text = await page.evaluate(() => document.body.innerText);
    const leak = text.match(/\[object \w+\]|\bundefined\b|\bNaN\b|\bnull\b|Infinity/);
    if (leak) problems.push(name + ' shows "' + leak[0] + '"');
    if (shots) await page.screenshot({path: path.join(shots, name + '.png'), fullPage: !/discover|catalysts|coin-page/.test(name)});
  };
  const step = name => console.log('·', name);

  // iPad portrait.
  const context = await browser.newContext({viewport: {width: 820, height: 1180}, deviceScaleFactor: 2, hasTouch: true});
  await routes(context);
  const page = await context.newPage();
  watch(page);
  await page.goto(base);

  // Discover: hundreds of coins, catalysts and comebacks.
  await page.waitForFunction(() => document.querySelectorAll('.coin-card:not(.skeleton)').length >= 100, null, {timeout: 20000});
  const count = await page.$$eval('.coin-card', list => list.length);
  await page.waitForSelector('#signal-pop:not([hidden])', {timeout: 10000});
  const pop = await page.textContent('#signal-pop');
  if (!/ROCKET/.test(pop)) problems.push('first alert was about: ' + pop);
  const first = await page.textContent('.coin-card');
  if (!/ROCKET/.test(first)) problems.push('For you should lead with the catalyst coin, got: ' + first.slice(0, 40));
  await snap(page, '01-discover');
  step(`discover: ${count} cards, alert "${pop.slice(0, 40)}…"`);

  await page.click('#disc-filters [data-filter="comebacks"]');
  const comebacks = await page.$$eval('.cc-title b', list => list.map(item => item.textContent));
  if (!comebacks.includes('PHOENIX')) problems.push('Comebacks filter shows: ' + comebacks.join(', '));
  await page.click('#disc-filters [data-filter="catalysts"]');
  await snap(page, '02-catalysts');
  await page.click('.coin-card[data-signal="catalyst"]');
  await page.waitForSelector('#sheet:not([hidden]) .why');
  await page.waitForTimeout(400);
  const why = await page.textContent('.why');
  if (!/Community takeover/.test(why) || !/Volume spike/.test(why)) problems.push('coin page reasons: ' + why);
  await snap(page, '03-coin-page');
  await page.click('.sheet-actions button:has-text("Watch")');
  await page.click('.sheet-top .icon-button');
  await page.click('#disc-filters [data-filter="watch"]');
  const watched = await page.$$eval('.coin-card', list => list.length);
  if (watched !== 1) problems.push('watchlist shows ' + watched + ' coins');
  await page.click('#disc-filters [data-filter="foryou"]');
  await page.fill('#disc-search', 'COIN12');
  await page.waitForTimeout(300);
  const found = await page.$$eval('.cc-title b', list => list.map(item => item.textContent));
  if (!found.length || found.some(name => !name.startsWith('COIN12'))) problems.push('search found: ' + found.join(', '));
  await page.fill('#disc-search', '');
  step('filters, coin page, watchlist, search');

  await page.click('.tabbar [data-go="alerts"]');
  await page.waitForSelector('.inbox-row');
  const alertCount = await page.$$eval('.inbox-row', list => list.length);
  await snap(page, '04-alerts');
  step('alerts: ' + alertCount);

  // Trade journey.
  await page.click('.tabbar [data-go="trade"]');
  await page.waitForSelector('#ca');
  await page.fill('#ca', 'https://dexscreener.com/solana/' + SOL);
  await page.click('button[type=submit]');
  await page.waitForSelector('.verdict[data-code="pass"]', {timeout: 15000});
  await page.waitForSelector('#check-actions:not([hidden])');
  await page.waitForTimeout(300);
  await snap(page, '05-check');
  await page.click('text=Plan this trade →');
  await page.waitForSelector('.plan');
  const size = await page.textContent('.plan-size-value');
  await snap(page, '06-plan');
  await page.click('text=I bought it →');
  await page.waitForSelector('form.buy');
  await page.fill('#buy-size', '80');
  await page.waitForSelector('#buy-why');
  await page.click('text=Start watching');
  const error = await page.textContent('#buy-error');
  if (!/breaks your rules/.test(error)) problems.push('rule break was not caught: ' + error);
  await page.fill('#buy-size', size.replace(/[$,]/g, ''));
  await page.waitForFunction(() => !document.querySelector('#buy-why'));
  await page.click('text=Start watching');
  await page.waitForSelector('.live-card');
  await snap(page, '07-live');
  step('check, plan, buy (' + size + ')');

  price = 0.00096;
  await page.waitForSelector('#alert:not([hidden])', {timeout: 20000});
  const alertTitle = await page.textContent('#alert-title');
  if (alertTitle !== 'Sell now') problems.push('alert said ' + alertTitle);
  await snap(page, '08-sell-alarm');
  await page.click('#alert-sold');
  await page.waitForSelector('.close-form:not([hidden])');
  await page.click('.close-form .chip:has-text("Scared")');
  await page.click('text=Save and review');
  await page.waitForSelector('.review');
  await snap(page, '09-review');
  await page.click('.tabbar [data-go="journal"]');
  await page.waitForSelector('#journal-body .card');
  await snap(page, '10-journal');
  await page.click('#rules-button');
  await page.waitForSelector('.presets');
  await page.fill('#rule-bankrollUsd', '287');
  await page.press('#rule-bankrollUsd', 'Tab');
  await page.waitForTimeout(200);
  const summary = await page.textContent('#money-summary');
  if (!summary.includes('$2.87')) problems.push('rules summary did not update: ' + summary);
  await snap(page, '11-rules');
  step('sell alarm, review, journal, rules');

  const saved = await page.evaluate(() => ({data: JSON.parse(localStorage.getItem('scout-ipad-v1')), coins: Object.keys(JSON.parse(localStorage.getItem('scout-ipad-coins-v1')).coins).length}));
  if (saved.data.trades.length !== 1 || saved.data.trades[0].status !== 'closed' || saved.data.rules.bankrollUsd !== 287) problems.push('saved data is wrong');
  if (saved.coins < 100 || saved.data.watch.length !== 1) problems.push(`coin database saved ${saved.coins} coins, watchlist ${saved.data.watch.length}`);
  await context.close();

  // iPad landscape: Discover with the live rail, after a reload with an open trade.
  const wide = await browser.newContext({viewport: {width: 1180, height: 820}, deviceScaleFactor: 2, hasTouch: true});
  await routes(wide);
  price = 0.001;
  const second = await wide.newPage();
  watch(second);
  await second.goto(base);
  await second.evaluate(([mint, pool]) => {
    const t = Date.now();
    localStorage.setItem('scout-ipad-v1', JSON.stringify({trades: [{id: 'abcdef123456', status: 'open', chain: 'solana', address: mint, pair: pool, symbol: 'TEST',
      openedAt: t - 600000, entryPrice: 0.00098, sizeUsd: 28, stopPct: 2, targetPct: 7, trailingPct: null, holdMinutes: 30, costPct: 3.1, verdict: 'pass',
      ruleBreaks: [], mark: 0.00099, markAt: t - 5000, peak: 0.001, signal: 'hold', samples: [[t - 600000, 0.00098], [t - 300000, 0.000995], [t - 5000, 0.00099]]}]}));
  }, [SOL, POOL]);
  await second.goto(base + '?seeded=1#discover');
  await second.waitForSelector('.side-card');
  await second.waitForFunction(() => document.querySelectorAll('.coin-card:not(.skeleton)').length >= 50, null, {timeout: 20000});
  await snap(second, '12-landscape-discover');
  await second.click('.tabbar [data-go="live"]');
  await second.waitForSelector('.live-card');
  await snap(second, '13-landscape-live');
  step('landscape');
  await wide.close();

  // DexScreener unreachable: the GeckoTerminal backup still finds the coin.
  const backup = await browser.newContext({viewport: {width: 820, height: 1180}});
  await routes(backup);
  await backup.route('https://api.dexscreener.com/**', route => route.abort('failed'));
  await backup.route('https://api.geckoterminal.com/api/v2/search/**', route => route.fulfill({json: geckoPage('new_pools', 1)}));
  const fourth = await backup.newPage();
  fourth.on('pageerror', error => problems.push('page error: ' + error.message));
  await fourth.goto(base + '#trade');
  await fourth.fill('#ca', universe[3].mint);
  await fourth.click('button[type=submit]');
  await fourth.waitForSelector('#check-actions:not([hidden])', {timeout: 15000});
  const backupSymbol = await fourth.textContent('.coin-symbol');
  if (!backupSymbol.startsWith('COIN3')) problems.push('backup lookup found ' + backupSymbol);
  await fourth.click('.tabbar [data-go="discover"]');
  await fourth.waitForFunction(() => document.querySelectorAll('.coin-card:not(.skeleton)').length >= 25, null, {timeout: 20000});
  step('backup source: ' + backupSymbol.replace(/SOLANA$/, '').trim() + ', Discover still fills');
  await backup.close();

  // Phone width (iPad Split View is about this narrow).
  const narrow = await browser.newContext({viewport: {width: 390, height: 844}, deviceScaleFactor: 2, hasTouch: true});
  await routes(narrow);
  const third = await narrow.newPage();
  watch(third);
  await third.goto(base);
  await third.waitForFunction(() => document.querySelectorAll('.coin-card:not(.skeleton)').length >= 50, null, {timeout: 20000});
  let overflow = await third.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 0) problems.push('narrow Discover scrolls sideways by ' + overflow + 'px');
  await snap(third, '14-narrow-discover');
  await third.click('.coin-card');
  await third.waitForSelector('#sheet:not([hidden]) .why');
  await snap(third, '15-narrow-coin-page');
  await third.click('.sheet-actions button:has-text("Check it with my rules")');
  await third.waitForSelector('#check-actions:not([hidden])', {timeout: 15000});
  overflow = await third.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 0) problems.push('narrow check scrolls sideways by ' + overflow + 'px');
  step('narrow');
  await narrow.close();

  await browser.close();
  server.close();
  if (problems.length) {
    console.error('PROBLEMS:\n' + problems.join('\n'));
    process.exit(1);
  }
  console.log('UI smoke test passed.');
}
run().catch(error => { console.error(error); process.exit(1); });
