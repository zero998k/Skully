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

  // ---- Quick settings: set take profit 30, stop loss "-20", bad value rejected ----
  await key('3'); await sleep(300);
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

  // ---- Copy a buy ----
  await F('/set?mult=1');
  R.subs = (await emit('buy')).subs;
  R.boughtAt = await until(async () => (await S()).inventory.length === 1);
  R.noIntelTab = (await p.locator('[data-tab=intel]').count()) === 0;

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
  await key('3'); await sleep(300);
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
  await emit('sell', 0.92); await sleep(3000); // keeps an 8% moon bag: still counts as out
  R.fullExitSold = (await S()).inventory.length === 0 ? (await lastTrade()).reason : 'still held';
  // a first buy by a wallet holding only dust from an old trade is still copied
  await F('/emit?side=buy&held=0.01'); R.dustFirstBuyCopied = await until(async () => (await S()).inventory.length === 1);
  await emit('sell', 1); await until(async () => (await S()).inventory.length === 0);
  // switch to "every sell, same %" and check partial mirror + Sell now
  await key('3'); await sleep(300);
  await p.selectOption('#quick [name=sellOnlyOnFullExit]', 'false'); await p.click('#quick button[type=submit]'); await sleep(900);
  R.savedSellRule = cfg().sellOnlyOnFullExit;
  await emit('buy'); await until(async () => (await S()).inventory.length === 1);
  await emit('sell', 0.5); await sleep(3000);
  R.afterHalfSell = (await S()).inventory.length ? `held, last: ${(await lastTrade()).reason}` : 'position gone';
  await key('Escape');
  await p.locator('[data-sell]').first().click(); await sleep(2500);
  R.afterSellNow = (await S()).inventory.length;
  await key('3'); await sleep(300);
  await p.selectOption('#quick [name=sellOnlyOnFullExit]', 'true'); await p.click('#quick button[type=submit]'); await sleep(900);

  // ---- Daily loss limit (KO) via Quick settings ----
  await key('3'); await sleep(300);
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
  await sleep(500); await F('/emit?side=buy&mint=2'); await sleep(3000);
  R.maxPosSkip = await p.locator('.feed li', { hasText: 'maxOpenPositions' }).count();
  R.slotsFullToast = /Slots full/.test(await toasts());
  R.savedQuick = (({ dailyLossLimitSol, maxOpenPositions, buyAmountSol }) => ({ dailyLossLimitSol, maxOpenPositions, buyAmountSol }))(cfg());
  await p.locator('[data-sell]').first().click(); await sleep(2000);

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
  await key('4'); await sleep(400);
  await p.click('#createWallet'); await sleep(1500);
  await F('/set?sol=1');
  R.depositToast = await until(async () => /Deposit received/.test(await toasts()), 15000);
  await p.click('[data-mode=live]'); await p.click('#riskOk'); await p.click('#goLive'); await sleep(1500);
  R.mode = (await S()).mode;
  await key('3'); await sleep(200);
  await p.fill('#quick [name=maxOpenPositions]', '5'); await p.click('#quick button[type=submit]'); await sleep(800);
  await F('/set?mult=1'); await emit('buy');
  R.liveBought = await until(async () => (await S()).inventory.length === 1, 10000);
  R.liveTrade = (await lastTrade())?.action;
  await key('4'); await sleep(500);
  await p.click('[data-mode=paper]'); await sleep(1000);
  R.paperBlocked = /still hold/.test(await toasts());
  await F('/set?mult=1.2'); await emit('sell'); await sleep(3500);
  R.liveSold = (await S()).inventory.length === 0 ? (await lastTrade()).action : 'still held';
  const w = await (await fetch('http://127.0.0.1:18900/state', { method: 'POST' })).json();
  R.swapsSentOnChain = w.sent.filter((s) => s.kind === 'swap').length;
  // real money, brand-new Pump.fun coin read from the logs: bought straight on its curve through PumpPortal
  const lp = await F('/emit-pump?side=buy&sol=1');
  R.livePumpBought = await until(async () => (await S()).inventory.some((x) => x.mint === lp.mint), 10000);
  R.livePumpTradeLocal = (await (await fetch('http://127.0.0.1:18903/pp/tradelocal')).json()).map((x) => `${x.action}:${x.mint === lp.mint}`).join();
  await F('/set?mult=1'); await F(`/emit-pump?side=sell&mint=${lp.mint}&tokens=900000000000000000`);
  R.livePumpSold = await until(async () => !(await S()).inventory.some((x) => x.mint === lp.mint), 10000);
  await sleep(10500); await key('4'); await sleep(800);
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
  await key('2'); await sleep(400);
  R.walletsListed = await p.locator('#board tr').count() - 1;
  await p.click('[data-remove="friendpick"]'); await sleep(800);
  R.walletsAfterRemove = await p.locator('#board tr').count() - 1;
  // switch copying off for one wallet: its buys are skipped; then back on
  const whale = await p.locator('[data-wtoggle]').first().getAttribute('data-wtoggle');
  await p.click(`[data-wtoggle="${whale}"]`); await sleep(900);
  R.walletSwitchedOff = (await p.locator(`[data-wtoggle="${whale}"]`).getAttribute('data-paused')) === '1';
  await emit('buy'); await sleep(2500);
  R.walletOffSkip = await p.locator('.feed li', { hasText: 'switched off' }).count();
  await p.click(`[data-wtoggle="${whale}"]`); await sleep(900);
  R.walletBackOn = (await p.locator(`[data-wtoggle="${whale}"]`).getAttribute('data-paused')) === '0';

  // fast path: a Pump.fun trade read straight from the notification's logs, bought on the curve, timed
  if ((await S()).inventory.length) { await p.evaluate(() => api('/api/sell-all', {})); await sleep(500); }
  const fp = await F('/emit-pump?side=buy&sol=1.5');
  R.fastBought = await until(async () => (await S()).inventory.some((x) => x.mint === fp.mint), 5000);
  R.fastSpeed = (await S()).copySpeed;
  await F(`/emit-pump?side=sell&mint=${fp.mint}&tokens=900000000000000000`);
  R.fastSold = await until(async () => !(await S()).inventory.some((x) => x.mint === fp.mint), 6000);

  // pause with coins open: choose "pause and sell everything"
  await F('/set?mult=1'); await emit('buy'); await until(async () => (await S()).inventory.length >= 1, 6000);
  await key('p'); await sleep(500);
  R.pauseChoiceShown = await p.isVisible('#pauseSell');
  await p.click('#pauseSell');
  R.pauseSoldAll = await until(async () => { const st = await S(); return st.paused === true && st.inventory.length === 0; }, 10000);

  await sleep(600); await emit('buy'); await sleep(2500);
  R.pausedSkip = await p.locator('.feed li', { hasText: 'copying is paused' }).count();
  await key('p');

  // ---- Wallet Finder: paste two coins that ran, see who was early on both, open a wallet's profile ----
  const FA = await fetch('http://127.0.0.1:18900/finder/addrs').then((r) => r.json());
  const sh = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;
  await fetch('http://127.0.0.1:18900/finder/set?fast=0'); // free Helius plan: the oldest-first lookup is refused
  await key('5'); await sleep(300);
  await p.fill('#finderInput', `${FA.COIN_A}\n${FA.COIN_B}`); await p.click('#finderForm button[type=submit]');
  R.finderMulti = await until(async () => (await p.locator('#finderView').innerText()).includes('In profit on more than one'), 30000);
  const fv = await p.locator('#finderView').innerText();
  R.finderSmartOnBoth = (fv.match(new RegExp(sh(FA.SMART), 'g')) ?? []).length >= 3 && fv.includes('RUNA') && fv.includes('RUNB');
  R.finderCoinSeconds = [...fv.matchAll(/scanned in ([\d.]+)s/g)].map((m) => Number(m[1]));
  R.finderTriedFast = (await fetch('http://127.0.0.1:18900/finder/stats').then((r) => r.json())).fastCalls;
  R.finderTags = await p.locator('#finderView .ftag.sniper').count() > 0 && await p.locator('#finderView .ftag.dev').count() > 0;
  await p.screenshot({ path: `${E}/6-finder-coins.png`, fullPage: true });
  await p.locator(`[data-fprofile="${FA.SMART}"]`).first().click();
  R.finderProfile = await until(async () => p.locator('#finderView .cal').count().then((n) => n > 0), 30000);
  R.finderVerdict = await p.locator('#finderView .verdict').innerText().catch(() => '');
  R.finderNetWorth = (await p.locator('#finderView .fcards').first().innerText()).match(/Net worth\s+([\d.]+) SOL/)?.[1];
  R.finderHolds = (await p.locator('#finderView').innerText()).includes('RUNB');
  const calDays = async () => p.locator('#finderView [data-cal=profile] .cal-day.win, #finderView [data-cal=profile] .cal-day.loss').count();
  R.finderCalDays = await calDays();
  for (let i = 0; i < 2; i++) { await p.click('#finderView [data-cal=profile] [data-calmove="-1"]'); R.finderCalDays += await calDays(); }
  await p.click('#finderView [data-cal=profile] [data-calmove="1"]'); await p.click('#finderView [data-cal=profile] [data-calmove="1"]');
  R.finderLinked = await until(async () => { const row = p.locator('#fLinked tr', { hasText: sh(FA.SIB) }); return (await row.count()) && (await row.locator('.conf').innerText()) === 'high'; }, 30000);
  R.finderLinkedWhy = await p.locator('#fLinked tr', { hasText: sh(FA.SIB) }).innerText().catch(() => '');
  await p.click('[data-freplay="30"]');
  R.finderReplay = await until(async () => { const t = await p.locator('#fReplay').innerText(); return /You'd have made\s+\+[\d.]+ SOL/.test(t) && t; }, 30000);
  await p.screenshot({ path: `${E}/7-finder-profile.png`, fullPage: true });
  await p.click('.fhead [data-fcopy]'); await sleep(300);
  R.finderCopyPrefilled = (await p.inputValue('#wAddr')) === FA.SMART;
  await p.fill('#wName', 'finderpick'); await p.click('#addForm button[type=submit]'); await sleep(800);
  R.finderCopied = cfg().wallets.some((w) => w.address === FA.SMART);
  await p.evaluate(() => api('/api/wallets/remove', { key: 'finderpick' }));
  await p.fill('#finderInput', 'not-an-address'); await p.click('#finderForm button[type=submit]'); await sleep(1500);
  R.finderBadAddress = await p.locator('#finderView').innerText();
  // ---- Share the Finder with a friend: a link to a Finder-only page; nothing else is reachable through it ----
  await p.click('#shareBtn'); await sleep(300); await p.click('#shareStart');
  R.shareUrl = await until(async () => (await p.locator('#shareUrl').count()) && p.inputValue('#shareUrl'), 10000);
  const gp = await b.newPage({ viewport: { width: 1280, height: 900 } });
  gp.on('pageerror', (e) => errors.push(`guest: ${e}`)); gp.on('dialog', (d) => d.accept());
  await gp.goto(R.shareUrl); await sleep(800);
  R.guestOnlyFinder = (await gp.locator('#finderForm').count()) === 1 && (await gp.locator('#pauseBtn, #addWalletBtn, #tabs, #balChip, #askFab').count()) === 0;
  await gp.fill('#finderInput', FA.COIN_A); await gp.click('#finderForm button[type=submit]');
  R.guestCoin = await until(async () => (await gp.locator('#finderView').innerText()).includes('Early buyers'), 30000);
  await gp.locator(`[data-fprofile="${FA.SMART}"]`).first().click();
  R.guestProfile = await until(async () => gp.locator('#finderView .cal').count().then((n) => n > 0), 30000);
  await gp.screenshot({ path: `${E}/9-guest-finder.png`, fullPage: true });
  const tok = new URL(R.shareUrl).pathname.split('/')[2];
  const st = (path, headers = {}) => new Promise((ok) => require('http').get({ host: '127.0.0.1', port: 7777, path, headers }, (r) => { r.resume(); ok(r.statusCode); }).on('error', () => ok(0)));
  R.shareBlocks = { ownerPageViaTunnel: await st('/', { 'cf-connecting-ip': '1.2.3.4' }), ownerPageOtherHost: await st('/', { host: 'abc.trycloudflare.com' }), ownerApiViaTunnel: await st('/api/state?t=x', { 'x-forwarded-for': '1.2.3.4' }),
    wrongToken: await st('/g/AAAAAAAAAAAAAAAA'), otherGuestPath: await st(`/g/${tok}/api/state`), guestApi: await st(`/g/${tok}/api/finder/kind?a=${FA.SMART}`, { 'cf-connecting-ip': '1.2.3.4' }) };
  // ---- Social Lobby: host sets a name, a friend joins through the link, profiles, chat, reactions, DMs, calls ----
  await key('Escape'); await sleep(200);
  await p.click('#clubBtn'); await sleep(600);
  R.lobbyHostSetup = await p.locator('#cName').count() === 1;
  await p.fill('#cName', 'kingsol'); await p.click('#cEdit button[type=submit]'); await sleep(800);
  await p.click('[data-croom="lounge"]'); await sleep(500);
  await p.fill('#clubText', 'gm frens'); await p.keyboard.press('Enter'); await sleep(600);
  await gp.reload(); await sleep(600);
  await gp.click('#clubBtn'); await sleep(400);
  await gp.fill('#sName', 'buddy'); await gp.fill('#sPass', 'pass1234'); await gp.click('#cSignup button[type=submit]'); await sleep(800);
  const png = await gp.screenshot({ clip: { x: 0, y: 0, width: 120, height: 120 } });
  await gp.setInputFiles('#cAvatar', { name: 'me.png', mimeType: 'image/png', buffer: png });
  await gp.setInputFiles('#cBanner', { name: 'banner.png', mimeType: 'image/png', buffer: png });
  await gp.fill('#cBio', 'just vibing <b>bold</b>'); await gp.click('#cEdit button[type=submit]'); await sleep(1000);
  R.lobbyProfile = (await gp.locator('#clubBody .pbio').innerText()) === 'just vibing <b>bold</b>' && (await gp.locator('#clubBody .pbanner').getAttribute('style')).includes('/api/club/img/') && await gp.locator('#clubBody img.av.lg').count() === 1;
  await gp.screenshot({ path: `${E}/10-lobby-profile.png` });
  await gp.click('[data-croom="lounge"]'); await sleep(800);
  R.lobbyFriendSees = (await gp.locator('#clubBody').innerText()).includes('gm frens');
  await gp.fill('#clubText', 'yo whats good'); await gp.keyboard.press('Enter'); await sleep(400);
  await gp.locator('#clubBody .msg-row', { hasText: 'gm frens' }).hover(); await gp.locator('#clubBody .msg-row', { hasText: 'gm frens' }).locator('[data-creact="🔥"]').first().click(); await sleep(400);
  R.lobbyHostSees = await until(async () => (await p.locator('#clubBody').innerText()).includes('yo whats good'), 6000);
  R.lobbyReaction = await until(async () => (await p.locator('#clubBody .reacts').innerText().catch(() => '')).includes('🔥 1'), 6000);
  await p.click('[data-cflex]'); await sleep(800);
  R.lobbyFlex = await p.locator('#clubBody .xcard.pnl').count() === 1;
  // friend calls a coin and shares a wallet from the Finder
  await gp.click('[data-ccalls]'); await sleep(400);
  await gp.fill('#cMint', FA.COIN_A); await gp.fill('#cNote', 'dev is based'); await gp.click('#cCall button[type=submit]'); await sleep(1200);
  R.lobbyCall = (await gp.locator('#clubBody').innerText()).match(/RUNA[\s\S]*?buddy[\s\S]*?(1\.00x)/)?.[1];
  await gp.click('[data-cclose]'); await sleep(200);
  await gp.fill('#finderInput', FA.SMART); await gp.click('#finderForm button[type=submit]');
  await until(async () => gp.locator('#finderView [data-fshare]').count().then((n) => n > 0), 20000);
  await gp.click('#finderView [data-fshare]'); await sleep(600);
  R.lobbyWalletCard = await until(async () => (await p.locator('#clubBody .xcard').innerText().catch(() => '')).includes(`Wallet ${sh(FA.SMART)}`) || (await p.locator('#clubBody').innerText()).includes(`Wallet ${sh(FA.SMART)}`), 6000);
  await p.screenshot({ path: `${E}/11-lobby-chat.png` });
  // host messages the friend privately; the friend gets an unread badge and reads it
  const buddyId = await p.locator('#clubNav [data-cprofile]', { hasText: 'buddy' }).getAttribute('data-cprofile');
  await p.click(`#clubNav [data-cprofile="${buddyId}"]`); await sleep(500); await p.click('[data-cdm]'); await sleep(500);
  await p.fill('#clubText', 'private alpha'); await p.keyboard.press('Enter'); await sleep(500);
  R.lobbyBadge = await until(async () => /Social Lobby\s*[1-9]/.test(await gp.locator('#clubBtn').innerText()) && await gp.evaluate(() => Object.keys(C.unread).some((r) => r.startsWith('dm:'))), 25000);
  R.lobbyBadgeText = await gp.locator('#clubBtn').innerText(); R.lobbyGuestState = await gp.evaluate(() => ({ me: C.me?.name, unread: C.unread, open: $('club')?.className }));
  await gp.click('#clubBtn'); await sleep(800); await gp.locator('#clubNav [data-croom^="dm:"]').first().click(); await sleep(800);
  R.lobbyDm = (await gp.locator('#clubBody').innerText()).includes('private alpha');
  // what a friend can't do
  const sess = await gp.evaluate(() => localStorage.getItem('lobbySession'));
  const gpost = (what, body, s2 = sess) => fetch(`http://127.0.0.1:7777/g/${tok}/api/club/${what}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-club-session': s2 }, body: JSON.stringify(body) }).then((r) => r.status);
  R.lobbyBlocks = { kick: await gpost('kick', { id: 'host' }), otherDm: await gpost('send', { room: 'dm:aaaa:bbbb', text: 'x' }), noSession: await gpost('send', { room: 'lounge', text: 'x' }, 'nope'), fakeFlex: await gpost('send', { room: 'lounge', text: '', card: { type: 'pnl', total: 999 } }), svg: await gpost('profile', { avatar: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' }) };
  // host removes the friend: their session stops working
  await p.click(`#clubNav [data-cprofile="${buddyId}"]`); await sleep(400); await p.click('[data-ckick]'); await sleep(600);
  R.lobbyKicked = await gpost('send', { room: 'lounge', text: 'still here?' });
  await p.click('[data-cclose]'); await sleep(200);
  await p.click('#shareBtn'); await sleep(400);
  await p.click('#shareStop'); await sleep(500);
  R.shareStopped = await st(`/g/${tok}`);
  await gp.close(); await key('Escape');
  // ---- Hypothetical PnL ----
  await p.click('#hypoBtn');
  R.hypoShown = await until(async () => (await p.locator('#modalBody').innerText()).includes('If you sold when they sold'), 30000);
  R.hypoRows = await p.locator('#modalBody table tr').count() - 1;
  await p.fill('#hypoSize', '1'); await sleep(300);
  R.hypoScaled = (await p.locator('#modalBody table').innerText()).includes('1.000');
  await p.screenshot({ path: `${E}/12-hypothetical.png` });
  await key('Escape');
  await p.setViewportSize({ width: 390, height: 900 }); await p.click(`#finderRecent [data-frecent="${FA.SMART}"]`);
  await until(async () => p.locator('#finderView .cal').count().then((n) => n > 0), 15000);
  R.finderPhoneOverflow = await p.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  await p.screenshot({ path: `${E}/8-finder-phone.png`, fullPage: true });
  await p.setViewportSize({ width: 390, height: 900 }); await key('3'); await sleep(500);
  await p.screenshot({ path: `${E}/5-phone-loadout.png`, fullPage: true });
  R.phoneOverflow = await p.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  R.noPulseLink = (await p.locator('#pulseLink').count()) === 0 && (await fetch('http://localhost:7777/pulse')).status === 404;
  R.errors = errors; R.fakeUnhandled = w2.log;
  console.log(JSON.stringify(R, null, 1));
  await b.close();
})().catch((e) => { console.error('TEST CRASH', e.message.split('\n')[0]); console.log(JSON.stringify(global.R, null, 1)); process.exit(1); });
