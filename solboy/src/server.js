import http from 'node:http';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import DASHBOARD_HTML, { GUEST_HTML } from './dashboard-html.js';
import { createShare } from './share.js';
import { createClub } from './club.js';
import { log, onLog, readTrades } from './log.js';
import { summarize, scoreboard } from './stats.js';
import { tokenNames } from './tokens.js';
import { settingsRows } from './ui.js';
import { applySetting, settingValue } from './settings.js';
import { file } from './paths.js';
import { createAssistant } from './assistant.js';
import { AiError } from './ai.js';
import { createAuth } from './auth.js';
import { createSolRate } from './sol-rate.js';
import { RESTART_CODE } from './update.js';

// Settings the dashboard's Quick settings card can change while SolBoy runs.
const QUICK = ['takeProfitPct', 'stopLossPct', 'buyAmountSol', 'dailyLossLimitSol', 'maxOpenPositions', 'onlyFirstBuy', 'sellOnlyOnFullExit'];

function classify(text) {
  if (/BOUGHT/.test(text)) return 'buy';
  if (/SOLD/.test(text)) return 'sell';
  if (/^\S+ (BUY|SELL) /.test(text)) return 'spotted';
  if (/fail|error|limit reached|dropped|WARNING|declined|took too long/i.test(text)) return 'warn';
  if (/skip|not selling/i.test(text)) return 'skip';
  return 'info';
}

const LOGIN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>SolBoy login</title>
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#050505;color:#fafafa;font:15px/1.5 system-ui,sans-serif;padding:16px}
form{width:min(380px,100%);background:#0d0d0d;border:2px solid #2b2b2b;border-radius:22px;padding:24px;box-shadow:6px 6px 0 #ff2d95;display:grid;gap:14px}
h1{margin:0;font-size:30px;letter-spacing:-1px}h1 b{color:#ff2d95}input{font:15px system-ui;color:#fafafa;background:#050505;border:2px solid #2b2b2b;border-radius:12px;padding:12px}
button{font:800 16px system-ui;color:#fff;background:#ff2d95;border:2px solid #000;border-radius:14px;padding:12px;cursor:pointer;box-shadow:4px 4px 0 #fafafa}.err{color:#ff5470;min-height:1em}</style></head>
<body><form id="f"><h1>SOL<b>BOY</b></h1><input id="pw" type="password" placeholder="Password" autocomplete="current-password" autofocus required><div class="err" id="err"></div><button>Log in</button></form>
<script>document.getElementById('f').onsubmit=async(e)=>{e.preventDefault();const r=await fetch('/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:document.getElementById('pw').value})});
if(r.ok)location.href='/';else document.getElementById('err').textContent=(await r.json()).error;};</script></body></html>`;

function openInBrowser(url) {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  execFile(cmd, args, () => {});
}

/**
 * The game-style dashboard, served only to this computer (127.0.0.1). Every API call must carry
 * a secret made fresh each run and baked into the page, so other websites can't read or click anything.
 */
export async function startDashboard({ cfg, bot, book, account, updater, finder, walletPortfolio, serverMode = false }) {
  const positions = book.positions;
  const solRate=createSolRate();solRate.start();
  const secret = crypto.randomBytes(16).toString('hex');
  const page = DASHBOARD_HTML.replace('__TOKEN__', secret).replace('__SERVER_MODE__', serverMode ? 'true' : 'false');
  const auth = serverMode ? createAuth(() => process.env.DASHBOARD_PASSWORD_HASH, file('data/sessions.json')) : null;
  const backlog = [];
  const clients = new Set();
  let lastState = null;
  let portfolioRevision = 0;
  bot.onPrices?.(data=>{
    for(const res of clients)res.write(`event: prices\ndata: ${JSON.stringify(data)}\n\n`);
  });

  onLog((e) => {
    const ev = { ...e, kind: classify(e.text) };
    backlog.push(ev);
    if (backlog.length > 80) backlog.shift();
    for (const res of clients) res.write(`data: ${JSON.stringify(ev)}\n\n`);
    if (ev.kind === 'buy' || ev.kind === 'sell' || /sell failed|Copy sell retry/.test(ev.text)) {
      portfolioRevision++;
      const data = JSON.stringify(portfolioSnapshot());
      for (const res of clients) res.write(`event: portfolio\ndata: ${data}\n\n`);
    }
  });
  setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
  }, 20_000).unref();

  function walletRows(trades) {
    const stats = new Map(scoreboard(trades, cfg.wallets).map((s) => [s.label, s]));
    return cfg.wallets
      .map((w) => ({
        label: w.label,
        address: w.address,
        buyAmountSol: w.buyAmountSol ?? cfg.buyAmountSol,
        customAmount: Boolean(w.buyAmountSol),
        retiring: Boolean(w.retiring),
        paused: Boolean(w.paused),
        holding: positions.entries().filter(([, p]) => p.source === w.address).length,
        ...stats.get(w.label),
      }))
      .sort((a, b) => b.pnl - a.pnl);
  }

  // Completed trades are already recorded locally. Publish that state immediately; prices,
  // token names and account balances can arrive on the normal refresh without delaying it.
  function portfolioSnapshot() {
    const trades = readTrades(book.tradeLogFile), counted = positions.counted(trades);
    const names = new Map([...(lastState?.inventory ?? []).map(p => [p.mint, p.name]), ...(lastState?.trades ?? []).map(t => [t.token, t.name])]);
    return {
      solRate:solRate.get(),copyActivity:bot.copyActivity?.()??[],pendingBuys:positions.entries().filter(([,p])=>p.pendingBuy).map(([mint,p])=>({mint,from:p.sourceLabel,sig:p.pendingBuy.sig})),
      paperWallet:book.paperWallet?.status()??null,portfolioRevision, mode: book.mode, paused: bot.isBuyingPaused(), copySpeed: bot.copySpeed(),
      summary: summarize(counted, positions.dayStart()), todayPnl: positions.todayPnl(),
      dayResetAt: positions.resetToday(), dailyLossLimit: cfg.dailyLossLimitSol, maxSlots: cfg.maxOpenPositions,
      inventory: positions.entries().filter(([,p])=>!p.pendingBuy).map(([mint, pos]) => ({ mint, name: names.get(mint) ?? mint,
        pendingSell: pos.pendingSell ? { sig: pos.pendingSell.sig, submittedAt: pos.pendingSell.submittedAt } : null,
        copiedSell:pos.copiedExit?{attempts:pos.copiedExit.attempts,nextAttemptAt:pos.copiedExit.nextAttemptAt,lastError:pos.copiedExit.lastError,paused:!cfg.followSells}:null,
        from: pos.sourceLabel, paid: pos.solSpent, openedAt: pos.openedAt, tokens: pos.tokens,
        ...(bot.priceOf?.(mint,pos)??{worth:null,priceStale:true}) })),
      trades: trades.slice(-50).reverse().map(t => ({ ...t, name: names.get(t.token) ?? t.token })),
      wallets: walletRows(counted),
    };
  }

  async function accountState() {
    let balance = null;
    try {
      balance = await account.balance();
    } catch {}
    return { address: account.address(), balance, minLive: +(cfg.buyAmountSol + 0.02).toFixed(4), livePositions: account.livePositions() };
  }

  async function state() {
    const revision = portfolioRevision;
    const trades = readTrades(book.tradeLogFile);
    const open = positions.entries().filter(([,p])=>!p.pendingBuy);
    const recent = trades.slice(-50).reverse();
    const name = await tokenNames([...open.map(([m]) => m), ...recent.map((t) => t.token)]);
    const inventory = open.map(([mint, pos]) => ({
        mint,
        name: name(mint),
        pendingSell: pos.pendingSell ? { sig: pos.pendingSell.sig, submittedAt: pos.pendingSell.submittedAt } : null,
        copiedSell:pos.copiedExit?{attempts:pos.copiedExit.attempts,nextAttemptAt:pos.copiedExit.nextAttemptAt,lastError:pos.copiedExit.lastError,paused:!cfg.followSells}:null,
        from: pos.sourceLabel,
        paid: pos.solSpent,
        tokens: pos.tokens,
        openedAt: pos.openedAt,
        ...(bot.priceOf?.(mint,pos)??{worth:null,priceStale:true}),
      }));
    const next = {
      solRate:solRate.get(),copyActivity:bot.copyActivity?.()??[],pendingBuys:positions.entries().filter(([,p])=>p.pendingBuy).map(([mint,p])=>({mint,from:p.sourceLabel,sig:p.pendingBuy.sig})),
      portfolioRevision: revision,
      mode: book.mode,
      paperWallet:book.paperWallet?.status()??null,
      account: await accountState(),
      paused: bot.isBuyingPaused(),
      copySpeed: bot.copySpeed(),
      summary: summarize(positions.counted(trades), positions.dayStart()),
      dayResetAt: positions.resetToday(),
      todayPnl: positions.todayPnl(),
      dailyLossLimit: cfg.dailyLossLimitSol,
      maxSlots: cfg.maxOpenPositions,
      defaultBuy: cfg.buyAmountSol,
      inventory,
      trades: recent.map((t) => ({ ...t, name: name(t.token) })),
      wallets: walletRows(positions.counted(trades)),
      settings: settingsRows(cfg).map(([k, v]) => [k, String(v)]),
      configPath: file('config.json'),
      update: updater?.status() ?? null,
      quick: Object.fromEntries(QUICK.map((k) => [k, settingValue(cfg, k) ?? null])),
      tradeLogFile: book.tradeLogFile,
    };
    lastState = next;
    return next;
  }

  const assistant = createAssistant({ cfg, bot, book, getState: state });

  // Turn AI errors into something a person can act on.
  function assistantError(e) {
    if (e instanceof AiError && e.message === 'NO_KEY') return 'NO_KEY';
    if (e?.status === 401 || /rejected the API key|authentication/i.test(e?.message ?? '')) return 'That AI key was rejected. Re-enter it below.';
    if (e?.status === 429 || /limit reached|rate limit/i.test(e?.message ?? '')) return 'The AI is busy or you hit its free limit. Try again in a minute.';
    if (e?.status === 400 && /credit|billing|balance/i.test(e?.message ?? '')) return 'Your Anthropic account is out of credit. Top up at console.anthropic.com, or switch to the free model.';
    if (e?.name === 'TimeoutError') return 'The AI took too long. Try again.';
    return e?.message ?? 'Something went wrong.';
  }

  const readBody = (req, max = 60_000) =>
    new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (d) => {
        body += d;
        if (body.length > max) reject(new Error('That is too big.'));
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(body || '{}'));
        } catch {
          reject(new Error('bad JSON'));
        }
      });
    });

  const send = (res, status, data, type = 'application/json') => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' });
    res.end(type === 'application/json' ? JSON.stringify(data) : data);
  };

  let share = null; // the Finder share link, made once the port is known
  const club = finder ? createClub({ coinInfo: finder.coinInfo, hostStats: () => summarize(positions.counted(readTrades(book.tradeLogFile)), positions.dayStart()) }) : null;

  // The Social Lobby API, for the host (dashboard) and for friends (share link, with their session token).
  async function clubRoute(req, res, what, isHost, session) {
    const parts = what.split('/');
    if (req.method === 'GET' && parts[0] === 'img') {
      const img = club.image(parts[1], parts[2]);
      if (!img) return send(res, 404, { error: 'no picture' });
      res.writeHead(200, { 'Content-Type': img.type, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" });
      return res.end(img.body);
    }
    try {
      if (req.method === 'POST' && !isHost && what === 'signup') return send(res, 200, club.signup(await readBody(req)));
      if (req.method === 'POST' && !isHost && what === 'login') return send(res, 200, club.login(await readBody(req)));
      const me = club.whoIs(session, isHost);
      if (!me) return send(res, 401, { error: 'Log in to the Social Lobby first.' });
      const q = (k) => url.searchParams.get(k);
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET') {
        if (what === 'me') return send(res, 200, club.me(me));
        if (what === 'members') return send(res, 200, club.members());
        if (what === 'messages') return send(res, 200, club.messages(me, q('room') ?? 'lounge', Number(q('after') ?? 0)));
        if (what === 'unread') { let since = {}; try { since = JSON.parse(q('since') ?? '{}'); } catch {} return send(res, 200, club.unread(me, since)); }
        if (what === 'dms') return send(res, 200, club.dms(me));
        if (what === 'calls') return send(res, 200, await club.calls());
      } else if (req.method === 'POST') {
        const body = await readBody(req, what === 'profile' ? 800_000 : 60_000);
        if (what === 'logout') return send(res, 200, club.logout(session));
        if (what === 'profile') return send(res, 200, club.profile(me, body));
        if (what === 'send') return send(res, 200, club.send(me, body));
        if (what === 'react') return send(res, 200, club.react(me, body));
        if (what === 'remove') return send(res, 200, club.remove(me, body));
        if (what === 'call') return send(res, 200, await club.call(me, body));
        if (what === 'dm') return send(res, 200, { room: club.dmRoom(me, String(body.with ?? '')) });
        if (what === 'kick') return send(res, 200, club.kick(me, String(body.id ?? '')));
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      return send(res, e.status ?? 400, { error: e.message });
    }
  }

  // A friend's browser, through the share link: only the guest Finder page and its read-only scans.
  async function guest(req, res, url) {
    const m = url.pathname.match(/^\/g\/([\w-]{8,})(\/api\/(finder|club)\/([\w/-]+))?$/);
    const t = share?.guestToken();
    if (!m || !t || m[1].length !== t.length || !crypto.timingSafeEqual(Buffer.from(m[1]), Buffer.from(t))) return send(res, 404, 'This link is off. Ask your friend for a new one.', 'text/plain; charset=utf-8');
    if (!m[2]) return send(res, 200, GUEST_HTML, 'text/html; charset=utf-8');
    if (m[3] === 'club' && club) return clubRoute(req, res, m[4], false, String(req.headers['x-club-session'] ?? ''));
    if (req.method !== 'GET' || !finder) return send(res, 404, { error: 'not found' });
    const a = url.searchParams.get('a');
    try {
      if (m[4] === 'kind') return send(res, 200, await finder.kind(a));
      if (m[4] === 'wallet') return send(res, 200, finder.wallet(a, false));
      if (m[4] === 'linked') return send(res, 200, finder.linked(a));
      if (m[4] === 'coin') return send(res, 200, finder.coin(a));
      if (m[4] === 'replay') return send(res, 200, finder.replay(a, url.searchParams.get('days')));
    } catch {
      return send(res, 400, { error: "That isn't a valid Solana address." });
    }
    return send(res, 404, { error: 'not found' });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!serverMode && url.pathname.startsWith('/g/')) return guest(req, res, url);
    if (serverMode) {
      // Online: everything sits behind the password login.
      if (url.pathname === '/login') {
        if (req.method !== 'POST') return send(res, 200, LOGIN_PAGE, 'text/html; charset=utf-8');
        try {
          const cookie = await auth.login(req, (await readBody(req)).password);
          res.writeHead(200, { 'Set-Cookie': cookie, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          return res.end('{"ok":true}');
        } catch (e) {
          return send(res, 401, { error: e.message });
        }
      }
      if (!auth.isLoggedIn(req)) {
        if (url.pathname === '/') {
          res.writeHead(302, { Location: '/login' });
          return res.end();
        }
        return send(res, 401, { error: 'Log in first.' });
      }
      if (req.method === 'POST' && url.pathname === '/api/logout') {
        res.writeHead(200, { 'Set-Cookie': auth.logout(req), 'Content-Type': 'application/json' });
        return res.end('{"ok":true}');
      }
    } else {
      // On your own computer: only pages opened on this computer may talk to SolBoy.
      const host = (req.headers.host ?? '').replace(/:\d+$/, '');
      const viaTunnel = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.headers['x-forwarded-host'];
      if ((host !== 'localhost' && host !== '127.0.0.1') || viaTunnel) return send(res, 403, { error: 'forbidden' });
    }
    if (url.pathname === '/') return send(res, 200, page, 'text/html; charset=utf-8');
    if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });
    if (url.searchParams.get('t') !== secret) return send(res, 403, { error: 'forbidden' });

    try {
      if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, await state());

      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        for (const ev of backlog) res.write(`data: ${JSON.stringify({ ...ev, backlog: true })}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/pause') {
        const { paused } = await readBody(req);
        bot.setBuyingPaused(Boolean(paused));
        return send(res, 200, { ok: true });
      }

      if (req.method === 'POST' && url.pathname === '/api/sell-all') {
        return send(res, 200, await bot.sellAll());
      }

      if (req.method === 'POST' && url.pathname === '/api/wallets/toggle') {
        const { key, paused } = await readBody(req);
        const w = bot.setWalletPaused(key, Boolean(paused));
        return send(res, 200, { label: w.label, paused: Boolean(w.paused) });
      }

      if (req.method === 'GET' && url.pathname === '/api/hypothetical') return send(res, 200, finder.hypothetical(readTrades(book.tradeLogFile), url.searchParams.get('refresh') === '1'));

      // Wallet Finder: scans run in the background; the page asks again until state is 'done'
      if (req.method === 'GET' && url.pathname.startsWith('/api/finder/')) {
        const what = url.pathname.slice('/api/finder/'.length), a = url.searchParams.get('a');
        try {
          if (what === 'kind') return send(res, 200, await finder.kind(a));
          if (what === 'wallet') return send(res, 200, finder.wallet(a, url.searchParams.get('refresh') === '1'));
          if (what === 'linked') return send(res, 200, finder.linked(a));
          if (what === 'coin') return send(res, 200, finder.coin(a));
          if (what === 'replay') return send(res, 200, finder.replay(a, url.searchParams.get('days')));
        } catch {
          return send(res, 400, { error: "That isn't a valid Solana address." });
        }
      }

      if (url.pathname.startsWith('/api/club/') && club) return clubRoute(req, res, url.pathname.slice('/api/club/'.length), true, '');

      if (url.pathname.startsWith('/api/share/') && !serverMode) {
        if (req.method === 'POST' && url.pathname === '/api/share/start') return send(res, 200, await share.start());
        if (req.method === 'POST' && url.pathname === '/api/share/stop') return send(res, 200, share.stop());
        return send(res, 200, share.status());
      }

      if(req.method==='POST'&&url.pathname==='/api/paper/balance'){
        try{
          const body=await readBody(req);if(body.unlimited!==true&&body.sol==null)throw new Error('Enter a starting paper balance in SOL.');
          const paperWallet=book.paperWallet.setStartingBalance(body.unlimited===true?null:body.sol);
          portfolioRevision++;const data=JSON.stringify(portfolioSnapshot());
          for(const client of clients)client.write(`event: portfolio\ndata: ${data}\n\n`);
          return send(res,200,paperWallet);
        }catch(error){return send(res,400,{error:error.message});}
      }

      if (req.method === 'POST' && url.pathname === '/api/sell') {
        const { mint } = await readBody(req);
        if (!positions.has(mint)) return send(res, 404, { error: "You don't hold that token anymore." });
        await bot.sellNow(mint);
        return send(res, 200, { ok: true });
      }

      if (req.method === 'GET' && url.pathname === '/api/account/portfolio') {
        // Use the existing balance refresh, never add an urgent RPC request to a trade update.
        const balance=lastState?.account?.address===account.address()?lastState.account.balance:null;
        return send(res, 200, {...walletPortfolio.get({balance,refresh:url.searchParams.get('refresh')==='1',
          knownValues:book.mode==='live' ? (lastState?.inventory??[]).filter(p=>!p.priceStale&&Date.now()<(p.priceValidUntil??0)) : []}),portfolioRevision});
      }

      if (req.method === 'GET' && url.pathname === '/api/account/qr') {
        const svg = await account.qrSvg();
        return svg ? send(res, 200, svg, 'image/svg+xml') : send(res, 404, { error: 'no wallet yet' });
      }

      if (req.method === 'POST' && url.pathname.startsWith('/api/account/')) {
        const body = await readBody(req);
        try {
          // Online, the risky money actions need the password again, even when already logged in.
          const risky = url.pathname === '/api/account/withdraw' || url.pathname === '/api/account/key' || (url.pathname === '/api/account/mode' && body.mode === 'live');
          if (serverMode && risky) auth.confirm(body.password);
          if (url.pathname === '/api/account/create') return send(res, 200, { address: account.ensureWallet() });
          if (url.pathname === '/api/account/mode') {
            await account.setMode(body.mode === 'live' ? 'live' : 'paper', body.confirm === true);
            return send(res, 200, { ok: true });
          }
          if (url.pathname === '/api/account/withdraw') return send(res, 200, await account.withdraw(body.to, body.amount));
          if (url.pathname === '/api/account/key') {
            if (body.confirm !== 'SHOW') return send(res, 400, { error: 'Type SHOW to confirm.' });
            return send(res, 200, { key: account.exportKey() });
          }
        } catch (e) {
          return send(res, 400, { error: e.message });
        }
      }

      if (url.pathname === '/api/assistant/status') return send(res, 200, assistant.status());

      if (req.method === 'POST' && url.pathname.startsWith('/api/assistant/')) {
        const body = await readBody(req);
        try {
          if (url.pathname === '/api/assistant/ask') return send(res, 200, await assistant.ask(Array.isArray(body.messages) ? body.messages : []));
          if (url.pathname === '/api/assistant/apply') return send(res, 200, await assistant.apply(body.proposal ?? {}));
          if (url.pathname === '/api/assistant/key') return send(res, 200, await assistant.saveKey(body.kind, body.key));
          if (url.pathname === '/api/assistant/model') return send(res, 200, assistant.setModel(body.model));
        } catch (e) {
          return send(res, 400, { error: assistantError(e) });
        }
      }

      if (req.method === 'POST' && url.pathname === '/api/reset-pnl') {
        bot.resetPnl();
        return send(res, 200, { ok: true });
      }

      if (req.method === 'POST' && url.pathname === '/api/update/check') {
        await updater?.check(true);
        return send(res, 200, updater?.status() ?? null);
      }

      if (req.method === 'POST' && url.pathname === '/api/update') {
        try {
          const version = await updater.install();
          send(res, 200, { version });
          setTimeout(() => process.exit(RESTART_CODE), 500); // the launcher starts the new version
        } catch (e) {
          send(res, 400, { error: e.message });
        }
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/settings') {
        const body = await readBody(req);
        try {
          if (!QUICK.includes(body.setting)) return send(res, 400, { error: "That setting can't be changed here." });
          const out = applySetting(cfg, body.setting, body.value);
          log(`Setting changed from the dashboard. ${out.summary}`);
          return send(res, 200, out);
        } catch (e) {
          return send(res, 400, { error: e.message });
        }
      }

      if (req.method === 'POST' && url.pathname === '/api/wallets/add') {
        const body = await readBody(req);
        try {
          return send(res, 200, { wallet: bot.addWallet(body) });
        } catch (e) {
          return send(res, 400, { error: e.message });
        }
      }

      if (req.method === 'POST' && url.pathname === '/api/wallets/remove') {
        const { key } = await readBody(req);
        try {
          return send(res, 200, bot.removeWallet(key));
        } catch (e) {
          return send(res, 400, { error: e.message });
        }
      }

      send(res, 404, { error: 'not found' });
    } catch (e) {
      send(res, 500, { error: e.message });
    }
  });

  // Use the configured port, or the next free one if something else already has it.
  let port = cfg.dashboard.port;
  for (;; port++) {
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, process.env.HOST || '127.0.0.1', resolve);
      });
      break;
    } catch (e) {
      if (e.code !== 'EADDRINUSE' || port >= cfg.dashboard.port + 10) throw e;
    }
  }

  share = createShare({ port });
  const url = `http://localhost:${port}`;
  log(`Dashboard ready at ${url}`);
  if (cfg.dashboard.openBrowser && !serverMode) openInBrowser(url);
  return { url, open: () => openInBrowser(url), ask: (question) => assistant.ask([{ role: 'user', content: question }]), assistantError };
}
