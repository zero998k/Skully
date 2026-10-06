// Scout for iPad · click-through test in a real browser with made-up market data.
// Run locally: node scout-ipad-tests/ui-smoke.cjs [screenshot-folder]
// Needs Playwright (npm i -g playwright, or set PLAYWRIGHT_MODULE).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
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

let price = 0.001;
const now = Date.now();
function pair(address, pool, symbol, extra) {
  return {chainId: 'solana', dexId: 'raydium', url: 'https://dexscreener.com/solana/' + pool, pairAddress: pool,
    baseToken: {address, name: symbol + ' Coin', symbol}, quoteToken: {address: OTHER, symbol: 'SOL'},
    priceUsd: String(price), liquidity: {usd: 40000}, volume: {m5: 6000, h24: 900000}, priceChange: {m5: 3, h1: 12, h24: 40},
    txns: {m5: {buys: 60, sells: 30}}, marketCap: 400000, fdv: 420000, pairCreatedAt: now - 3 * 3600000,
    info: {socials: [{type: 'twitter', url: 'https://x.com/test'}]}, ...extra};
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
function gecko() {
  const rows = [['GOOD', SOL, POOL, 55000, 600000, 3600000 * 5], ['TINY', OTHER, '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', 3000, 40000, 900000]];
  return {data: rows.map(([symbol, address, pool, liquidity, cap, age]) => ({id: 'solana_' + pool, type: 'pool', attributes: {address: pool, base_token_price_usd: '0.0012',
    reserve_in_usd: String(liquidity), pool_created_at: new Date(now - age).toISOString(), market_cap_usd: String(cap), fdv_usd: String(cap),
    price_change_percentage: {m5: '2.5', h1: '9'}, transactions: {m5: {buys: 50, sells: 30}}, volume_usd: {m5: '7000'}},
    relationships: {base_token: {data: {id: 'solana_' + address, type: 'token'}}, dex: {data: {id: 'raydium'}}}})),
  included: rows.map(([symbol, address]) => ({id: 'solana_' + address, type: 'token', attributes: {address, symbol, name: symbol + ' Coin', image_url: 'missing.png'}}))};
}

async function routes(context) {
  await context.route('https://api.dexscreener.com/**', route => {
    const url = route.request().url();
    if (url.includes('/latest/dex/tokens/')) return route.fulfill({json: {schemaVersion: '1.0.0', pairs: [pair(SOL, POOL, 'TEST')]}});
    if (url.includes('/latest/dex/pairs/')) return route.fulfill({json: {pairs: [pair(SOL, POOL, 'TEST')]}});
    return route.fulfill({json: []});
  });
  await context.route('https://api.rugcheck.xyz/**', route => route.fulfill({json: {mint: SOL, risks: [], creatorTokens: [{mint: OTHER}]}}));
  await context.route('https://api.geckoterminal.com/**', route => {
    const url = route.request().url();
    return route.fulfill({json: url.includes('/ohlcv/') ? candles() : gecko()});
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
    if (shots) await page.screenshot({path: path.join(shots, name + '.png'), fullPage: true});
  };
  const step = (name) => console.log('·', name);

  // iPad portrait: the whole trade journey.
  const context = await browser.newContext({viewport: {width: 820, height: 1180}, deviceScaleFactor: 2, hasTouch: true});
  await routes(context);
  const page = await context.newPage();
  watch(page);
  await page.goto(base);
  await page.waitForSelector('#ca');
  await snap(page, '01-find');
  step('find');

  await page.fill('#ca', 'https://dexscreener.com/solana/' + SOL);
  await page.click('button[type=submit]');
  await page.waitForSelector('.verdict[data-code="pass"]', {timeout: 15000});
  await page.waitForSelector('#check-actions:not([hidden])');
  await page.waitForTimeout(300);
  const verdict = await page.textContent('.verdict h2');
  if (verdict !== 'Fits your rules') problems.push('verdict was ' + verdict);
  const rows = await page.$$eval('.check-row', list => list.map(row => row.dataset.status + ' ' + row.querySelector('b').firstChild.textContent));
  if (!rows.includes('pass Contract scan')) problems.push('contract scan row missing: ' + rows.join(', '));
  await snap(page, '02-check');
  step('check: ' + verdict + ', ' + rows.length + ' rows');

  await page.click('text=Plan this trade →');
  await page.waitForSelector('.plan');
  const size = await page.textContent('.plan-size-value');
  await page.waitForTimeout(500);
  await snap(page, '03-plan');
  step('plan: buy ' + size);

  await page.click('text=I bought it →');
  await page.waitForSelector('form.buy');
  await page.fill('#buy-size', '80');
  await page.waitForSelector('#buy-why');
  await snap(page, '04-buy-rule-break');
  await page.click('text=Start watching');
  const error = await page.textContent('#buy-error');
  if (!/breaks your rules/.test(error)) problems.push('rule break was not caught: ' + error);
  await page.fill('#buy-size', size.replace(/[$,]/g, ''));
  await page.waitForFunction(() => !document.querySelector('#buy-why'));
  await page.click('text=Start watching');
  await page.waitForSelector('.live-card');
  await page.waitForTimeout(500);
  await snap(page, '05-live');
  step('live');

  price = 0.00096;
  await page.waitForSelector('#alert:not([hidden])', {timeout: 20000});
  const alertTitle = await page.textContent('#alert-title');
  if (alertTitle !== 'Sell now') problems.push('alert said ' + alertTitle);
  await snap(page, '06-alert');
  step('alert: ' + alertTitle);

  await page.click('#alert-sold');
  await page.waitForSelector('.close-form:not([hidden])');
  await page.click('.close-form .chip:has-text("Scared")');
  await page.fill('.close-form textarea', 'Sold when Scout said so.');
  await snap(page, '07-sell-form');
  await page.click('text=Save and review');
  await page.waitForSelector('.review');
  const review = await page.textContent('.review h2');
  await snap(page, '08-review');
  step('review: ' + review);

  await page.click('.tabbar [data-go="journal"]');
  await page.waitForSelector('#journal-body .card');
  await snap(page, '09-journal');
  await page.click('.tabbar [data-go="rules"]');
  await page.waitForSelector('.presets');
  await page.click('.preset:has-text("Goal")');
  await page.fill('#rule-bankrollUsd', '287');
  await page.press('#rule-bankrollUsd', 'Tab');
  await page.waitForTimeout(200);
  const summary = await page.textContent('#money-summary');
  if (!summary.includes('$2.87')) problems.push('rules summary did not update: ' + summary);
  await snap(page, '10-rules');
  await page.click('.tabbar [data-go="radar"]');
  await page.waitForSelector('.radar-row:not(.skeleton)');
  await snap(page, '11-radar');
  step('journal, rules, radar');

  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('scout-ipad-v1')));
  if (saved.trades.length !== 1 || saved.trades[0].status !== 'closed' || saved.rules.bankrollUsd !== 287) problems.push('saved data is wrong');
  await context.close();

  // iPad landscape: the live rail beside the trade flow, after a reload with an open trade.
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
  await second.goto(base + '?seeded=1#trade');
  await second.waitForSelector('.side-card');
  await snap(second, '12-landscape-find');
  await second.click('.tabbar [data-go="live"]');
  await second.waitForSelector('.live-card');
  await second.waitForTimeout(9500);
  await snap(second, '13-landscape-live');
  step('landscape');
  await wide.close();

  // DexScreener unreachable: the GeckoTerminal backup still finds the coin and its price.
  const backup = await browser.newContext({viewport: {width: 820, height: 1180}});
  await routes(backup);
  await backup.route('https://api.dexscreener.com/**', route => route.abort('failed'));
  await backup.route('https://api.geckoterminal.com/api/v2/search/**', route => route.fulfill({json: gecko()}));
  const fourth = await backup.newPage();
  fourth.on('pageerror', error => problems.push('page error: ' + error.message));
  await fourth.goto(base);
  await fourth.fill('#ca', SOL);
  await fourth.click('button[type=submit]');
  await fourth.waitForSelector('#check-actions:not([hidden])', {timeout: 15000});
  const backupSymbol = await fourth.textContent('.coin-symbol');
  if (!backupSymbol.startsWith('GOOD')) problems.push('backup lookup found ' + backupSymbol);
  await snap(fourth, '15-backup-source');
  step('backup source: ' + backupSymbol.replace(/SOLANA$/, '').trim());
  await backup.close();

  // Phone-width check (iPad Split View is about this narrow).
  const narrow = await browser.newContext({viewport: {width: 390, height: 844}, deviceScaleFactor: 2, hasTouch: true});
  await routes(narrow);
  const third = await narrow.newPage();
  watch(third);
  await third.goto(base);
  await third.fill('#ca', SOL);
  await third.click('button[type=submit]');
  await third.waitForSelector('#check-actions:not([hidden])', {timeout: 15000});
  const overflow = await third.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 0) problems.push('narrow screen scrolls sideways by ' + overflow + 'px');
  await snap(third, '14-narrow-check');
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
