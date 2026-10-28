// Drives the Pulse trading terminal against the fake PumpPortal feed in fake.cjs. Prints a JSON report.
const { chromium } = require('playwright');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const F = (path) => fetch(`http://127.0.0.1:18900${path}`, { method: 'POST' }).then((r) => r.json());
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; for (;;) { const v = await fn().catch(() => false); if (v || Date.now() > end) return v; await sleep(250); } };
(async () => {
  const [E] = process.argv.slice(2);
  for (let i = 0; i < 60 && !(await fetch('http://localhost:7777/').then(() => true).catch(() => false)); i++) await sleep(500);
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1600, height: 1000 } });
  const p = await ctx.newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(String(e)));
  p.on('dialog', (d) => d.accept());
  const R = {};
  const toasts = () => p.locator('#toasts').innerText().catch(() => '');
  await p.goto('http://localhost:7777/'); await sleep(1500);
  R.dashboardHasPulseLink = await p.locator('#pulseLink').count() === 1;
  await p.click('#pulseLink'); await sleep(1500);
  R.feedLive = await until(async () => /LIVE/.test(await p.textContent('#feedChip')), 10000);

  // columns are filled straight away from Pump.fun's lists, before any coin launches
  R.seededStretch = await until(async () => (await p.locator('#list-stretch .card .name b').allInnerTexts()).includes('SEED'), 10000);
  R.seededMigrated = (await p.locator('#list-migrated .card .name b').allInnerTexts()).includes('GRAD');
  R.geckoSeeded = await until(async () => (await p.locator('#list-stretch .card .name b').allInnerTexts()).includes('GKO') && (await p.locator('#list-migrated .card .name b').allInnerTexts()).includes('GKM'), 8000);

  // launches: a bundled + sniped coin, a coin to exclude, one that reaches Final Stretch, one that migrates
  const a = await F('/pp/create?name=Moon%20Cat&symbol=MCAT&dev=dev1&initial=1');
  R.createDelivered = a.delivered;
  await sleep(1700); // let SolBoy subscribe to its trades
  // too late to count as bundled in the real feed timing; to test detection, create a second coin and trade within 1s
  const b2 = await F('/pp/create?name=Bundle%20Pup&symbol=BPUP&dev=dev2&initial=0.5');
  await F(`/pp/trade?mint=${b2.mint}&side=buy&sol=2&wallet=w1&bundle=1&hidden=1`); // same block as the launch: the feed never shows it
  await sleep(1600);
  const r1 = await F(`/pp/trade?mint=${b2.mint}&side=buy&sol=0.4&wallet=w5`);
  R.tradeDelivered = r1.delivered;
  const rug = await F('/pp/create?name=Rug%20Dog&symbol=RUG&dev=dev3&initial=0.2');
  const fin = await F('/pp/create?name=Final%20Frog&symbol=FROG&dev=dev4&initial=1');
  const mig = await F('/pp/create?name=Moved%20Bird&symbol=BIRD&dev=dev5&initial=1');
  await sleep(1700);
  await F(`/pp/trade?mint=${a.mint}&side=buy&sol=1.5&wallet=w2`);
  await F(`/pp/trade?mint=${a.mint}&side=buy&sol=0.8&wallet=w3`);
  await F(`/pp/trade?mint=${fin.mint}&side=buy&sol=55&wallet=whale`); // pushes the curve past 45%
  await F(`/pp/migrate?mint=${mig.mint}`);
  await F('/pp/fund?holder=w2&from=dev1');
  await sleep(2500);
  const col = (c) => p.locator(`#list-${c} .card`).evaluateAll((els) => els.map((e) => e.querySelector('.name b').textContent));
  R.newCol = await col('new'); R.stretchCol = await col('stretch'); R.migratedCol = await col('migrated');
  R.subs = await (await fetch('http://127.0.0.1:18900/pp/subs', { method: 'POST' })).json();
  const mcatCard = p.locator(`.card[data-mint="${a.mint}"]`);
  R.mcatCard = (await mcatCard.innerText()).replace(/\s+/g, ' ');
  R.bpupBundle = (await p.locator(`.card[data-mint="${b2.mint}"] .pct`).allInnerTexts()).join(' | ');
  R.socialLinks = await mcatCard.locator('.soc a').count();
  R.imgEndpoint = await p.evaluate(async (m) => { const r = await fetch(`/api/pulse/img?mint=${m}&t=${TOKEN}`); return `${r.status} ${r.headers.get('content-type')}`; }, a.mint);
  R.imagesShown = await until(async () => (await p.locator('.pic img.ok').count()) >= 3, 6000);
  R.migratedPaid = (await p.locator(`.card[data-mint="${mig.mint}"]`).innerText()).includes('DEX✓');
  // smooth board: while trades and a new launch stream in, existing cards and their pictures are never rebuilt
  await p.evaluate(() => { window.__removed = 0; window.__img = document.querySelector('#list-new .card .pic img');
    for (const l of document.querySelectorAll('.list')) new MutationObserver((ms) => { for (const m of ms) for (const n of m.removedNodes) if (n.classList?.contains('card')) window.__removed++; }).observe(l, { childList: true }); });
  await F(`/pp/trade?mint=${a.mint}&side=buy&sol=0.2&wallet=w7`); await F(`/pp/trade?mint=${b2.mint}&side=buy&sol=0.2&wallet=w8`);
  const late = await F('/pp/create?name=Late%20Launch&symbol=LATE&dev=dev6&initial=0.3'); await sleep(2500);
  R.smooth = await p.evaluate((m) => ({ removed: window.__removed, sameImg: !!window.__img && document.contains(window.__img), entered: !!document.querySelector(`.card[data-mint="${m}"]`) }), late.mint);
  await p.screenshot({ path: `${E}/p1-board.png` });

  // scrolling on a short laptop screen: columns, the filter window and (later) the coin page scroll on their own
  await p.setViewportSize({ width: 1440, height: 430 }); await sleep(400);
  const canScroll = (sel) => p.evaluate((sel) => { const el = document.querySelector(sel); if (!el || el.scrollHeight <= el.clientHeight + 2) return false; el.scrollTop = 40; return el.scrollTop > 0; }, sel);
  R.scrollColumn = await canScroll('#list-new');
  await p.click('[data-filter="new"]'); await p.click('[data-ftab="audit"]'); await sleep(300);
  R.scrollFilters = await canScroll('#filterModal .body');
  await p.keyboard.press('Escape'); await sleep(200);
  await p.setViewportSize({ width: 1600, height: 1000 }); await sleep(300);

  // filters: exclude keyword, dev holding max, presets, reset
  await p.click('[data-filter="new"]'); await sleep(300);
  R.filterTabs = await p.locator('#filterModal [data-ftab]').allInnerTexts();
  await p.fill('[data-kwin="exclude"]', 'rug'); await p.press('[data-kwin="exclude"]', 'Enter');
  await p.click('[data-ftab="audit"]');
  R.auditFields = await p.locator('#filterModal label.f').evaluateAll((els) => els.map((e) => e.childNodes[0].textContent.trim()).filter(Boolean));
  await p.screenshot({ path: `${E}/p2-filters.png` });
  await p.click('#fApply'); await sleep(1800);
  R.rugHiddenByExclude = !(await col('new')).includes('RUG');
  await p.click('[data-filter="new"]'); await p.click('[data-ftab="audit"]');
  await p.fill('[data-path="audit.dev.max"]', '0.5'); await p.click('#fApply'); await sleep(1800);
  R.afterDevMax = await col('new');
  await p.click('[data-filter="new"]'); await p.click('[data-ftab="audit"]'); await p.fill('[data-path="audit.dev.max"]', ''); await p.click('#fApply'); await sleep(1500);
  await p.click('[data-filter="new"]'); await p.click('[data-ftab="metrics"]');
  R.metricFields = await p.locator('#filterModal label.f').evaluateAll((els) => els.map((e) => e.childNodes[0].textContent.trim()));
  await p.click('[data-ftab="socials"]'); await p.click('[data-path="socials.twitter"]');
  await p.click('#fApply'); await sleep(1800);
  R.afterNeedsTwitter = await col('new');
  await p.click('[data-filter="new"]'); await p.click('[data-preset="2"]'); await p.click('#fApply'); await sleep(1800);
  R.preset2ShowsAll = (await col('new')).length >= 3;
  await p.click('[data-filter="new"]'); await p.click('[data-preset="1"]'); await p.click('#fReset'); await p.click('#fApply'); await sleep(1800);
  R.afterReset = await col('new');

  // ✨ Quality: only coins with socials and no red flags (MCAT has X, website and Telegram; RUG and BPUP have none)
  await p.click('[data-quality="new"]'); await sleep(1800);
  R.qualityOn = await col('new');
  await p.click('[data-quality="new"]'); await sleep(1800);
  R.qualityOff = await col('new');

  // quick buy from the card (Jupiter has no route yet: paper prices from the curve)
  await F(`/pp/noroute?mint=${a.mint}`);
  await p.locator(`.card[data-mint="${a.mint}"] [data-qbuy]`).click(); await sleep(1500);
  R.quickBuyToast = (await toasts()).match(/Bought[^\n]*|Buy failed[^\n]*/)?.[0];

  // coin page
  await p.locator(`.card[data-mint="${a.mint}"] .name b`).click(); await sleep(2500);
  R.coinTitle = (await p.locator('#coinHead').innerText()).replace(/\s+/g, ' ').slice(0, 160);
  R.tradesRows = await p.locator('#coinTable tbody tr').count();
  R.devTagInTrades = await p.locator('#coinTable .tag.dev').count();
  R.chartCanvas = await p.locator('#chart canvas').count();
  R.chartMarkers = await p.evaluate(() => markers.map((m) => m.text).join());
  await F(`/pp/trade?mint=${a.mint}&side=buy&sol=0.3&wallet=w4`); await sleep(1200);
  R.liveTradeArrived = (await p.locator('#coinTable tbody tr').count()) > R.tradesRows;
  await p.click('[data-ctab="holders"]'); await sleep(300);
  R.holderRows = await p.locator('#coinTable tbody tr').count();
  R.holderCols = (await p.locator('#coinTable thead th').allInnerTexts()).join('|');
  R.holderFees = /≡ 0\.\d+/.test(await p.locator('#coinTable').innerText());
  R.curveLabelled = (await p.locator('#coinTable').innerText()).includes('Bonding curve');
  await p.click('[data-ctab="early"]'); await sleep(300);
  R.earlyTab = (await p.locator('#coinTable').innerText()).replace(/\s+/g, ' ').slice(0, 200);
  await p.click('#analyze'); await sleep(3500);
  R.analyzeToast = (await toasts()).match(/Checked[^\n]*/)?.[0];
  await p.click('[data-ctab="holders"]'); await sleep(300);
  R.insiderTagged = await p.locator('#coinTable .tag.insider').count();
  await p.setViewportSize({ width: 1440, height: 560 }); await sleep(400);
  R.scrollCoinSide = await p.evaluate(() => { const el = document.querySelector('#coinSide'); el.scrollTop = 60; return el.scrollTop > 0; });
  R.scrollCoinTable = await p.evaluate(() => { const el = document.querySelector('#coinTable'); return el.clientHeight > 0 && el.clientHeight < window.innerHeight; });
  await p.setViewportSize({ width: 1600, height: 1000 }); await sleep(300);
  R.gauges = await p.locator('.gauge').count();
  R.windowsShown = (await p.locator('#coinSide .wtabs button').count()) === 4 && /Vol/.test(await p.locator('#coinSide .wins').innerText());
  await p.click('#coinSide [data-win="h1"]'); await sleep(200);
  R.windowSwitch = await p.locator('#coinSide [data-win="h1"].on').count() === 1;
  R.securityShown = await until(async () => (await p.locator('#coinSide').innerText()).includes('Revoked ✓'), 6000);
  await p.click('[data-ctab="trades"]'); await sleep(300); R.sizeIcons = await p.locator('#coinTable .sz').count() > 0; await p.click('[data-ctab="holders"]'); await sleep(300);
  R.positionShown = (await p.locator('#sideTrade [data-pos]').innerText()).replace(/\s+/g, ' ');
  await p.click('#sideTrade [data-qsellpct="2"]'); await sleep(1500); // one click: sell 50%
  R.sellToast = (await toasts()).match(/Sold[^\n]*|Sell failed[^\n]*/)?.[0];
  // the Axiom-style box: one-click buy, sell a SOL amount, sell the initial, presets, edit, USD
  await p.click('#sideTrade [data-qbuy="0"]'); await sleep(1500);
  R.qtBuy = (await toasts()).match(/Bought 0\.05[^\n]*/)?.[0] ?? null;
  await p.click('#sideTrade [data-qsellsol="0"]'); await sleep(1500);
  R.qtSellSol = /Sold for/.test(await toasts());
  R.qtFoot = (await p.locator('#sideTrade .qt-foot').innerText()).replace(/\s+/g, ' ');
  await p.click('#sideTrade [data-qinit]'); await sleep(1500);
  R.qtInit = /Sold for/.test(await toasts());
  await p.click('#sideTrade [data-qp="2"]'); await sleep(200);
  R.qtP2 = (await p.locator('#sideTrade [data-qbuy]').allInnerTexts()).join();
  await p.click('#sideTrade [data-qedit]'); await p.fill('#sideTrade [data-qedit-buy="0"]', '0.07'); await p.click('#sideTrade [data-qedit]'); await sleep(200);
  R.qtEdited = (await p.locator('#sideTrade [data-qbuy="0"]').innerText()).trim();
  await p.click('#sideTrade [data-qcur="usd"]'); await sleep(200);
  R.qtUsd = (await p.locator('#sideTrade [data-qbuyusd]').allInnerTexts()).join();
  await p.click('#sideTrade [data-qcur="sol"]'); await p.click('#sideTrade [data-qp="1"]'); await sleep(200);
  await p.screenshot({ path: `${E}/p3-coin.png` });

  // floating quick trade box: open, drag, pop out
  await p.click('#quickBtn'); await sleep(300);
  R.floatVisible = await p.isVisible('#floating');
  const box1 = await p.locator('#floating').boundingBox();
  await p.mouse.move(box1.x + 40, box1.y + 15); await p.mouse.down(); await p.mouse.move(box1.x - 300, box1.y + 200, { steps: 8 }); await p.mouse.up();
  const box2 = await p.locator('#floating').boundingBox();
  R.dragged = Math.round(box1.x - box2.x) > 200 && Math.round(box2.y - box1.y) > 150;
  R.floatCoin = await p.locator('#floating .drag b').innerText();
  const [popup] = await Promise.all([ctx.waitForEvent('page'), p.click('#popOut')]);
  await popup.waitForLoadState(); await sleep(1500);
  R.popupQuickMode = await popup.evaluate(() => document.body.classList.contains('quick-mode'));
  R.popupCoin = await popup.locator('.drag b').innerText();
  R.popupHasBuy = await popup.locator('[data-qbuy]').count() === 4 && await popup.locator('[data-qsellpct]').count() === 4;
  await popup.screenshot({ path: `${E}/p4-popout.png` });
  await popup.close();

  // a coin whose bundled launch buy the feed missed: opening it runs the on-chain launch check
  await p.click('#back'); await sleep(800);
  await p.goto(`http://localhost:7777/pulse#coin=${b2.mint}`); await sleep(7000);
  await p.click('[data-ctab="early"]'); await sleep(300);
  R.bundleFoundOnChain = (await p.locator('#coinTable').innerText()).includes('BUNDLE');
  R.bundleChip = await p.evaluate(async (m) => (await (await fetch(`/api/pulse/coin?mint=${m}&t=${TOKEN}`)).json()).bundle, b2.mint);

  // a coin SolBoy didn't see launch: the page opens straight away and fills with its recent trades
  await p.click('#back').catch(() => {}); await sleep(500);
  const seedCard = p.locator('#list-stretch .card', { hasText: 'SEED' }).first();
  const t0 = Date.now(); await seedCard.locator('.name b').click();
  await until(async () => /SEED/.test(await p.locator('#coinHead').innerText()), 5000); R.seedHeadMs = Date.now() - t0;
  await p.click('[data-ctab="trades"]').catch(() => {});
  R.seedTradesRows = await until(async () => (await p.locator('#coinTable tbody tr').count()) >= 20, 6000) ? await p.locator('#coinTable tbody tr').count() : await p.locator('#coinTable tbody tr').count();
  R.seedChart = await p.evaluate(() => !document.getElementById('chartMsg') || document.getElementById('chartMsg').hidden);

  // a coin the feed never showed: details from Helius, trades and chart read from the chain
  const ghost = await F('/pp/create?name=Ghost%20Coin&symbol=GHST&dev=dev8&initial=0.6&hidden=1');
  for (const [i, w] of ['g1', 'g2', 'g3', 'g4'].entries()) await F(`/pp/trade?mint=${ghost.mint}&side=buy&sol=${0.3 + i * 0.2}&wallet=${w}&hidden=1`);
  await p.goto(`http://localhost:7777/pulse#coin=${ghost.mint}`); await sleep(500); await p.click('[data-ctab="trades"]').catch(() => {});
  R.ghostTrades = await until(async () => (await p.locator('#coinTable tbody tr').count()) >= 4, 10000) ? await p.locator('#coinTable tbody tr').count() : await p.locator('#coinTable tbody tr').count();
  R.ghostNamed = /SolBoy Cat|BOYZ|GHST/.test(await p.locator('#coinHead').innerText());
  R.ghostChart = await p.evaluate(() => !document.getElementById('chartMsg') || document.getElementById('chartMsg').hidden);

  // a migrated coin: its price comes straight from the pool's vaults on the chain, trade by trade
  await p.goto(`http://localhost:7777/pulse#coin=${mig.mint}`); await sleep(4000); await p.click('[data-ctab="trades"]'); await sleep(300);
  const coinApi = (m) => p.evaluate(async (m) => (await (await fetch(`/api/pulse/coin?mint=${m}&t=${TOKEN}`)).json()), m);
  R.poolSource = await until(async () => (await coinApi(mig.mint)).priceSource === 'pool', 12000) ? 'pool' : (await coinApi(mig.mint)).priceSource;
  const before = (await coinApi(mig.mint)).mcSol;
  const amm = await F(`/pp/amm?mint=${mig.mint}&side=buy&sol=3`); R.poolNotified = amm.sent;
  R.poolTradeShown = await until(async () => (await p.locator('#coinTable').innerText()).includes('pool trade'), 5000);
  const after = (await coinApi(mig.mint)).mcSol;
  R.poolMcMoved = after > before && Math.abs(after - amm.mcSol) / amm.mcSol < 0.01;
  R.poolBadge = (await p.locator('#coinHead').innerText()).includes('live (pool)');
  R.poolMcUsd = Math.round((await coinApi(mig.mint)).mcUsd);
  for (let i = 0; i < 3; i++) { await F(`/pp/trade?mint=${a.mint}&side=buy&sol=0.1&wallet=w6`); await sleep(9000); }
  R.delayChip = await until(async () => /behind chain/.test(await p.textContent('#delayChip')), 15000) ? (await p.textContent('#delayChip')).trim() : (await p.textContent('#delayChip'));

  // real money: a coin Jupiter can't route yet goes through PumpPortal's transaction builder
  const live = await p.evaluate(async (mint) => {
    const call = async (path, body) => { const r = await fetch(`${path}?t=${TOKEN}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
    await call('/api/account/create', {});
    await fetch('http://127.0.0.1:18900/set?sol=2', { method: 'POST' }).catch(() => {});
    return mint;
  }, a.mint);
  await F('/set?sol=2'); await sleep(11000); // the balance is cached for 10s
  R.liveBuy = await p.evaluate(async (mint) => {
    const call = async (path, body) => { const r = await fetch(`${path}?t=${TOKEN}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
    const mode = await call('/api/account/mode', { mode: 'live', confirm: true });
    const buy = await call('/api/pulse/trade', { mint, side: 'buy', sol: 0.2 });
    const sell = await call('/api/pulse/trade', { mint, side: 'sell', percent: 100 });
    const back = await call('/api/account/mode', { mode: 'paper' });
    return { mode: mode.status, buy: buy.body, sell: sell.body, back: back.status };
  }, live);
  R.tradeLocal = (await (await fetch('http://127.0.0.1:18903/pp/tradelocal')).json()).map((x) => `${x.action}:${x.denominatedInSol}:${x.pool}`);

  // the story behind a coin: its X post on the card and a bigger look on hover; on its page the post, website and an AI one-liner
  await p.click('#back').catch(() => {}); await sleep(600);
  const twt = await F('/pp/create?name=Tweet%20Cat&symbol=TWT&dev=dev7&initial=0.4');
  R.cardStory = await until(async () => /copy trade whales/.test(await p.locator(`.card[data-mint="${twt.mint}"] .story`).innerText().catch(() => '')), 10000);
  await p.locator(`.card[data-mint="${twt.mint}"] .pic`).hover(); await sleep(400);
  R.peek = (await p.locator('#peek').isVisible()) && /copy trade whales/.test(await p.locator('#peek').innerText());
  await p.mouse.move(800, 20);
  await p.locator(`.card[data-mint="${twt.mint}"] .name b`).click();
  R.storyBar = await until(async () => { const t = await p.locator('#storyBar').innerText(); return /@catguy/.test(t) && /BOYZ - the copy cat/.test(t) && /What it is/.test(t) && !/Reading the X post/.test(t); }, 12000);
  R.storyText = (await p.locator('#storyBar').innerText()).replace(/\s+/g, ' ').slice(0, 300);
  R.storyHeight = Math.round((await p.locator('#storyBar').boundingBox()).height);
  await p.click('[data-sbmore]'); await sleep(300);
  R.storyMore = await until(async () => /copy trade whales/.test(await p.locator('#storyBar .sb-drop').innerText()) && (await p.locator('#storyBar .sb-drop .sb-site').count()) === 1, 6000);
  await p.screenshot({ path: `${E}/p5-story.png` });

  // live data check from the ⚙ window
  await p.click('#prefsBtn'); await p.click('#pHealth');
  await until(async () => (await p.locator('#healthOut .hc').count()) >= 9, 20000);
  R.health = await p.locator('#healthOut .hc').evaluateAll((els) => els.map((e) => `${e.classList.contains('ok') ? 'OK' : 'NO'} ${e.querySelector('b').textContent}: ${e.querySelector('span').textContent}`));
  await p.screenshot({ path: `${E}/p6-health.png` });
  await p.click('#pClose');

  // back to the board
  await p.click('#back'); await sleep(1200);
  R.backOnBoard = await p.isVisible('#board');
  R.errors = errors;
  console.log(JSON.stringify(R, null, 1));
  await b.close();
})().catch((e) => { console.error('TEST CRASH', e.message.split('\n')[0]); console.log(JSON.stringify({ crashed: e.message.split('\n')[0] })); process.exit(1); });
