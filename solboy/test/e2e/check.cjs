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
check('dashboard', 'real money: a brand-new Pump.fun coin is bought on its curve through PumpPortal, then sold', f.livePumpBought === true && /buy:true/.test(f.livePumpTradeLocal ?? '') && f.livePumpSold === true, f.livePumpTradeLocal);
check('dashboard', 'Pulse is gone from the dashboard', f.noPulseLink === true, f.noPulseLink);

check('finder', 'pasted coins: wallets early and in profit on both, with sniper/dev tags', fl.finderMulti === true && fl.finderSmartOnBoth === true && fl.finderTags === true, fl.finderSmartOnBoth);
check('finder', 'each coin scanned in under 15 seconds (free plan path, fast lookup tried once)', fl.finderCoinSeconds?.length === 2 && fl.finderCoinSeconds.every((x) => x < 15) && fl.finderTriedFast === 1, `${fl.finderCoinSeconds} tried ${fl.finderTriedFast}`);
check('finder', 'wallet profile: verdict, net worth, holdings', /good to copy/.test(fl.finderVerdict ?? '') && fl.finderNetWorth === '14.90' && fl.finderHolds === true, `${fl.finderVerdict} ${fl.finderNetWorth}`);
check('finder', 'PnL calendar with green and red days', fl.finderProfile === true && fl.finderCalDays >= 6, fl.finderCalDays);
check('finder', 'linked wallet found with high confidence and reasons', fl.finderLinked === true && /same funder|same wallet/i.test(fl.finderLinkedWhy ?? '') && /same block/.test(fl.finderLinkedWhy ?? ''), fl.finderLinkedWhy);
check('finder', 'what-if-I-copied replay', typeof fl.finderReplay === 'string', fl.finderReplay);
check('finder', 'copy this wallet', fl.finderCopyPrefilled === true && fl.finderCopied === true, fl.finderCopied);
check('finder', 'bad address explained', /valid/.test(fl.finderBadAddress ?? ''), fl.finderBadAddress);
check('share', 'Share Finder makes a link; the friend\'s page is the Finder only and works', /\/g\/[\w-]+$/.test(fl.shareUrl ?? '') && fl.guestOnlyFinder === true && fl.guestCoin === true && fl.guestProfile === true, fl.shareUrl);
check('share', 'nothing else is reachable through the link, and stopping turns it off', JSON.stringify(fl.shareBlocks) === JSON.stringify({ ownerPageViaTunnel: 403, ownerPageOtherHost: 403, ownerApiViaTunnel: 403, wrongToken: 404, otherGuestPath: 404, guestApi: 200 }) && fl.shareStopped === 404, JSON.stringify(fl.shareBlocks) + ' stopped ' + fl.shareStopped);
check('lobby', 'host sets a name; a friend joins with the link and makes a profile with picture, banner and bio (shown as text)', fl.lobbyHostSetup === true && fl.lobbyProfile === true, fl.lobbyProfile);
check('lobby', 'chat both ways, reactions, PnL flex card', fl.lobbyFriendSees === true && fl.lobbyHostSees === true && fl.lobbyReaction === true && fl.lobbyFlex === true, `${fl.lobbyFriendSees} ${fl.lobbyHostSees} ${fl.lobbyReaction} ${fl.lobbyFlex}`);
check('lobby', 'coin calls board and wallet cards shared from the Finder', fl.lobbyCall === '1.00x' && fl.lobbyWalletCard === true, `${fl.lobbyCall} ${fl.lobbyWalletCard}`);
check('lobby', 'direct messages with an unread badge', fl.lobbyBadge === true && fl.lobbyDm === true, `${fl.lobbyBadge} ${fl.lobbyDm}`);
check('lobby', 'friends cannot kick, read others\' DMs, post without logging in, fake a PnL card or upload SVG; kicked friends are out', JSON.stringify(fl.lobbyBlocks) === JSON.stringify({ kick: 403, otherDm: 404, noSession: 401, fakeFlex: 400, svg: 400 }) && fl.lobbyKicked === 401, JSON.stringify(fl.lobbyBlocks) + ' kicked ' + fl.lobbyKicked);
check('hypothetical', 'Hypothetical PnL lists each copy with what-ifs and a size box', fl.hypoShown === true && fl.hypoRows >= 1 && fl.hypoScaled === true, `${fl.hypoRows} ${fl.hypoScaled}`);
check('finder', 'fits a phone', fl.finderPhoneOverflow === false, fl.finderPhoneOverflow);

check('speed', 'live buy shows confirmation time separately from submission', f.livePumpTiming?.paper === false && f.livePumpTiming?.side === 'buy' && f.livePumpTiming.confirmed >= f.livePumpTiming.last && f.livePumpTiming.complete >= f.livePumpTiming.confirmed, f.livePumpTiming);
check('speed', 'live sell is timed too', f.liveSellTiming?.side === 'sell' && f.liveSellTiming?.confirmed >= f.liveSellTiming?.last, f.liveSellTiming);
check('speed', 'completed simulated buy and sell reach the screen in under a second while full state is stalled', f.streamBuyWhileStateStalled && f.streamSellWhileStateStalled && f.streamBuyMs < 1000 && f.streamSellMs < 1000, [f.streamBuyMs, f.streamSellMs]);
check('speed', 'older state cannot hide a new buy or restore a sold position', f.staleStateCannotHideBuy && f.staleStateCannotRestoreSold, [f.staleStateCannotHideBuy, f.staleStateCannotRestoreSold]);
check('speed', 'paper timing is clearly labelled', /Sell.*paper/.test(f.paperSpeedLabel ?? ''), f.paperSpeedLabel);
const speed = json('speed.json');
for (const name of ['paperIsNotConfirmed', 'noRouteCacheSkipsRedundantQuote', 'expiredRouteCacheRechecks', 'confirmedBuyWithoutExtraLookup', 'sellsAreTimed', 'failedConfirmationDoesNotOpenOrDuplicate', 'currentFreeJupiterEndpoint']) check('speed', name, speed[name] === true, speed[name] ?? speed.crashed);

console.log(failed ? `\n${failed} check(s) FAILED. Details are in ${OUT}.` : '\nAll checks passed.');
process.exit(failed ? 1 : 0);
