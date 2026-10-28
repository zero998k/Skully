// Checks the results the end-to-end tests printed. Exits 1 if anything is off.
const fs = require('fs');
const [OUT, VERSION, NEXT] = process.argv.slice(2);
const json = (f) => {
  const t = fs.readFileSync(`${OUT}/${f}`, 'utf8');
  try {
    return JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
  } catch {
    return { crashed: t.slice(0, 500) };
  }
};
let failed = 0;
const check = (area, name, ok, got) => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${area}: ${name}${ok ? '' : `  (got ${JSON.stringify(got)})`}`);
};

const f = json('full.json');
const F = (name, ok, key) => check('dashboard', name, ok, f[key] ?? f.crashed);
F('online', f.online === 'ONLINE', 'online');
F('quick settings save take profit / stop loss', f.savedTP === 30 && f.savedSL === 20, 'savedSL');
F('quick settings refuse a 150% stop loss', /between 1 and 99/.test(f.badValueError ?? ''), 'badValueError');
F('copies a buy', f.boughtAt === true, 'boughtAt');
F('research (Intel tab) is gone', f.noIntelTab === true, 'noIntelTab');
F('take profit sells', /^take-profit/.test(f.tpReason ?? ''), 'tpReason');
F('stop loss sells', /^stop-loss/.test(f.slReason ?? ''), 'slReason');
F('take profit / stop loss can be turned off', f.offTP === null && f.offSL === null && f.heldWithTPSLOff === 1, 'heldWithTPSLOff');
F('stacked buys are not copied', f.stackedBuySkipped >= 1, 'stackedBuySkipped');
F('partial sells are ignored', f.partialSellIgnored === true, 'partialSellIgnored');
F('selling 90%+ counts as out (moon bag)', f.fullExitSold === 'wallet1 sold out', 'fullExitSold');
F('a first buy is copied even if they held dust', f.dustFirstBuyCopied === true, 'dustFirstBuyCopied');
F('"every sell" mode mirrors a 50% sell', f.savedSellRule === false && /sold 50%/.test(f.afterHalfSell ?? ''), 'afterHalfSell');
F('Sell now', f.afterSellNow === 0, 'afterSellNow');
F('daily loss limit stops buys', f.koSkip >= 1, 'koSkip');
F('Reset PnL zeroes the total', f.totalAfterReset === 0 && f.inlineResetButton === 1, 'totalAfterReset');
F('buying resumes after reset', f.buysAgainAfterReset === true, 'buysAgainAfterReset');
F('slots full: skipped and explained', f.maxPosSkip >= 1 && f.slotsFullToast === true, 'slotsFullToast');
F('assistant changes a setting after Do it', f.afterDoIt === 25, 'afterDoIt');
F('assistant resets PnL', f.todayAfterAssistantReset === 0 && f.totalAfterAssistantReset === 0 && f.historyKept > 0, 'totalAfterAssistantReset');
F('assistant looks up live market data', /^Looked it up/.test(f.lookupAnswer ?? ''), 'lookupAnswer');
F('deposit noticed', f.depositToast === true, 'depositToast');
F('real-money mode turns on', f.mode === 'live', 'mode');
F('real-money buy and sell', f.liveBought === true && f.liveSold === 'sell' && f.swapsSentOnChain >= 2, 'swapsSentOnChain');
F('paper mode refused while holding real tokens', f.paperBlocked === true, 'paperBlocked');
F('withdraw', f.withdrawn?.lamports === 300000000 && f.withdrawToast === true, 'withdrawn');
F('back to paper', f.backToPaper === 'paper', 'backToPaper');
F('add and remove wallets', f.walletsListed === 2 && f.walletsAfterRemove === 1, 'walletsAfterRemove');
F('pause copying', f.pausedSkip >= 1, 'pausedSkip');
F('fits a phone screen', f.phoneOverflow === false, 'phoneOverflow');
F('no page errors', Array.isArray(f.errors) && f.errors.length === 0, 'errors');

const term = fs.readFileSync(`${OUT}/term.txt`, 'utf8');
for (const [name, text] of [
  ['tp sets take profit', 'Take profit: off → +40%'],
  ['sl refuses 120%', 'Stop loss must be between 1 and 99'],
  ['add wallet', 'Added buddy'],
  ['remove wallet', 'Stopped watching buddy'],
  ['reset', 'Profit/loss reset to 0'],
  ['ask the assistant', 'gm from fake groq'],
  ['scoreboard is option 3', 'WALLET SCOREBOARD'],
  ['settings is option 4', 'SETTINGS: what the bot is doing'],
]) check('terminal', name, term.includes(text), text);

const s = json('server.json');
const S = (name, ok, key) => check('server', name, ok, s[key] ?? s.crashed);
S('setup code required', /Wrong setup code/.test(s.wrongCode ?? ''), 'wrongCode');
S('setup leads to login', /\/login$/.test(s.afterSetupUrl ?? ''), 'afterSetupUrl');
S('wrong password refused', s.wrongPw === 'Wrong password.', 'wrongPw');
S('dashboard after login', s.dashboard?.online === 'ONLINE' && s.positionAfterBuy === 1, 'dashboard');
S('locked without login', s.apiWithoutLogin === 401 && s.pageWithoutLogin === 302 && s.settingsWithoutLogin === 401, 'apiWithoutLogin');
S('quick settings online', s.serverQuickSaved === 35, 'serverQuickSaved');
S('withdraw and key need the password', s.withdrawWrongPw === 'Wrong password.' && s.keyWrongPw === 'Wrong password.' && s.keyWithPw > 80, 'keyWithPw');
S('log out', /\/login$/.test(s.afterLogout ?? ''), 'afterLogout');
S('restart skips setup', s.restartGoesToLogin === '/login' && s.restartNoSetup === true, 'restartNoSetup');
S('no page errors', Array.isArray(s.errors) && s.errors.length === 0, 'errors');

const u = json('update.json');
const U = (name, ok, key) => check('update', name, ok, u[key] ?? u.crashed);
U('Update button appears', u.buttonVisible === true && u.versionBefore === VERSION, 'versionBefore');
U('damaged download refused, nothing changed', /damaged/.test(u.damagedError ?? '') && u.stillOldBinary === `SolBoy ${VERSION}` && !u.leftoverNewFile, 'damagedError');
U('updates and reloads', u.versionAfter === NEXT && u.binaryAfter === `SolBoy ${NEXT}`, 'versionAfter');
U('keys, settings and positions untouched', u.settingsUntouched === true && u.positionKept === 1, 'settingsUntouched');
U('still trades after updating', u.sellAfterUpdate === true && u.buttonGone === true, 'sellAfterUpdate');
U('no page errors', Array.isArray(u.errors) && u.errors.length === 0, 'errors');

const fl = json('full.json');
check('dashboard', 'switch copying off and on for one wallet', fl.walletSwitchedOff === true && fl.walletOffSkip >= 1 && fl.walletBackOn === true, fl.walletOffSkip);
check('dashboard', 'Pump.fun trades copied straight from the logs, under 2 seconds', fl.fastBought === true && fl.fastSold === true && fl.fastSpeed?.last < 2, JSON.stringify(fl.fastSpeed));
check('dashboard', 'pause and sell everything', fl.pauseChoiceShown === true && fl.pauseSoldAll === true, fl.pauseSoldAll);
const pp = json('pulse.json');
const PP = (name, ok, key) => check('pulse', name, ok, pp[key] ?? pp.crashed);
PP('dashboard links to Pulse', pp.dashboardHasPulseLink === true, 'dashboardHasPulseLink');
PP('live feed connects', pp.feedLive === true && pp.subs?.[0]?.newToken === true && pp.subs?.[0]?.migration === true, 'subs');
PP('new coins land in New Pairs', ['MCAT', 'BPUP', 'RUG'].every((x) => pp.newCol?.includes(x)), 'newCol');
PP('a coin past 45% bonding curve is in Final Stretch', pp.stretchCol?.includes('FROG') && !pp.newCol?.includes('FROG'), 'stretchCol');
PP('migrated coins land in Migrated, with Dex paid', pp.migratedCol?.includes('BIRD') && pp.migratedPaid === true, 'migratedCol');
PP('columns fill straight away from Pump.fun and GeckoTerminal', pp.seededStretch === true && pp.seededMigrated === true && pp.geckoSeeded === true, 'geckoSeeded');
PP('coin pictures load through SolBoy', /^200 image\/png/.test(pp.imgEndpoint ?? '') && pp.imagesShown === true, 'imgEndpoint');
PP('coin page opens fast with recent trades and a chart', pp.seedHeadMs < 2500 && pp.seedTradesRows >= 20 && pp.seedChart === true, 'seedHeadMs');
PP('board updates smoothly (cards and pictures stay, new coins slide in)', pp.smooth?.removed === 0 && pp.smooth?.sameImg === true && pp.smooth?.entered === true, 'smooth');
PP('SolBoy subscribes to each coin\'s trades', pp.tradeDelivered >= 1, 'tradeDelivered');
PP('cards show socials, holders and percentages', pp.socialLinks >= 3 && /@mooncat/.test(pp.mcatCard ?? '') && /👥 \d/.test(pp.mcatCard ?? ''), 'mcatCard');
PP('filter window has Axiom tabs and fields', pp.filterTabs?.join() === 'Protocols,Audit,$ Metrics,Socials' && ['Age', 'Top 10 Holders %', 'Dev Holding %', 'Snipers %', 'Insiders %', 'Bundle %', 'Holders', 'Dev Migrations', 'Dev Pairs Created'].every((x) => pp.auditFields?.includes(x)) && ['Liquidity ($)', 'Volume ($)', 'Market Cap ($)', 'B. Curve %', 'Global Fees Paid ($)', 'Txns', 'Num Buys', 'Num Sells'].every((x) => pp.metricFields?.includes(x)), 'auditFields');
PP('exclude keyword hides a coin', pp.rugHiddenByExclude === true, 'rugHiddenByExclude');
PP('dev holding filter hides coins', Array.isArray(pp.afterDevMax) && pp.afterDevMax.length === 0, 'afterDevMax');
PP('"needs Twitter" keeps only coins with X', pp.afterNeedsTwitter?.join() === 'MCAT', 'afterNeedsTwitter');
PP('filter presets and reset', pp.preset2ShowsAll === true && pp.afterReset?.length === 4, 'afterReset');
PP('⚡ quick buy from a card (curve price when Jupiter has no route)', /^Bought 0.1 SOL of \$MCAT/.test(pp.quickBuyToast ?? ''), 'quickBuyToast');
PP('coin page: live trades with dev tag and chart', pp.tradesRows >= 3 && pp.devTagInTrades >= 1 && pp.chartCanvas > 0 && pp.liveTradeArrived === true, 'tradesRows');
PP('coin page: holders with bonding curve labelled', pp.holderRows >= 3 && pp.curveLabelled === true, 'holderRows');
PP('insider check finds the dev-funded wallet', /1 insider/.test(pp.analyzeToast ?? '') && pp.insiderTagged >= 1, 'analyzeToast');
PP('bundled launch buy found on the chain', pp.bundleFoundOnChain === true && pp.bundleChip > 0, 'bundleFoundOnChain');
PP('migrated coin: live price from the pool on the chain', pp.poolSource === 'pool' && pp.poolNotified === 2 && pp.poolBadge === true, 'poolSource');
PP('migrated coin: pool trades move the chart instantly', pp.poolTradeShown === true && pp.poolMcMoved === true && Math.abs(pp.poolMcUsd - 430.5625 * 150) < 700, 'poolTradeShown');
PP('measured feed delay is shown', /behind chain/.test(pp.delayChip ?? ''), 'delayChip');
PP('sell from the trade panel', /^Sold for/.test(pp.sellToast ?? ''), 'sellToast');
PP('real money: buy and sell through PumpPortal when Jupiter has no route', pp.liveBuy?.mode === 200 && pp.liveBuy?.buy?.ok === true && pp.liveBuy?.sell?.ok === true && pp.tradeLocal?.join() === 'buy:true:auto,sell:false:auto', 'liveBuy');
PP('quick trade box opens and drags', pp.floatVisible === true && pp.dragged === true && /MCAT/.test(pp.floatCoin ?? ''), 'dragged');
PP('quick trade box pops out into its own window', pp.popupQuickMode === true && /MCAT/.test(pp.popupCoin ?? '') && pp.popupHasBuy === true, 'popupQuickMode');
PP('cards show the X post a coin came from, and a bigger look on hover', pp.cardStory === true && pp.peek === true, 'cardStory');
PP('coin page story: one slim line (AI story, X post, website) with details on demand', pp.storyBar === true && pp.storyHeight <= 36 && pp.storyMore === true, 'storyText');
PP('live data check tests every source', pp.health?.length === 10 && pp.health.every((x) => x.startsWith('OK')), 'health');
PP('a coin the feed never showed: details from Helius, trades and chart from the chain', pp.ghostTrades >= 4 && pp.ghostNamed === true && pp.ghostChart === true, 'ghostTrades');
PP('✨ Quality hides junk coins and turns off again', pp.qualityOn?.join() === 'MCAT' && pp.qualityOff?.length === 4, 'qualityOn');
PP('coin page: 5m/1h/6h/24h stats, mint/freeze check, trade size icons', pp.windowsShown === true && pp.windowSwitch === true && pp.securityShown === true && pp.sizeIcons === true, 'windowsShown');
PP('back to the board', pp.backOnBoard === true, 'backOnBoard');
PP('no page errors', Array.isArray(pp.errors) && pp.errors.length === 0, 'errors');

console.log(failed ? `\n${failed} check(s) FAILED. Details are in ${OUT}.` : '\nAll checks passed.');
process.exit(failed ? 1 : 0);
