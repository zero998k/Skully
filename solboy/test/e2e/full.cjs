// Drives every dashboard feature of the packaged app against fake.cjs. Prints a JSON report.
const { chromium } = require('playwright');
const fs = require('fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const F = (path) => fetch(`http://127.0.0.1:18900${path}`, { method: 'POST' }).then((r) => r.json());
const emit = (side, frac = 1) => F(`/emit?side=${side}&frac=${frac}`);
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await sleep(250); } };
(async () => {
  const [E, APP] = process.argv.slice(2);
  for (let i = 0; i < 60 && !(await fetch('http://localhost:7777/').then(() => true).catch(() => false)); i++) await sleep(500);
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; p.on('pageerror', (e) => errors.push(String(e)));
  p.on('dialog', (d) => d.accept());
  const key = async (k) => { await p.evaluate(() => document.activeElement?.blur?.()); await p.keyboard.press(k); };
  const R = {}; global.R = R; const S = () => p.evaluate(() => S);
  const cfg = () => JSON.parse(fs.readFileSync(`${APP}/config.json`, 'utf8'));
  const toasts = () => p.locator('#toasts').innerText().catch(() => '');
  const lastTrade = async () => (await S()).trades[0];
  await p.goto('http://localhost:7777/'); await sleep(2000);
  R.online = await p.textContent('#conn');
  R.researchMigratedTo = (await S()).quick.researchOn;

  // ---- Quick settings: set take profit 30, stop loss "-20", bad value rejected ----
  await key('4'); await sleep(300);
  R.quickCard = await p.locator('#quick').count();
  await p.fill('#quick [name=takeProfitPct]', '30');
  await p.fill('#quick [name=stopLossPct]', '-20');
  await p.click('#quick button[type=submit]'); await sleep(1200);
  R.quickToast = (await toasts()).match(/Take profit[^\n]*/)?.[0];
  R.savedTP = cfg().takeProfitPct; R.savedSL = cfg().stopLossPct;
  R.loadoutShowsTP = (await p.locator('#loadout .kv').innerText()).match(/Take profit at\s+(\S+)/)?.[1];
  await p.fill('#quick [name=stopLossPct]', '150');
  await p.click('#quick button[type=submit]'); await sleep(800);
  R.badValueError = await p.textContent('#quickErr');
  R.savedSLAfterBad = cfg().stopLossPct;
  await p.screenshot({ path: `${E}/1-quick-settings.png` });

  // ---- Copy a buy; research starts at once with rich data ----
  await F('/set?mult=1');
  R.subs = (await emit('buy')).subs;
  R.boughtAt = await until(async () => (await S()).inventory.length === 1);
  R.reportReady = await until(async () => (await S()).reports.length > 0, 15000);
  const st = await (await fetch('http://127.0.0.1:18900/state', { method: 'POST' })).json();
  const rep = st.groq.find((g) => g.stream);
  R.researchSawTweet = /copy trade whales/.test(rep?.last?.content ?? '');
  R.groqRefusals = st.groq.filter((g) => g.refused).map((g) => `${g.refused}:${g.promptTokens}+${g.max}`);
  R.reportModel = (await (await fetch(`http://localhost:7777/api/report?file=${encodeURIComponent((await S()).reports[0].file)}&t=${await p.evaluate(() => TOKEN)}`)).json()).text.match(/by (\S+)\s*$/)?.[1];
  await key('1'); await sleep(500);
  R.reportCard = (await p.locator('#reports .report').first().innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 220);
  await p.locator('#reports .report').first().click(); await sleep(700);
  R.reportBody = (await p.locator('#modalBody').innerText()).match(/tweet=\S+ dev=\S+ copycats=\S+ launchpad=\S+ site=[^.]*? replies=\S+/)?.[0];
  R.overview = (await p.locator('#modalBody').innerText()).match(/What it is:[^\n]*\n+Why it's pumping:[^\n]*/)?.[0];
  R.overviewBoxes = await p.locator('#modalBody .tldr-box').count();
  await p.screenshot({ path: `${E}/2-report.png` }); await key('Escape');

  // ---- Take profit fires at +50% ----
  await F('/set?mult=1.5');
  R.tpSold = await until(async () => (await S()).inventory.length === 0, 8000);
  R.tpReason = (await lastTrade())?.reason;

  // ---- Stop loss fires at -30% ----
  await F('/set?mult=1'); await emit('buy');
  await until(async () => (await S()).inventory.length === 1);
  await F('/set?mult=0.7');
  R.slSold = await until(async () => (await S()).inventory.length === 0, 8000);
  R.slReason = (await lastTrade())?.reason;

  // ---- Turn TP/SL off (empty) ----
  await key('4'); await sleep(300);
  await p.fill('#quick [name=takeProfitPct]', ''); await p.fill('#quick [name=stopLossPct]', '');
  await p.click('#quick button[type=submit]'); await sleep(1000);
  R.offTP = cfg().takeProfitPct; R.offSL = cfg().stopLossPct;
  await F('/set?mult=0.5'); await emit('buy'); await until(async () => (await S()).inventory.length === 1); await sleep(3500);
  R.heldWithTPSLOff = (await S()).inventory.length;

  // ---- Copy rules: stacked buy ignored; partial sell ignored; full exit sells ----
  await F('/emit?side=buy&held=1'); await sleep(2500);
  R.stackedBuySkipped = await p.locator('.feed li', { hasText: 'only copies their first buy' }).count();
  await emit('sell', 0.5); await sleep(3000);
  R.partialSellIgnored = (await S()).inventory.length === 1 && (await p.locator('.feed li', { hasText: 'not selling yet' }).count()) > 0;
  await emit('sell', 1); await sleep(3000);
  R.fullExitSold = (await S()).inventory.length === 0 ? (await lastTrade()).reason : 'still held';
  // switch to "every sell, same %" and check partial mirror + Sell now
  await key('4'); await sleep(300);
  await p.selectOption('#quick [name=sellOnlyOnFullExit]', 'false'); await p.click('#quick button[type=submit]'); await sleep(900);
  R.savedSellRule = cfg().sellOnlyOnFullExit;
  await emit('buy'); await until(async () => (await S()).inventory.length === 1);
  await emit('sell', 0.5); await sleep(3000);
  R.afterHalfSell = (await S()).inventory.length ? `held, last: ${(await lastTrade()).reason}` : 'position gone';
  await key('Escape');
  await p.locator('[data-sell]').first().click(); await sleep(2500);
  R.afterSellNow = (await S()).inventory.length;
  await key('4'); await sleep(300);
  await p.selectOption('#quick [name=sellOnlyOnFullExit]', 'true'); await p.click('#quick button[type=submit]'); await sleep(900);

  // ---- Daily loss limit (KO) via Quick settings ----
  await key('4'); await sleep(300);
  await p.fill('#quick [name=dailyLossLimitSol]', '0.01'); await p.click('#quick button[type=submit]'); await sleep(900);
  await F('/set?mult=1'); await emit('buy'); await sleep(3000);
  R.koSkip = await p.locator('.feed li', { hasText: 'daily loss limit' }).count();
  R.hpBeforeReset = await p.textContent('#hpText'); R.totalBeforeReset = await p.evaluate(() => S.summary.totalPnl);
  await p.click('#resetDay'); await sleep(1200);
  R.hpAfterReset = await p.textContent('#hpText');
  R.inlineResetButton = await p.locator('#today [data-reset-pnl]').count();
  R.totalAfterReset = await p.evaluate(() => S.summary.totalPnl); R.scoreText = await p.textContent('#score');
  await emit('buy'); R.buysAgainAfterReset = await until(async () => (await S()).inventory.length === 1);
  await p.locator('[data-sell]').first().click(); await sleep(2000);
  await p.click('#resetDay'); await sleep(800);
  await p.fill('#quick [name=dailyLossLimitSol]', '5'); await p.fill('#quick [name=maxOpenPositions]', '1'); await p.click('#quick button[type=submit]'); await sleep(900);
  await emit('buy'); await until(async () => (await S()).inventory.length === 1);
  await sleep(500); await fetch('http://127.0.0.1:18900/emit?side=buy', { method: 'POST' }); await sleep(3000);
  R.maxPosSkip = await p.locator('.feed li', { hasText: 'maxOpenPositions' }).count();
  R.savedQuick = (({ dailyLossLimitSol, maxOpenPositions, buyAmountSol }) => ({ dailyLossLimitSol, maxOpenPositions, buyAmountSol }))(cfg());
  await p.locator('[data-sell]').first().click(); await sleep(2000);

  // ---- Scan box ----
  const before = (await S()).reports.length;
  await key('1'); await p.fill('#scanInput', 'https://dexscreener.com/x EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm'); await p.press('#scanInput', 'Enter');
  R.scanAdded = await until(async () => (await S()).reports.length > before, 15000);
  await F('/set?groqdown=1');
  await key('1'); await p.fill('#scanInput', 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm'); await p.press('#scanInput', 'Enter');
  R.scanFailedToast = await until(async () => /Scan failed[\s\S]*free limit/.test(await toasts()), 20000);
  await F('/set?groqdown=0');

  // ---- Assistant: plain answer, proposal -> Do it, live lookup ----
  await key('/'); await sleep(600);
  const ask = async (q) => { await p.fill('#chatInput', q); await p.press('#chatInput', 'Enter'); await sleep(2500); };
  await ask('hey');
  R.chatPlain = await p.locator('.msg.bot').last().innerText();
  await ask('set my stop loss to 25%');
  R.proposal = (await p.locator('[data-apply]').count()) ? (await p.locator('[data-apply]').last().locator('xpath=..').innerText()).replace(/\s+/g, ' ') : 'none';
  await p.locator('[data-apply]').last().click(); await sleep(1200);
  R.afterDoIt = cfg().stopLossPct;
  await ask('reset my daily pnl');
  R.resetProposal = (await p.locator('[data-apply]').count()) ? (await p.locator('[data-apply]').last().locator('xpath=..').innerText()).replace(/\s+/g, ' ') : 'none';
  await p.locator('[data-apply]').last().click(); await sleep(1200);
  R.todayAfterAssistantReset = await p.evaluate(() => S.todayPnl); R.totalAfterAssistantReset = await p.evaluate(() => S.summary.totalPnl);
  R.historyKept = await p.evaluate(() => S.trades.length);
  await ask('what is the price of WIF');
  R.lookupAnswer = (await p.locator('.msg.bot').last().innerText()).slice(0, 120);
  await p.screenshot({ path: `${E}/3-assistant.png` });
  await key('Escape');

  // ---- Real money: create wallet, deposit, go live, live buy + sell, paper blocked, withdraw ----
  await key('5'); await sleep(400);
  await p.click('#createWallet'); await sleep(1500);
  await F('/set?sol=1');
  R.depositToast = await until(async () => /Deposit received/.test(await toasts()), 15000);
  await p.click('[data-mode=live]'); await p.click('#riskOk'); await p.click('#goLive'); await sleep(1500);
  R.mode = (await S()).mode;
  await key('4'); await sleep(200);
  await p.fill('#quick [name=maxOpenPositions]', '5'); await p.click('#quick button[type=submit]'); await sleep(800);
  await F('/set?mult=1'); await emit('buy');
  R.liveBought = await until(async () => (await S()).inventory.length === 1, 10000);
  R.liveTrade = (await lastTrade())?.action;
  await key('5'); await sleep(500);
  await p.click('[data-mode=paper]'); await sleep(1000);
  R.paperBlocked = /still hold/.test(await toasts());
  await F('/set?mult=1.2'); await emit('sell'); await sleep(3500);
  R.liveSold = (await S()).inventory.length === 0 ? (await lastTrade()).action : 'still held';
  const w = await (await fetch('http://127.0.0.1:18900/state', { method: 'POST' })).json();
  R.swapsSentOnChain = w.sent.filter((s) => s.kind === 'swap').length;
  await sleep(10500); await key('5'); await sleep(800);
  await p.fill('#wdTo', '5NU3oN4fNnx1CknHtaH8kGPHAaK4UJ3X4E2WdEyY3h1y'); await p.fill('#wdAmt', '0.3');
  await p.click('#wdForm button[type=submit]'); await sleep(2500);
  const w2 = await (await fetch('http://127.0.0.1:18900/state', { method: 'POST' })).json();
  R.withdrawn = w2.sent.find((s) => s.kind === 'transfer');
  R.withdrawToast = /Withdrawn/.test(await toasts());
  await p.click('[data-mode=paper]'); await sleep(1000);
  R.backToPaper = (await S()).mode;
  await p.screenshot({ path: `${E}/4-account.png` });

  // ---- Wallets tab add/remove, pause ----
  await key('a'); await p.fill('#wAddr', '5NU3oN4fNnx1CknHtaH8kGPHAaK4UJ3X4E2WdEyY3h1y'); await p.fill('#wName', 'friendpick'); await p.click('#addForm button[type=submit]'); await sleep(800);
  await key('3'); await sleep(400);
  R.walletsListed = await p.locator('#board tr').count() - 1;
  await p.click('[data-remove="friendpick"]'); await sleep(800);
  R.walletsAfterRemove = await p.locator('#board tr').count() - 1;
  await key('p'); await sleep(600); await emit('buy'); await sleep(2500);
  R.pausedSkip = await p.locator('.feed li', { hasText: 'copying is paused' }).count();
  await key('p');
  await p.setViewportSize({ width: 390, height: 900 }); await key('4'); await sleep(500);
  await p.screenshot({ path: `${E}/5-phone-loadout.png`, fullPage: true });
  R.phoneOverflow = await p.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  R.errors = errors; R.fakeUnhandled = w2.log;
  console.log(JSON.stringify(R, null, 1));
  await b.close();
})().catch((e) => { console.error('TEST CRASH', e.message.split('\n')[0]); console.log(JSON.stringify(global.R, null, 1)); process.exit(1); });
