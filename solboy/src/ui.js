import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { PublicKey } from '@solana/web3.js';
import { tokenNames, positionWorth } from './tokens.js';
import { summarize, scoreboard } from './stats.js';
import { c, write, log, pauseFeed, resumeFeed, readTrades } from './log.js';
import { file } from './paths.js';
import { applySetting } from './settings.js';
import { RESTART_CODE } from './update.js';

const LINE = '-'.repeat(78);
const sol = (n) => `${Number(n).toFixed(4)} SOL`;
const signed = (n) => {
  const text = `${n >= 0 ? '+' : ''}${Number(n).toFixed(4)} SOL`;
  return n > 0 ? c.green(text) : n < 0 ? c.red(text) : text;
};
const pad = (s, n) => String(s).padEnd(n);
// padEnd miscounts color codes, so pad the plain text first and color after.
const padColor = (n, width, colorFn) => colorFn(String(n).padEnd(width));

function ago(iso) {
  const mins = Math.round((Date.now() - new Date(iso)) / 60000);
  if (mins < 60) return `${mins}m ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

/** The report's TL;DR (falls back to the core narrative for older reports). */
export function reportSummary(text) {
  const what = text.match(/What it is:\**\s*(.*)/)?.[1];
  const why = text.match(/Why it's (?:pumping|dumping):\**\s*(.*)/)?.[1];
  const line = what ? [what, why].filter(Boolean).join(' ') : text.match(/TL;DR:\**\s*(.*)/)?.[1] ?? text.match(/Core Narrative:\**\s*(.*)/)?.[1] ?? '';
  return line.replaceAll('*', '').trim();
}

/** Plain-English settings, shared by the terminal and the dashboard. */
export function settingsRows(cfg, research) {
  const yes = (b) => (b ? 'yes' : 'no');
  return [
    ['Mode', cfg.dryRun ? 'Paper trading: real prices, no real money' : 'LIVE: real trades with real SOL'],
    ['Wallets watched', cfg.wallets.map((w) => w.label).join(', ')],
    ['Spend per copied buy', `${cfg.buyAmountSol} SOL (some wallets may have their own amount)`],
    ['Ignore their buys under', `${cfg.minSourceBuySol} SOL`],
    ['Most tokens held at once', cfg.maxOpenPositions],
    ['Copy their buys', cfg.onlyFirstBuy ? 'only their first buy of a coin' : 'every buy, including when they add more'],
    ['Sell when they sell', !cfg.followSells ? 'no' : cfg.sellOnlyOnFullExit ? 'only when they fully sell out' : cfg.sellMode === 'all' ? 'yes, everything' : 'yes, the same % they sell'],
    ['Take profit at', cfg.takeProfitPct ? `+${cfg.takeProfitPct}%` : 'off'],
    ['Stop loss at', cfg.stopLossPct ? `-${cfg.stopLossPct}%` : 'off'],
    ['Stop buying after losing', `${cfg.dailyLossLimitSol} SOL in a day`],
    ['Skip risky tokens', `mint authority: ${yes(cfg.skipIfMintAuthority)}, freeze authority: ${yes(cfg.skipIfFreezeAuthority)}`],
    ['Max slippage', `buys ${cfg.buySlippageBps / 100}%, sells ${cfg.sellSlippageBps / 100}%`],
    ['AI research', research ? `on (${cfg.research.provider}, researching ${cfg.research.on === 'buys' ? 'tokens the bot buys' : 'every token watched wallets buy'})` : 'off'],
  ];
}

/** The numbered menu shown at startup and whenever you type "m". */
export function createMenu({ cfg, bot, book, account, researchDir, research, dashboard, updater }) {
  const positions = book.positions;
  const mode = () => (cfg.dryRun ? c.yellow('PAPER MODE (practice, no real money)') : c.red('REAL MONEY MODE'));
  let state = 'feed';
  let reportFiles = [];

  function menuText() {
    return [
      '',
      c.bold('='.repeat(78)),
      `  ${c.bold('SOLBOY')}   ${mode()}`,
      c.bold('='.repeat(78)),
      `  Watching ${cfg.wallets.length} wallet(s). Research: ${research ? 'on' : 'off'}.`,
      '',
      `  Type a number and press ${c.bold('Enter')}:`,
      `    ${c.cyan('1')}  Open positions      what you hold right now and what it's worth`,
      `    ${c.cyan('2')}  Trade history       recent trades, wins/losses and total profit`,
      `    ${c.cyan('3')}  Research reports    read the AI breakdowns of tokens`,
      `    ${c.cyan('4')}  Wallet scoreboard   which copied wallets are making you money`,
      `    ${c.cyan('5')}  Settings            your current settings in plain English`,
      dashboard ? `    ${c.cyan('d')}  Dashboard           open the game-style dashboard in your browser (${dashboard.url})` : '',
      `    ${c.cyan('add')} <address> <nickname>    start copying a new wallet (saved for next time)`,
      `    ${c.cyan('remove')} <nickname>          stop copying a wallet`,
      `    ${c.cyan('account')}                    your SolBoy wallet address and balance`,
      `    ${c.cyan('reset')}                      start today's profit/loss and daily loss limit from zero`,
      `    ${c.cyan('tp')} <percent> / ${c.cyan('sl')} <percent>      set take profit / stop loss, like ${c.cyan('tp 50')} or ${c.cyan('sl off')}`,
      dashboard ? `    ${c.cyan('ask')} <question>             ask the SolBoy Assistant anything` : '',
      updater?.status().available ? `    ${c.cyan('update')}                     ${c.green(`install SolBoy ${updater.status().available.version} (keeps all your settings)`)}` : '',
      `    ${c.cyan('m')}  Show this menu again`,
      research ? '    Or paste a token address (CA) to research it.' : '',
      '',
      c.dim('  Live activity appears below. Press Ctrl+C to stop the bot.'),
      LINE,
      '',
    ].join('\n');
  }

  function openScreen(title) {
    pauseFeed();
    state = 'screen';
    process.stdout.write(`\n${c.bold('='.repeat(78))}\n  ${c.bold(title)}\n${c.bold('='.repeat(78))}\n`);
  }

  function closeHint() {
    process.stdout.write(`\n${c.dim('Press Enter to go back to the live feed.')}\n`);
  }

  function backToFeed() {
    state = 'feed';
    process.stdout.write(`\n${LINE}\n${c.dim('Back to the live feed.')}\n`);
    const updates = resumeFeed();
    if (updates) log(c.dim(`(${updates} update(s) above happened while you were reading)`));
  }

  async function showPositions() {
    openScreen('OPEN POSITIONS: what you hold right now');
    const open = positions.entries();
    if (!open.length) {
      process.stdout.write('\n  Nothing open right now. When a watched wallet buys, the bot copies it and it shows up here.\n');
      return closeHint();
    }
    process.stdout.write(c.dim('\n  Checking current prices...\n'));
    const name = await tokenNames(open.map(([m]) => m));
    const rows = await Promise.all(open.map(async ([mint, pos]) => ({ mint, pos, worth: await positionWorth(mint, pos, cfg.sellSlippageBps) })));
    process.stdout.write(`\n  ${pad('#', 3)}${pad('Token', 14)}${pad('Bought', 10)}${pad('Copied from', 14)}${pad('Paid', 13)}${pad('Worth now', 13)}Profit/loss\n`);
    let paid = 0;
    let worth = 0;
    rows.forEach(({ mint, pos, worth: w }, i) => {
      paid += pos.solSpent;
      worth += w ?? pos.solSpent;
      const pnl = w == null ? c.dim('price unavailable') : `${signed(w - pos.solSpent)} (${(((w - pos.solSpent) / pos.solSpent) * 100).toFixed(0)}%)`;
      process.stdout.write(
        `  ${pad(i + 1, 3)}${pad(name(mint), 14)}${pad(ago(pos.openedAt), 10)}${pad(pos.sourceLabel, 14)}${pad(sol(pos.solSpent), 13)}${pad(w == null ? '-' : sol(w), 13)}${pnl}\n`,
      );
    });
    process.stdout.write(`\n  Total paid ${sol(paid)}, worth ${sol(worth)} now: ${signed(worth - paid)} if you sold everything.\n`);
    process.stdout.write(c.dim('  "Worth now" is what selling would return right now, after price impact.\n'));
    closeHint();
  }

  async function showHistory() {
    openScreen('TRADE HISTORY: recent trades and results');
    const trades = readTrades(book.tradeLogFile);
    if (!trades.length) {
      process.stdout.write('\n  No trades yet. They appear here as soon as the bot copies something.\n');
      return closeHint();
    }
    const sum = summarize(trades, book.positions.dayStart());
    process.stdout.write(`\n  ${c.bold('Summary')}\n`);
    process.stdout.write(`    Buys: ${sum.buys}   Sells: ${sum.sells}   Wins: ${c.green(sum.wins)}   Losses: ${c.red(sum.losses)}`);
    process.stdout.write(sum.winRate != null ? `   Win rate: ${Math.round(sum.winRate * 100)}%\n` : '\n');
    process.stdout.write(`    Profit/loss from closed trades: ${signed(sum.totalPnl)} total, ${signed(sum.todayPnl)} today\n`);

    const recent = trades.slice(-15).reverse();
    const name = await tokenNames(recent.map((t) => t.token));
    process.stdout.write(`\n  ${c.bold('Last 15 trades (newest first)')}\n`);
    process.stdout.write(`  ${pad('When', 10)}${pad('Action', 8)}${pad('Token', 14)}${pad('SOL', 11)}${pad('Profit/loss', 18)}Why\n`);
    for (const t of recent) {
      const isSell = t.action.endsWith('sell');
      const pnl = t.pnl_sol === '' ? pad('', 18) : padColor(`${Number(t.pnl_sol) >= 0 ? '+' : ''}${Number(t.pnl_sol).toFixed(4)}`, 18, Number(t.pnl_sol) >= 0 ? c.green : c.red);
      process.stdout.write(
        `  ${pad(ago(t.time), 10)}${padColor(isSell ? 'SELL' : 'BUY', 8, isSell ? c.yellow : c.cyan)}${pad(name(t.token), 14)}${pad(Number(t.sol).toFixed(4), 11)}${pnl}${t.reason}\n`,
      );
    }
    process.stdout.write(c.dim(`\n  Full history (opens in Excel/Numbers): ${book.tradeLogFile}\n`));
    closeHint();
  }

  function listReports() {
    if (!fs.existsSync(researchDir)) return [];
    return fs
      .readdirSync(researchDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => ({ f, at: fs.statSync(path.join(researchDir, f)).mtimeMs }))
      .sort((a, b) => b.at - a.at)
      .slice(0, 30);
  }

  function showReportList() {
    openScreen('RESEARCH REPORTS: AI breakdowns of tokens');
    reportFiles = listReports();
    if (!reportFiles.length) {
      process.stdout.write(
        research
          ? '\n  No reports yet. They are written automatically when the bot buys a token,\n  or paste any token address (CA) into the live feed to research it.\n'
          : '\n  Research is off. Add a free Groq key to .env (see README) to turn it on.\n',
      );
      return closeHint();
    }
    process.stdout.write(`\n  ${pad('#', 4)}${pad('Token', 16)}${pad('When', 10)}TL;DR\n`);
    reportFiles.forEach(({ f, at }, i) => {
      const text = fs.readFileSync(path.join(researchDir, f), 'utf8');
      const narrative = reportSummary(text).slice(0, 44);
      process.stdout.write(`  ${pad(i + 1, 4)}${pad(`$${f.split('-')[0]}`, 16)}${pad(ago(at), 10)}${narrative}\n`);
    });
    state = 'reports';
    process.stdout.write(`\n${c.dim('Type a report number and press Enter to read it, or just press Enter to go back.')}\n`);
  }

  function showReport(n) {
    const item = reportFiles[n - 1];
    if (!item) return process.stdout.write(c.dim(`There's no report #${n}. Type a number from the list, or press Enter to go back.\n`));
    const text = fs.readFileSync(path.join(researchDir, item.f), 'utf8');
    const pretty = text
      .split('\n')
      .map((l) => (l.startsWith('### ') ? `\n${c.bold(c.cyan(l.slice(4)))}` : l.replaceAll('**', '')))
      .join('\n');
    process.stdout.write(`\n${LINE}\n${pretty}\n${LINE}\n`);
    process.stdout.write(c.dim('Type another report number, or press Enter to go back to the live feed.\n'));
  }

  function showScoreboard() {
    openScreen('WALLET SCOREBOARD: which copied wallets make money');
    const rows = scoreboard(readTrades(book.tradeLogFile), cfg.wallets);
    process.stdout.write(`\n  ${pad('Wallet', 16)}${pad('Buys copied', 13)}${pad('Closed', 9)}${pad('Win rate', 10)}Profit/loss\n`);
    for (const s of rows) {
      const rate = s.closed ? `${Math.round((s.wins / s.closed) * 100)}%` : '-';
      process.stdout.write(`  ${pad(s.label, 16)}${pad(s.copies, 13)}${pad(s.closed, 9)}${pad(rate, 10)}${signed(s.pnl)}\n`);
    }
    process.stdout.write(c.dim('\n  Best wallets are at the top. Give a wallet at least 10 closed trades before judging it.\n'));
    process.stdout.write(c.dim('  To drop a losing wallet, type remove and its nickname (like: remove whale1).\n'));
    closeHint();
  }

  function showSettings() {
    openScreen('SETTINGS: what the bot is doing');
    const lines = settingsRows(cfg, research);
    process.stdout.write('\n');
    for (const [k, v] of lines) process.stdout.write(`  ${pad(k, 28)}${v}\n`);
    process.stdout.write(c.dim(`\n  Take profit and stop loss: type tp 50 or sl 25 (or "off"). The dashboard's Loadout tab changes more.\n  Everything else: edit config.json in this folder with TextEdit, save, and restart the bot:\n  ${file('config.json')}\n  The README explains every setting.\n`));
    closeHint();
  }

  function handle(line) {
    const input = line.trim();
    if (state === 'reports') {
      if (!input) return backToFeed();
      if (/^\d+$/.test(input)) return showReport(Number(input));
    }
    if (state === 'screen' || state === 'reports') return backToFeed();

    const pick = input.toLowerCase();
    if (pick === '1') return showPositions().catch((e) => log(`Couldn't show positions: ${e.message}`));
    if (pick === '2') return showHistory().catch((e) => log(`Couldn't show history: ${e.message}`));
    if (pick === '3') return showReportList();
    if (pick === '4') return showScoreboard();
    if (pick === '5') return showSettings();
    if (pick === 'm' || pick === 'menu' || pick === 'help') return write(menuText());
    if (pick === 'd' && dashboard) return dashboard.open();

    if (pick.startsWith('ask ') && dashboard) {
      log(c.dim('Asking SolBoy Assistant...'));
      dashboard
        .ask(input.slice(4))
        .then((r) => {
          write(`\n${c.bold('SolBoy Assistant')} ${c.dim(`(${r.engine})`)}\n${r.text.trim()}\n`);
          for (const n of r.notes) write(`${c.yellow(n)}\n`);
          for (const p of r.proposals) write(`${c.cyan('Suggested change:')} ${p.summary}. Confirm it in the dashboard's assistant to apply it.\n`);
          write('\n');
        })
        .catch((e) => {
          const msg = dashboard.assistantError(e);
          log(c.red(msg === 'NO_KEY' ? 'The assistant needs a free Groq key. Add it in the dashboard (Ask SolBoy button).' : `Assistant error: ${msg}`));
        });
      return;
    }
    if (pick === 'reset') {
      return bot.resetDay();
    }
    if (pick === 'update' && updater) {
      const st = updater.status();
      if (!st.available) {
        updater.check(true).then((r) => log(r ? `SolBoy ${r.version} is out. Type ${c.cyan('update')} again to install it.` : `You're on the newest SolBoy (${st.version}).`));
        return;
      }
      log(`Updating to SolBoy ${st.available.version}. Your settings, keys, wallets and trades stay as they are...`);
      updater
        .install()
        .then(() => setTimeout(() => process.exit(RESTART_CODE), 300))
        .catch((e) => log(c.red(`Update failed: ${e.message}`)));
      return;
    }
    if (pick === 'account') {
      if (!account.address()) return log(`No SolBoy wallet yet. Open the dashboard's Account tab to create one${dashboard ? ` (${dashboard.url})` : ''}.`);
      account
        .balance(true)
        .then((sol) => log(`SolBoy wallet ${account.address()}: ${sol.toFixed(4)} SOL. Send SOL to that address to fund it. Mode: ${cfg.dryRun ? 'paper' : 'REAL MONEY'}.`))
        .catch((e) => log(`Couldn't check the balance: ${e.message}`));
      return;
    }

    const [cmd, arg1, ...rest] = input.split(/\s+/);
    if (cmd.toLowerCase() === 'add') {
      if (!arg1) return log(`Type ${c.cyan('add')} then the wallet address, and optionally a nickname. Example: add 5NU3...h1y whale2`);
      try {
        const w = bot.addWallet({ address: arg1, label: rest.join(' ') });
        return log(c.green(`Added ${w.label}. SolBoy is copying it now, and it's saved for next time.`));
      } catch (e) {
        return log(c.red(`Couldn't add it: ${e.message}`));
      }
    }
    if (['tp', 'sl'].includes(cmd.toLowerCase())) {
      const key = cmd.toLowerCase() === 'tp' ? 'takeProfitPct' : 'stopLossPct';
      if (!arg1) return log(`Type ${c.cyan(cmd.toLowerCase())} then a percent, like ${c.cyan(`${cmd.toLowerCase()} ${key === 'takeProfitPct' ? 50 : 25}`)}, or ${c.cyan('off')}.`);
      try {
        return log(c.green(`${applySetting(cfg, key, arg1).summary}. Saved, and working now.`));
      } catch (e) {
        return log(c.red(e.message));
      }
    }
    if (cmd.toLowerCase() === 'remove') {
      if (!arg1) return log(`Type ${c.cyan('remove')} then the wallet's nickname. Your wallets: ${cfg.wallets.map((w) => w.label).join(', ')}`);
      try {
        bot.removeWallet([arg1, ...rest].join(' '));
      } catch (e) {
        log(c.red(e.message));
      }
      return;
    }
    if (!input) return;

    const ca = input.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/)?.[0];
    if (ca && research) {
      try {
        new PublicKey(ca);
        return research(ca, { trigger: 'manual lookup by the user' }, true);
      } catch {}
    }
    log(`Didn't understand "${input.slice(0, 40)}". Type ${c.cyan('m')} and press Enter to see the menu.`);
  }

  return {
    start() {
      write(menuText());
      const rl = readline.createInterface({ input: process.stdin });
      rl.on('SIGINT', () => process.exit(0));
      rl.on('line', handle);
    },
  };
}
