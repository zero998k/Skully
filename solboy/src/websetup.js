import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Connection } from '@solana/web3.js';
import { DEFAULTS, checkWallet, saveWallets } from './config.js';
import { setEnvValue } from './envfile.js';
import { hashPassword } from './auth.js';
import { PROVIDERS, AiError, listModels } from './ai.js';
import { needsRpcKey, needsWallets, needsResearchChoice, extractKey } from './setup.js';
import { file } from './paths.js';
import { log } from './log.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function page({ needPassword, needRpc, needWallets, needAi }) {
  const field = (label, hint, input) => `<label><b>${label}</b><small>${hint}</small>${input}</label>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>SolBoy setup</title>
<style>
:root{--bg:#050505;--panel:#0d0d0d;--edge:#2b2b2b;--ink:#fafafa;--ink2:#b4b4b4;--ink3:#7a7a7a;--accent:#ff2d95;--sun:#ffd23f}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,sans-serif}
main{max-width:620px;margin:40px auto;padding:0 16px}
h1{font-size:34px;margin:0 0 4px;letter-spacing:-1px}h1 b{color:var(--accent)}
p.lead{color:var(--ink2);margin:0 0 24px}
form{background:var(--panel);border:2px solid var(--edge);border-radius:22px;padding:22px;box-shadow:6px 6px 0 var(--accent);display:grid;gap:18px}
label{display:grid;gap:6px}label small{color:var(--ink3);font-size:13px}label small a{color:#5ce1ff}
input,textarea{font:14px ui-monospace,Menlo,monospace;color:var(--ink);background:var(--bg);border:2px solid var(--edge);border-radius:12px;padding:11px 13px;width:100%}
textarea{min-height:90px;resize:vertical}
button{font:800 16px system-ui,sans-serif;color:#fff;background:var(--accent);border:2px solid #000;border-radius:14px;padding:13px 18px;cursor:pointer;box-shadow:4px 4px 0 #fafafa}
.err{color:#ff5470;min-height:1em}.ok{color:#4ade80}
</style></head><body><main>
<h1>SOL<b>BOY</b> setup</h1><p class="lead">One-time setup for your always-on SolBoy. Takes about 2 minutes.</p>
<form id="f">
${field('Setup code', 'Shown by the installer when you set up the server (and in the server log).', '<input name="code" autocomplete="off" required>')}
${needPassword ? field('Create a password', 'You\'ll use this to log in to your SolBoy site. At least 10 characters.', '<input name="password" type="password" autocomplete="new-password" minlength="10" required>') + field('Type it again', '', '<input name="password2" type="password" autocomplete="new-password" required>') : ''}
${needRpc ? field('Helius API key', 'Free at <a href="https://www.helius.dev" target="_blank" rel="noopener">helius.dev</a>. Copy the API key from your dashboard. (Advanced: a full RPC URL also works.)', '<input name="rpc" autocomplete="off" required>') : ''}
${needWallets ? field('Wallets to copy', 'One per line. Optionally add a nickname after the address, like:<br><code>5NU3oN4f...3h1y whale1</code>', '<textarea name="wallets" required></textarea>') + field('SOL per copied trade', 'Paper mode first, so this is practice money. You can change it later.', `<input name="buy" value="${DEFAULTS.buyAmountSol}" inputmode="decimal">`) : ''}
${needAi ? field('Groq API key (optional, free)', 'Turns on the Ask SolBoy assistant. Get one at <a href="https://console.groq.com/keys" target="_blank" rel="noopener">console.groq.com/keys</a>. Leave empty to skip.', '<input name="groq" autocomplete="off">') : ''}
<div class="err" id="err"></div>
<button type="submit" id="go">Finish setup</button>
</form></main>
<script>
document.getElementById('f').onsubmit = async (e) => {
  e.preventDefault();
  const err = document.getElementById('err'), go = document.getElementById('go');
  const data = Object.fromEntries(new FormData(e.target));
  if (data.password !== undefined && data.password !== data.password2) { err.textContent = "The passwords don't match."; return; }
  go.disabled = true; go.textContent = 'Checking...'; err.textContent = '';
  try {
    const res = await fetch('/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error);
    err.className = 'ok'; err.textContent = 'All set! Starting SolBoy...';
    for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 1000)); try { const r = await fetch('/login'); if (r.ok) { location.href = '/login'; return; } } catch {} }
  } catch (x) { err.className = 'err'; err.textContent = x.message; go.disabled = false; go.textContent = 'Finish setup'; }
};
</script></body></html>`;
}

/**
 * Server mode's first-run setup, done in the browser. Locked with a setup code (from the installer or
 * the server log) so a stranger who finds the server first can't claim it. Resolves once everything is saved.
 */
export async function runWebSetupIfNeeded({ port, host }) {
  const need = {
    needPassword: !process.env.DASHBOARD_PASSWORD_HASH?.trim(),
    needRpc: needsRpcKey(),
    needWallets: needsWallets(),
    needAi: needsResearchChoice(),
  };
  if (!need.needPassword && !need.needRpc && !need.needWallets) return;

  const code = process.env.SETUP_CODE?.trim() || crypto.randomBytes(4).toString('hex');
  log(`SolBoy needs setting up. Open your SolBoy web address and enter setup code: ${code}`);
  let attempts = 0;

  await new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const send = (status, body, type = 'application/json') => {
        res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        res.end(type === 'application/json' ? JSON.stringify(body) : body);
      };
      if (req.method !== 'POST' || req.url !== '/setup') return send(200, page(need), 'text/html; charset=utf-8');

      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 50_000) return send(400, { error: 'Too much data.' });
      }
      let d;
      try {
        d = JSON.parse(body);
      } catch {
        return send(400, { error: 'Bad request.' });
      }
      if (++attempts > 20) return send(429, { error: 'Too many attempts. Restart SolBoy to try again.' });
      const fail = (msg) => send(400, { error: msg });

      if (String(d.code ?? '').trim() !== code) return fail('Wrong setup code. Copy it from the installer or the server log.');
      if (need.needPassword && String(d.password ?? '').length < 10) return fail('Pick a password with at least 10 characters.');

      let rpcUrl = process.env.RPC_URL;
      let wsUrl = process.env.WS_URL;
      if (need.needRpc) {
        const raw = String(d.rpc ?? '').trim();
        rpcUrl = /^https?:\/\//.test(raw) ? raw : `https://mainnet.helius-rpc.com/?api-key=${extractKey(raw)}`;
        wsUrl = rpcUrl.replace(/^http/, 'ws');
        try {
          await new Connection(rpcUrl).getSlot();
        } catch (e) {
          return fail(`That Helius key didn't work (${e.message}). Check you copied the whole key.`);
        }
      }

      const wallets = [];
      if (need.needWallets) {
        const lines = String(d.wallets ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
        if (!lines.length) return fail('Add at least one wallet to copy.');
        try {
          for (const line of lines) {
            const [address, ...nick] = line.split(/[\s,]+/);
            wallets.push(checkWallet({ address, label: nick.join(' ') }, wallets));
          }
        } catch (e) {
          return fail(e.message);
        }
        if (!(Number(d.buy) > 0)) return fail('SOL per trade must be a number above 0, like 0.05.');
      }

      let groqKey = null;
      if (need.needAi && String(d.groq ?? '').trim()) {
        groqKey = String(d.groq).trim();
        try {
          await listModels(PROVIDERS.groq, groqKey);
        } catch (e) {
          if (e instanceof AiError) return fail(e.message);
        }
      }

      // Everything checked: save it.
      if (need.needPassword) setEnvValue('DASHBOARD_PASSWORD_HASH', hashPassword(d.password));
      if (need.needRpc) {
        setEnvValue('RPC_URL', rpcUrl);
        setEnvValue('WS_URL', wsUrl);
      }
      if (need.needAi) groqKey ? setEnvValue('GROQ_API_KEY', groqKey) : setEnvValue('RESEARCH_SKIPPED', 'GROQ_API_KEY');
      if (need.needWallets) {
        if (fs.existsSync(file('config.json'))) saveWallets(wallets);
        else fs.writeFileSync(file('config.json'), JSON.stringify({ ...DEFAULTS, wallets, buyAmountSol: Number(d.buy), keepAwake: false, dashboard: { ...DEFAULTS.dashboard, openBrowser: false } }, null, 2) + '\n');
      }
      log('Setup saved from the browser. Starting SolBoy...');
      send(200, { ok: true });
      setTimeout(() => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }, 300);
    });
    server.once('error', reject);
    server.listen(port, host);
  });
}
