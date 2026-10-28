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

console.log(failed ? `\n${failed} check(s) FAILED. Details are in ${OUT}.` : '\nAll checks passed.');
process.exit(failed ? 1 : 0);
