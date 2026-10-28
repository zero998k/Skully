import http from 'node:http';
import { PublicKey } from '@solana/web3.js';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import DASHBOARD_HTML from './dashboard-html.js';
import PULSE_HTML from './pulse-html.js';
import { saveConfigValue } from './config.js';
import { log, onLog, readTrades } from './log.js';
import { summarize, scoreboard } from './stats.js';
import { tokenNames, positionWorth } from './tokens.js';
import { settingsRows } from './ui.js';
import { applySetting, settingValue } from './settings.js';

import { file } from './paths.js';
import { createAssistant } from './assistant.js';
import { AiError } from './ai.js';
import { createAuth } from './auth.js';
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
export async function startDashboard({ cfg, bot, book, account, updater, pulse = null, serverMode = false }) {
  const positions = book.positions;
  const secret = crypto.randomBytes(16).toString('hex');
  const page = DASHBOARD_HTML.replace('__TOKEN__', secret).replace('__SERVER_MODE__', serverMode ? 'true' : 'false');
  const pulsePage = PULSE_HTML.replace('__TOKEN__', secret).replace('__SERVER_MODE__', serverMode ? 'true' : 'false');
  const auth = serverMode ? createAuth(() => process.env.DASHBOARD_PASSWORD_HASH, file('data/sessions.json')) : null;
  const backlog = [];
  const clients = new Set();

  onLog((e) => {
    const ev = { ...e, kind: classify(e.text) };
    backlog.push(ev);
    if (backlog.length > 80) backlog.shift();
    for (const res of clients) res.write(`data: ${JSON.stringify(ev)}\n\n`);
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
        holding: positions.entries().filter(([, p]) => p.source === w.address).length,
        ...stats.get(w.label),
      }))
      .sort((a, b) => b.pnl - a.pnl);
  }

  async function worthFallback(mint, pos) {
    try {
      const v = await bot.valueOf(mint, pos.tokens);
      return v == null ? null : Number(v) / 1e9;
    } catch {
      return null;
    }
  }

  // Your position in one coin, for the Pulse trade box (value cached a few seconds so it doesn't spam quotes).
  const posCache = new Map();
  async function positionFor(mint) {
    const pos = positions.get(mint);
    if (!pos) return null;
    let hit = posCache.get(mint);
    if (!hit || hit.tokens !== pos.tokens || Date.now() - hit.at > 3000) {
      hit = { at: Date.now(), tokens: pos.tokens, worth: await worthFallback(mint, pos) };
      posCache.set(mint, hit);
    }
    return { solSpent: pos.solSpent, tokens: pos.tokens, worth: hit.worth, pnl: hit.worth == null ? null : hit.worth - pos.solSpent, from: pos.sourceLabel, mode: book.mode };
  }

  async function accountState() {
    let balance = null;
    try {
      balance = await account.balance();
    } catch {}
    return { address: account.address(), balance, minLive: +(cfg.buyAmountSol + 0.02).toFixed(4), livePositions: account.livePositions() };
  }

  async function state() {
    const trades = readTrades(book.tradeLogFile);
    const open = positions.entries();
    const recent = trades.slice(-50).reverse();
    const name = await tokenNames([...open.map(([m]) => m), ...recent.map((t) => t.token)]);
    const inventory = await Promise.all(
      open.map(async ([mint, pos]) => ({
        mint,
        name: name(mint),
        from: pos.sourceLabel,
        paid: pos.solSpent,
        openedAt: pos.openedAt,
        worth: (await positionWorth(mint, pos, cfg.sellSlippageBps)) ?? (await worthFallback(mint, pos)),
      })),
    );
    return {
      mode: book.mode,
      account: await accountState(),
      paused: bot.isBuyingPaused(),
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

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (d) => {
        body += d;
        if (body.length > 60_000) reject(new Error('too big'));
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

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
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
        if (url.pathname === '/' || url.pathname === '/pulse') {
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
      if (host !== 'localhost' && host !== '127.0.0.1') return send(res, 403, { error: 'forbidden' });
    }
    if (url.pathname === '/') return send(res, 200, page, 'text/html; charset=utf-8');
    if (url.pathname === '/pulse') return pulse ? send(res, 200, pulsePage, 'text/html; charset=utf-8') : send(res, 404, 'Pulse is turned off in config.json', 'text/plain');
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

      if (req.method === 'POST' && url.pathname === '/api/sell') {
        const { mint } = await readBody(req);
        if (!positions.has(mint)) return send(res, 404, { error: "You don't hold that token anymore." });
        await bot.sellNow(mint);
        return send(res, 200, { ok: true });
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

      if (url.pathname.startsWith('/api/pulse/')) {
        if (!pulse) return send(res, 404, { error: 'Pulse is turned off in config.json.' });
        const mintParam = url.searchParams.get('mint');
        const checkMint = (m) => {
          try {
            return new PublicKey(String(m)).toBase58();
          } catch {
            throw new Error("That isn't a valid coin address.");
          }
        };
        try {
          if (req.method === 'GET' && url.pathname === '/api/pulse/stream') {
            const focusMint = url.searchParams.get('focus') ? checkMint(url.searchParams.get('focus')) : null;
            const wantBoard = url.searchParams.get('board') === '1';
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
            const push = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
            let off = null;
            if (focusMint) {
              pulse.open(focusMint);
              off = pulse.onTrade((ev) => ev.mint === focusMint && push({ trade: ev.trade }));
            }
            let busy = false;
            const tick = async () => {
              if (busy) return;
              busy = true;
              try {
                push({ status: pulse.status(), mode: book.mode, ...(wantBoard ? { board: pulse.board() } : {}), ...(focusMint ? { position: await positionFor(focusMint) } : {}) });
              } catch {}
              busy = false;
            };
            tick();
            const timer = setInterval(tick, 1000);
            req.on('close', () => {
              clearInterval(timer);
              off?.();
              if (focusMint) pulse.close(focusMint);
            });
            return;
          }
          if (req.method === 'GET' && url.pathname === '/api/pulse/coin') return send(res, 200, { ...(await pulse.coin(checkMint(mintParam))), position: await positionFor(checkMint(mintParam)), mode: book.mode });
          if (req.method === 'GET' && url.pathname === '/api/pulse/candles') return send(res, 200, { candles: await pulse.history(checkMint(mintParam)) });
          if (req.method === 'GET' && url.pathname === '/api/pulse/filters') return send(res, 200, { filters: pulse.filters(), protocols: pulse.protocols, quickBuy: cfg.pulse.quickBuy, quickSell: cfg.pulse.quickSell, kols: cfg.pulse.kols });
          if (req.method === 'POST') {
            const body = await readBody(req);
            if (url.pathname === '/api/pulse/filters') return send(res, 200, { filters: pulse.setFilters(body.filters) });
            if (url.pathname === '/api/pulse/analyze') return send(res, 200, await pulse.analyze(checkMint(body.mint)));
            if (url.pathname === '/api/pulse/trade') {
              const out = await bot.manualTrade({ mint: checkMint(body.mint), side: body.side === 'sell' ? 'sell' : 'buy', sol: body.sol, percent: body.percent, slippagePct: body.slippagePct });
              posCache.delete(body.mint);
              return send(res, 200, out ?? { ok: true });
            }
            if (url.pathname === '/api/pulse/prefs') {
              const next = { ...cfg.pulse };
              const nums = (list, max) => (Array.isArray(list) ? list.map(Number).filter((n) => n > 0 && n <= max).slice(0, 6) : null);
              if (body.quickBuy) next.quickBuy = nums(body.quickBuy, 1000) ?? next.quickBuy;
              if (body.quickSell) next.quickSell = nums(body.quickSell, 100) ?? next.quickSell;
              if (Array.isArray(body.kols)) {
                next.kols = body.kols.slice(0, 500).map((k) => ({ address: checkMint(k.address), label: String(k.label ?? '').trim().slice(0, 30) || 'KOL' }));
              }
              cfg.pulse = next;
              saveConfigValue('pulse', next);
              return send(res, 200, { ok: true, quickBuy: next.quickBuy, quickSell: next.quickSell, kols: next.kols });
            }
          }
          return send(res, 404, { error: 'not found' });
        } catch (e) {
          return send(res, 400, { error: e.message });
        }
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

  const url = `http://localhost:${port}`;
  log(`Dashboard ready at ${url}`);
  if (cfg.dashboard.openBrowser && !serverMode) openInBrowser(url);
  return { url, open: () => openInBrowser(url), ask: (question) => assistant.ask([{ role: 'user', content: question }]), assistantError };
}
