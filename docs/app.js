/* Scout for iPad · the screens.
   Trade: find → check → plan → buy. Live: watch the price and get told when your plan says sell.
   Journal: review. Everything you log stays on this iPad. Scout never trades and never touches a wallet. */
(function () {
  'use strict';
  const C = window.ScoutCore, D = window.ScoutData;
  const VERSION = '1.0.0';
  const STORE = 'scout-ipad-v1';
  const PRICE_EVERY = 8000;
  const PAGES = ['trade', 'radar', 'live', 'journal', 'rules'];
  const STEPS = [['find', 'Find'], ['check', 'Check'], ['plan', 'Plan'], ['buy', 'Buy'], ['watch', 'Watch'], ['review', 'Review']];
  const FEELING_LABELS = {calm: 'Calm', fomo: 'FOMO', scared: 'Scared', greedy: 'Greedy', revenge: 'Revenge', bored: 'Bored'};
  const STATUS_ICON = {pass: '✓', fail: '✕', warn: '!', unknown: '?', info: 'i'};
  const STATUS_WORD = {pass: 'passed', fail: 'failed', warn: 'warning', unknown: 'unknown', info: 'info'};
  const VERDICT_ICON = {skip: '✕', rules: '!', caution: '?', pass: '✓'};
  const SIGNAL_LINES = {hold: ['Hold', 'Everything is inside your plan.'],
    stop: ['Sell now', 'Your stop was hit. Waiting usually makes it worse.'],
    trail: ['Sell now', "It gave back your trailing stop from its best price. Lock in what's left."],
    target: ['Target hit', 'Sell now, or keep only a trailing stop running.'],
    time: ["Time's up", 'Your plan says to get out now, win or lose.']};
  const EXIT_WORDS = {stop: 'your stop', trail: 'your trailing stop', target: 'your target', time: 'the time limit', manual: 'you sold before any signal'};
  const motionOk = !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const $ = selector => document.querySelector(selector);
  const finite = value => typeof value === 'number' && Number.isFinite(value);

  // Builds elements. Text always goes in as text, never as HTML.
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key === 'value') el.value = value;
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
      else el.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }
  // Replaces an element's children; skips empty values and flattens lists, like h().
  function fill(el, ...children) {
    el.replaceChildren(...children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false));
    return el;
  }
  function link(href, label, cls) {
    if (typeof href !== 'string' || !href.startsWith('https://')) return null;
    return h('a', {href, target: '_blank', rel: 'noopener noreferrer', class: cls || 'link'}, label);
  }
  function avatar(symbol, url) {
    const letters = h('span', {class: 'avatar', 'aria-hidden': 'true'}, String(symbol || '?').replace(/[^\w]/g, '').slice(0, 2).toUpperCase() || '?');
    const safe = C.safeImage(url);
    if (!safe) return letters;
    const img = h('img', {class: 'avatar', src: safe, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer'});
    img.addEventListener('error', () => img.replaceWith(letters), {once: true});
    return img;
  }
  function spinner() { return h('span', {class: 'spinner', 'aria-hidden': 'true'}); }
  function timeText(ms) { return new Date(ms).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'}); }
  function dateText(ms) { return new Date(ms).toLocaleString([], {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'}); }
  function debounce(fn, wait) { let timer = null; return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), wait); }; }
  function newId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '');
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  }

  // Saved data (this iPad only) ---------------------------------------------------
  function blank() {
    return {v: 1, rules: {}, strategy: {preset: 'blitz', edits: {}}, trades: [], checks: [], alerts: [], prefs: {sound: true, awake: true}, hints: {}};
  }
  function cleanTrade(t) {
    if (!t || typeof t !== 'object' || typeof t.id !== 'string' || !/^[\w-]{6,64}$/.test(t.id)) return null;
    if (!(t.status === 'open' || t.status === 'closed') || !C.addressOk(t.chain, t.address)) return null;
    if (![t.openedAt, t.entryPrice, t.sizeUsd, t.stopPct, t.targetPct, t.holdMinutes, t.costPct].every(finite) || !(t.entryPrice > 0)) return null;
    if (t.status === 'closed' && ![t.closedAt, t.exitPrice, t.pnlUsd].every(finite)) return null;
    const mark = finite(t.mark) && t.mark > 0 ? t.mark : t.entryPrice;
    const clean = list => (Array.isArray(list) ? list.map(item => C.text(item, 300)).filter(Boolean).slice(0, 12) : []);
    return {id: t.id, status: t.status, chain: t.chain, address: t.address, pair: C.poolIdOk(t.chain, t.pair) ? t.pair : null,
      symbol: C.text(t.symbol, 24) || 'COIN', name: C.text(t.name, 80), imageUrl: C.safeImage(t.imageUrl),
      openedAt: t.openedAt, entryPrice: t.entryPrice, sizeUsd: t.sizeUsd, stopPct: t.stopPct, targetPct: t.targetPct,
      trailingPct: finite(t.trailingPct) && t.trailingPct > 0 ? t.trailingPct : null, holdMinutes: t.holdMinutes, costPct: t.costPct,
      verdict: C.text(t.verdict, 12) || 'unknown', ruleBreaks: clean(t.ruleBreaks), overrideReason: C.text(t.overrideReason, 300) || null,
      mark, markAt: finite(t.markAt) ? t.markAt : t.openedAt, peak: finite(t.peak) ? Math.max(t.peak, mark) : mark,
      signal: C.SIGNALS[t.signal] ? t.signal : 'hold', firstSellAt: finite(t.firstSellAt) ? t.firstSellAt : null,
      firstSell: C.SIGNALS[t.firstSell] && t.firstSell !== 'hold' ? t.firstSell : null,
      missed: t.missed && finite(t.missed.at) && finite(t.missed.low) ? {kind: t.missed.kind === 'trail' ? 'trail' : 'stop', at: t.missed.at, low: t.missed.low} : null,
      samples: Array.isArray(t.samples) ? t.samples.filter(row => Array.isArray(row) && finite(row[0]) && finite(row[1]) && row[1] > 0).slice(-400) : [],
      closedAt: t.status === 'closed' ? t.closedAt : undefined, exitPrice: t.status === 'closed' ? t.exitPrice : undefined,
      pnlUsd: t.status === 'closed' ? t.pnlUsd : undefined, feeling: C.FEELINGS.includes(t.feeling) ? t.feeling : null,
      note: C.text(t.note, 500) || null, exitReason: EXIT_WORDS[t.exitReason] ? t.exitReason : t.status === 'closed' ? 'manual' : undefined,
      followedPlan: t.status === 'closed' ? Boolean(t.followedPlan) : undefined, lessons: clean(t.lessons)};
  }
  function sanitize(saved) {
    const data = blank();
    if (!saved || typeof saved !== 'object') return data;
    if (saved.rules && typeof saved.rules === 'object') data.rules = C.rulesConfig(saved.rules);
    if (saved.strategy && C.STRATEGIES[saved.strategy.preset]) data.strategy.preset = saved.strategy.preset;
    if (saved.strategy && saved.strategy.edits && typeof saved.strategy.edits === 'object') {
      for (const [field, [, low, high]] of Object.entries(C.EDITS)) {
        const value = C.num(saved.strategy.edits[field]);
        if (value !== null && value >= low && value <= high) data.strategy.edits[field] = value;
      }
    }
    data.trades = (Array.isArray(saved.trades) ? saved.trades : []).map(cleanTrade).filter(Boolean).slice(-1000);
    data.checks = (Array.isArray(saved.checks) ? saved.checks : []).filter(row => row && finite(row.at) && C.addressOk(row.chain, row.address))
      .map(row => ({at: row.at, chain: row.chain, address: row.address, symbol: C.text(row.symbol, 24) || 'COIN',
        verdict: ['skip', 'rules', 'caution', 'pass'].includes(row.verdict) ? row.verdict : 'rules', title: C.text(row.title, 60)})).slice(-30);
    data.alerts = (Array.isArray(saved.alerts) ? saved.alerts : []).filter(row => row && finite(row.at) && C.SIGNALS[row.signal])
      .map(row => ({at: row.at, id: C.text(row.id, 64), symbol: C.text(row.symbol, 24), signal: row.signal, text: C.text(row.text, 300)})).slice(-50);
    data.prefs = {sound: !(saved.prefs && saved.prefs.sound === false), awake: !(saved.prefs && saved.prefs.awake === false)};
    data.hints = {install: Boolean(saved.hints && saved.hints.install)};
    return data;
  }
  function load() {
    try { return sanitize(JSON.parse(localStorage.getItem(STORE) || 'null')); } catch (error) { return blank(); }
  }
  function save() {
    try {
      localStorage.setItem(STORE, JSON.stringify(S.data));
      $('#save-banner').hidden = true;
    } catch (error) {
      $('#save-text').textContent = "Scout couldn't save on this iPad, so new changes may be lost. Copy a backup from Rules now.";
      $('#save-banner').hidden = false;
    }
  }

  const S = {
    data: load(), page: 'trade',
    flow: {step: 'find', input: '', token: 0},
    radar: {chain: 'solana', kind: 'trending', rows: null, source: '', at: 0, busy: false, error: null, token: 0},
    live: {error: null, at: 0, reviewed: null},
    alert: null, update: null};
  const rules = () => C.rulesConfig(S.data.rules);
  const strategy = () => C.strategyConfig(S.data.strategy.preset, S.data.strategy.edits);
  const strategyName = () => C.STRATEGIES[S.data.strategy.preset].name + (Object.keys(S.data.strategy.edits).length ? ' (your version)' : '');
  const openTrades = () => S.data.trades.filter(trade => trade.status === 'open');
  const guardNow = () => C.guard(S.data.trades, rules(), Date.now());

  // Pages -----------------------------------------------------------------------
  function go(page) {
    if (!PAGES.includes(page)) page = 'trade';
    S.page = page;
    document.querySelectorAll('.page').forEach(el => { el.hidden = el.dataset.page !== page; });
    document.querySelectorAll('#tabbar [data-go]').forEach(el => {
      if (el.dataset.go === page) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
    });
    document.body.dataset.page = page;
    try { history.replaceState(null, '', '#' + page); } catch (error) { /* not important */ }
    renderPage();
    window.scrollTo(0, 0);
    if (page === 'radar' && !S.radar.busy && (!S.radar.rows || Date.now() - S.radar.at > 60000)) loadRadar();
  }
  function renderPage() {
    renderTop();
    if (S.page === 'trade') renderFlow();
    else if (S.page === 'radar') renderRadar();
    else if (S.page === 'live') renderLive();
    else if (S.page === 'journal') renderJournal();
    else if (S.page === 'rules') renderRules();
    renderSide();
  }
  function renderRail(el, current) {
    const index = STEPS.findIndex(([key]) => key === current);
    el.replaceChildren(...STEPS.map(([key, label], i) => h('li', {class: 'rail-step', 'data-state': i < index ? 'done' : i === index ? 'now' : 'next',
      'aria-current': i === index ? 'step' : null}, h('span', {class: 'rail-dot', 'aria-hidden': 'true'}, i < index ? '✓' : String(i + 1)), h('span', {class: 'rail-label'}, label))));
  }
  function renderTop() {
    const g = guardNow(), pill = $('#guard-pill'), count = openTrades().length;
    pill.dataset.status = g.status;
    const main = g.status === 'ready' ? 'Ready' : g.status === 'cooldown' ? `Break · ${Math.max(1, Math.ceil((g.cooldownUntil - Date.now()) / 60000))} min` : 'Stop for today';
    const extra = g.status === 'ready' ? `${g.tradesLeft} trade${g.tradesLeft !== 1 ? 's' : ''} left · ${C.usd(g.lossLeftUsd)} loss room` : '';
    if (pill.dataset.text !== main + extra) {
      pill.dataset.text = main + extra;
      fill(pill, h('b', {}, main), extra ? h('span', {class: 'pill-extra'}, ' · ' + extra) : null);
    }
    const badge = $('#live-badge');
    badge.hidden = !count;
    badge.textContent = String(count);
    $('#live-dot').hidden = !count;
    const tab = document.querySelector('#tabbar [data-go="live"]');
    tab.dataset.alarm = openTrades().some(trade => trade.signal !== 'hold') ? 'true' : 'false';
  }
  function guardCard(g) {
    const r = rules();
    return h('div', {class: 'card guard', 'data-status': g.status},
      h('div', {class: 'guard-head'}, h('h2', {}, g.status === 'ready' ? 'Guardrails: clear to trade' : g.status === 'cooldown' ? 'Guardrails: take a break' : 'Guardrails: done for today'),
        h('button', {type: 'button', class: 'quiet', onclick: () => go('rules')}, 'Edit rules')),
      g.reasons.length ? h('ul', {}, g.reasons.map(reason => h('li', {}, reason))) : null,
      h('div', {class: 'guard-meters'},
        meter('Trades today', `${g.tradesToday} of ${r.maxTradesPerDay}`, g.tradesToday / r.maxTradesPerDay),
        meter('Today', C.signedUsd(g.todayNetUsd), Math.max(0, -g.todayNetUsd) / r.dailyLossLimitUsd, `daily stop at ${C.usd(-r.dailyLossLimitUsd)}`),
        meter('Losses in a row', String(g.lossStreak), g.lossStreak / r.cooldownAfterLosses, `break after ${r.cooldownAfterLosses}`)));
  }
  function meter(label, value, fraction, note) {
    const bar = h('span', {class: 'meter-fill'});
    bar.style.width = Math.round(Math.max(0, Math.min(1, fraction)) * 100) + '%';
    return h('div', {class: 'guard-meter', 'data-full': fraction >= 1 ? 'true' : 'false'}, h('span', {class: 'meter-label'}, label), h('b', {class: 'num'}, value),
      h('span', {class: 'meter'}, bar), note ? h('span', {class: 'meter-note'}, note) : null);
  }

  // Step 1: find ------------------------------------------------------------------
  function renderFlow() {
    const step = S.flow.step;
    renderRail($('#rail-trade'), step);
    const box = $('#flow');
    if (step === 'check') box.replaceChildren(...checkView());
    else if (step === 'plan') box.replaceChildren(planView());
    else if (step === 'buy') box.replaceChildren(buyView());
    else box.replaceChildren(findView());
    if (step === 'check') { drawCheckChart(); applyReveal(); }
    if (step === 'plan') updatePlanLive();
    if (step === 'buy') refreshBreaks();
  }
  function findView() {
    const input = h('input', {id: 'ca', type: 'text', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false',
      enterkeyhint: 'go', placeholder: 'Paste a contract address or link', value: S.flow.input || '', 'aria-label': 'Contract address or link'});
    const recent = S.data.checks.slice(-8).reverse();
    return h('div', {class: 'flow-find'},
      h('div', {class: 'card hero'},
        h('p', {class: 'eyebrow'}, 'Step 1 · Find'),
        h('h1', {class: 'hero-title'}, 'Which coin are you looking at?'),
        h('p', {class: 'lead'}, "Paste its contract address (CA), or a DexScreener, Axiom or pump.fun link. Names and tickers can be faked; the address can't."),
        h('form', {class: 'find-form', onsubmit: event => { event.preventDefault(); startCheck(input.value); }},
          input,
          h('div', {class: 'find-buttons'},
            h('button', {type: 'button', class: 'secondary', onclick: () => pasteInto(input)}, 'Paste'),
            h('button', {type: 'submit'}, 'Check it'))),
        S.flow.error ? h('p', {class: 'error', role: 'alert'}, S.flow.error) : null),
      guardCard(guardNow()),
      recent.length ? h('div', {class: 'card'}, h('h2', {}, 'Recent checks'),
        h('div', {class: 'chips'}, recent.map(row => h('button', {type: 'button', class: 'chip', 'data-verdict': row.verdict, onclick: () => startCheck(row.address)},
          h('b', {}, row.symbol), h('span', {}, row.title || ''))))) : null,
      h('div', {class: 'card card-quiet split'},
        h('div', {}, h('h2', {}, 'Need ideas?'), h('p', {}, 'Radar lists coins people are trading right now, with a quick read against your rules.')),
        h('button', {type: 'button', class: 'secondary', onclick: () => go('radar')}, 'Open Radar')));
  }
  async function pasteInto(input) {
    try {
      const value = await navigator.clipboard.readText();
      if (value && value.trim()) { input.value = value.trim(); startCheck(input.value); return; }
      toast('Your clipboard is empty. Copy the CA in Axiom first.');
    } catch (error) {
      input.focus();
      toast('Tap the box, then choose Paste.');
    }
  }

  // Step 2: check -----------------------------------------------------------------
  let revealTimer = null;
  async function startCheck(raw) {
    const input = String(raw || '').trim();
    clearInterval(revealTimer);
    if (!input) {
      S.flow = {step: 'find', input: '', token: S.flow.token + 1, error: "Paste the coin's contract address (CA) first."};
      renderFlow();
      return;
    }
    const token = S.flow.token + 1;
    S.flow = {step: 'check', input, token, busy: 'market', error: null, market: null, risk: null, result: null, plan: null, candles: null, revealed: 0};
    if (S.page !== 'trade') go('trade'); else renderFlow();
    window.scrollTo(0, 0);
    try {
      const market = await D.market(input);
      if (token !== S.flow.token) return;
      S.flow.market = market;
      S.flow.busy = 'risk';
      renderFlow();
      D.candles(market.chain, market.pair, 60)
        .then(rows => { if (token === S.flow.token) { S.flow.candles = rows; drawCheckChart(); } })
        .catch(() => { if (token === S.flow.token) { S.flow.candles = []; drawCheckChart(); } });
      const risk = await D.risk(market.chain, market.address);
      if (token !== S.flow.token) return;
      S.flow.risk = risk;
      finishCheck();
    } catch (error) {
      if (token !== S.flow.token) return;
      S.flow.busy = false;
      S.flow.error = error.message || 'Something went wrong. Try again.';
      renderFlow();
    }
  }
  function finishCheck() {
    const now = Date.now(), market = S.flow.market, r = rules(), s = strategy();
    const plan = C.planFor(market, r, s, guardNow());
    const size = plan.sizeUsd >= 1 ? plan.sizeUsd : plan.capUsd;
    S.flow.result = C.grade(market, S.flow.risk, s, {now, trades: S.data.trades, sizeUsd: size, costPct: C.costPct(market.chain, size, market.liquidity, r, s)});
    S.flow.plan = plan;
    S.flow.busy = false;
    S.flow.revealed = motionOk ? 0 : S.flow.result.counts.total;
    const result = S.flow.result;
    S.data.checks = S.data.checks.filter(row => !(row.chain === result.chain && C.sameAddress(row.address, result.address, result.chain)))
      .concat([{at: now, chain: result.chain, address: result.address, symbol: result.symbol, verdict: result.verdict.code, title: result.verdict.title}]).slice(-30);
    save();
    renderFlow();
    if (motionOk) startReveal();
  }
  function startReveal() {
    clearInterval(revealTimer);
    const total = S.flow.result.counts.total;
    revealTimer = setInterval(() => {
      if (!S.flow.result) { clearInterval(revealTimer); return; }
      S.flow.revealed += 1;
      if (S.flow.revealed >= total) {
        clearInterval(revealTimer);
        if (S.page === 'trade' && S.flow.step === 'check') renderFlow();
        return;
      }
      applyReveal();
    }, 110);
  }
  function applyReveal() {
    const result = S.flow.result;
    if (!result) return;
    document.querySelectorAll('#checks .check-row').forEach(row => row.classList.toggle('row-in', Number(row.dataset.index) < S.flow.revealed));
    const fill = $('#reveal-fill');
    if (fill) fill.style.width = Math.round(Math.min(1, S.flow.revealed / result.counts.total) * 100) + '%';
    const count = $('#reveal-count');
    if (count) count.textContent = `${Math.min(S.flow.revealed, result.counts.total)} of ${result.counts.total}`;
  }
  function checkView() {
    const f = S.flow, m = f.market, parts = [];
    if (!m) {
      parts.push(h('div', {class: 'card scanning'}, h('p', {class: 'eyebrow'}, 'Step 2 · Check'),
        f.error ? null : h('div', {class: 'scan-line'}, spinner(), h('span', {}, "Finding the coin's busiest pool…"))));
      if (f.error) parts.push(errorCard(f.error));
      return parts;
    }
    parts.push(coinHead(m));
    if (f.busy === 'risk') {
      parts.push(h('div', {class: 'verdict', 'data-code': 'busy'}, h('div', {class: 'verdict-badge'}, spinner()), h('div', {class: 'verdict-body'},
        h('h2', {}, 'Scanning the contract…'),
        h('p', {}, m.chain === 'solana' ? 'Asking RugCheck about mint and freeze powers, holders and the developer.' : 'Asking GoPlus about honeypots, taxes, owner powers and holders.'))));
    }
    if (f.result) parts.push(verdictCard(), checksList(), checkActions());
    if (f.error) parts.push(errorCard(f.error));
    parts.push(h('p', {class: 'fine'}, 'Public data can lag and contract scans miss things. Scout never buys for you; you decide.'));
    return parts;
  }
  function errorCard(message) {
    return h('div', {class: 'card callout bad'}, h('b', {}, "That didn't work"), h('p', {}, message),
      h('div', {class: 'actions'}, h('button', {type: 'button', class: 'secondary', onclick: () => resetFlow()}, 'Back'),
        h('button', {type: 'button', onclick: () => startCheck(S.flow.input)}, 'Try again')));
  }
  function changeChip(label, value) {
    if (value === null || value === undefined) return null;
    return h('span', {class: 'change', 'data-sign': value >= 0 ? 'up' : 'down'}, `${label} ${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(1)}%`);
  }
  function stat(label, value) { return h('div', {class: 'stat'}, h('dt', {}, label), h('dd', {class: 'num'}, value)); }
  function copyButton(address, cls) {
    return h('button', {type: 'button', class: cls || 'secondary', onclick: () => copyText(address, 'CA copied. Paste it into Axiom.')}, 'Copy CA');
  }
  function coinHead(m) {
    const axiom = C.axiomUrl(m), risk = S.flow.risk;
    return h('div', {class: 'card coin'},
      h('div', {class: 'coin-top'},
        avatar(m.symbol, m.imageUrl),
        h('div', {class: 'coin-id'}, h('p', {class: 'eyebrow'}, 'Step 2 · Check'), h('h2', {class: 'coin-symbol'}, m.symbol, h('span', {class: 'chain-chip'}, C.CHAINS[m.chain])),
          h('p', {class: 'coin-name'}, m.name)),
        h('div', {class: 'coin-price'}, h('b', {class: 'num'}, C.priceText(m.price)), h('span', {class: 'changes'}, changeChip('5m', m.change5m), changeChip('1h', m.change1h)))),
      h('dl', {class: 'stats'},
        stat(m.valuationKind === 'fully diluted value' ? 'FDV' : 'Market cap', C.compactUsd(m.valuationUsd)),
        stat('Liquidity', C.compactUsd(m.liquidity)), stat('5m volume', C.compactUsd(m.volume5m || 0)),
        stat('Age', m.createdAt ? C.shortAge(Date.now() - m.createdAt) : '—'),
        stat('5m buys / sells', m.buys5m !== null && m.sells5m !== null ? `${m.buys5m} / ${m.sells5m}` : '—')),
      h('div', {class: 'chart-box'},
        h('canvas', {id: 'check-chart', class: 'chart', role: 'img', 'aria-label': 'Price over the last hour in one-minute candles'}),
        h('p', {class: 'chart-note', id: 'check-chart-note'}, 'Loading the last hour…')),
      h('div', {class: 'link-row'}, copyButton(m.address), axiom ? link(axiom, 'Open in Axiom ↗', 'button secondary') : null,
        link(m.sourceUrl, 'Chart ↗', 'button secondary'), risk && risk.sourceUrl ? link(risk.sourceUrl, (m.chain === 'solana' ? 'RugCheck' : 'GoPlus') + ' ↗', 'button secondary') : null,
        link(C.EXPLORERS[m.chain] + m.address, 'Explorer ↗', 'button secondary')));
  }
  function verdictCard() {
    const f = S.flow, r = f.result, total = r.counts.total;
    if (f.revealed < total) {
      const fill = h('span', {class: 'meter-fill', id: 'reveal-fill'});
      return h('div', {class: 'verdict', 'data-code': 'busy', id: 'verdict'}, h('div', {class: 'verdict-badge'}, spinner()),
        h('div', {class: 'verdict-body'}, h('h2', {}, `Checking ${total} things against ${strategyName()}`),
          h('p', {class: 'num', id: 'reveal-count'}, `0 of ${total}`), h('span', {class: 'meter'}, fill)));
    }
    return h('div', {class: 'verdict', 'data-code': r.verdict.code, id: 'verdict'},
      h('div', {class: 'verdict-badge', 'aria-hidden': 'true'}, VERDICT_ICON[r.verdict.code]),
      h('div', {class: 'verdict-body'}, h('p', {class: 'eyebrow'}, `Checked against ${strategyName()} · ${r.counts.passed} passed`
          + (r.counts.failed ? ` · ${r.counts.failed} failed` : '') + (r.counts.notes ? ` · ${r.counts.notes} to know` : '')),
        h('h2', {}, r.verdict.title), h('p', {}, r.verdict.summary), r.memory ? h('p', {class: 'memory'}, r.memory) : null));
  }
  function checksList() {
    let index = 0;
    return h('div', {class: 'checks', id: 'checks'}, S.flow.result.groups.map(group => h('section', {class: 'check-group'}, h('h3', {}, group.name),
      group.items.map(item => h('div', {class: 'check-row', 'data-status': item.status, 'data-hard': item.hard ? 'true' : null, 'data-index': String(index++)},
        h('span', {class: 'check-icon', 'aria-hidden': 'true'}, STATUS_ICON[item.status]),
        h('div', {class: 'check-text'}, h('b', {}, item.label, h('span', {class: 'sr-only'}, ', ' + STATUS_WORD[item.status])), h('p', {}, item.detail)))))));
  }
  function checkActions() {
    const code = S.flow.result.verdict.code, done = S.flow.revealed >= S.flow.result.counts.total;
    return h('div', {class: 'actions', id: 'check-actions', hidden: !done},
      h('button', {type: 'button', class: code === 'skip' ? null : 'secondary', onclick: () => resetFlow()}, 'Find another coin'),
      code === 'skip' ? h('button', {type: 'button', class: 'quiet', onclick: toPlan}, 'Plan it anyway')
        : h('button', {type: 'button', onclick: toPlan}, 'Plan this trade →'));
  }
  function resetFlow() {
    clearInterval(revealTimer);
    S.flow = {step: 'find', input: '', token: S.flow.token + 1};
    if (S.page === 'trade') renderFlow();
  }

  // Step 3: plan ------------------------------------------------------------------
  function toPlan() {
    if (!S.flow.result) return;
    S.flow.plan = C.planFor(S.flow.market, rules(), strategy(), guardNow());
    S.flow.live = {price: S.flow.market.price, at: S.flow.market.fetchedAt};
    S.flow.step = 'plan';
    lastPriceAt = 0;
    renderFlow();
    window.scrollTo(0, 0);
  }
  function tile(label, value, sub, tone) {
    return h('div', {class: 'tile', 'data-tone': tone || null}, h('span', {class: 'tile-label'}, label), h('b', {class: 'num'}, value), sub ? h('span', {class: 'tile-sub'}, sub) : null);
  }
  function planView() {
    const f = S.flow, m = f.market, p = f.plan, result = f.result, g = guardNow(), r = rules(), axiom = C.axiomUrl(m), ok = p.sizeUsd >= 1;
    const liveBox = h('div', {class: 'live-price', id: 'plan-live'}, h('span', {class: 'pulse-dot', 'aria-hidden': 'true'}), h('span', {id: 'plan-live-text'}),
      h('button', {type: 'button', class: 'quiet', id: 'plan-redo', hidden: true, onclick: replan}, 'Redo the plan at this price'));
    return h('div', {class: 'card plan'},
      h('div', {class: 'plan-head'}, avatar(m.symbol, m.imageUrl), h('div', {class: 'grow'}, h('p', {class: 'eyebrow'}, 'Step 3 · Plan'), h('h2', {}, `Your plan for ${m.symbol}`)),
        h('span', {class: 'verdict-chip', 'data-code': result.verdict.code}, result.verdict.title)),
      g.status !== 'ready' ? h('div', {class: 'callout bad'}, h('b', {}, 'Your guardrails say stop.'), g.reasons.map(reason => h('p', {}, reason))) : null,
      result.verdict.code === 'skip' ? h('div', {class: 'callout bad'}, h('b', {}, 'The check said skip it.'),
        h('p', {}, result.verdict.summary + ' If you buy anyway, Scout logs it as a rule break.')) : null,
      h('div', {class: 'plan-size'}, h('span', {class: 'plan-size-label'}, 'Buy'), h('b', {class: 'num plan-size-value'}, C.usd(p.sizeUsd)),
        h('span', {class: 'plan-size-note'}, ok ? `If the stop hits you lose about ${C.usd(p.lossUsd)}, which is ${C.pct(p.lossUsd / r.bankrollUsd * 100)} of your ${C.usd(r.bankrollUsd)} bankroll.` : p.text)),
      ladder('plan-ladder'),
      h('div', {class: 'tiles'},
        tile('Sell at', C.priceText(p.targetPrice), '+' + C.pct(p.targetPct), 'up'),
        tile('Cut at', C.priceText(p.stopPrice), '−' + C.pct(p.stopPct), 'down'),
        p.trailingPct ? tile('Trailing stop', C.pct(p.trailingPct), 'from its best price') : null,
        tile('Time limit', `${p.holdMinutes} min`, 'win or lose'),
        tile('Fees', C.pct(p.costPct), 'to buy and sell')),
      ok ? h('p', {class: 'plan-text'}, p.text) : null,
      ok ? h('p', {class: 'odds'}, p.odds) : null,
      liveBox,
      h('div', {class: 'actions'},
        h('button', {type: 'button', class: 'quiet', onclick: () => { S.flow.step = 'check'; renderFlow(); }}, '← Back to the check'),
        copyButton(m.address),
        axiom ? link(axiom, 'Open in Axiom ↗', 'button secondary') : link(m.sourceUrl, 'Open chart ↗', 'button secondary'),
        h('button', {type: 'button', onclick: toBuy}, 'I bought it →')),
      h('p', {class: 'fine'}, axiom ? "Open in Axiom goes to this coin's pool. If Axiom doesn't find it, copy the CA and paste it into Axiom's search."
        : 'Axiom links are made for Solana coins. For this chain, copy the CA and paste it into Axiom, or use the chart.'));
  }
  function updatePlanLive() {
    const text = $('#plan-live-text');
    if (!text || !S.flow.plan) return;
    const p = S.flow.plan, live = S.flow.live || {price: p.entry, at: Date.now()};
    const drift = (live.price / p.entry - 1) * 100, ago = Math.max(0, Math.round((Date.now() - live.at) / 1000));
    text.textContent = `Live price ${C.priceText(live.price)} · ${Math.abs(drift) < 0.05 ? 'same as your plan' : C.signedPct(drift) + ' vs your plan'} · ${ago < 2 ? 'just now' : ago + 's ago'}`;
    $('#plan-redo').hidden = Math.abs(drift) < 3;
    placeLadder($('#plan-ladder'), {stop: p.stopPrice, entry: p.entry, target: p.targetPrice, now: live.price});
  }
  function replan() {
    const live = S.flow.live;
    if (!live) return;
    S.flow.market = {...S.flow.market, price: live.price, fetchedAt: live.at};
    S.flow.plan = C.planFor(S.flow.market, rules(), strategy(), guardNow());
    renderFlow();
    toast('Plan updated to the live price.');
  }

  // Step 4: buy (in Axiom) and log it -----------------------------------------------
  function toBuy() {
    const p = S.flow.plan, live = S.flow.live;
    S.flow.buy = {entryPrice: C.plain(live ? live.price : p.entry), sizeUsd: p.sizeUsd >= 1 ? String(p.sizeUsd) : '', targetPct: String(p.targetPct),
      stopPct: String(p.stopPct), trailingPct: String(p.trailingPct || 0), holdMinutes: String(p.holdMinutes), override: '', error: null};
    S.flow.step = 'buy';
    unlockAudio();
    renderFlow();
    window.scrollTo(0, 0);
  }
  function buyView() {
    const m = S.flow.market, b = S.flow.buy;
    const field = (id, label, key, mode) => h('label', {class: 'field', for: id}, h('span', {}, label),
      h('input', {id, type: 'text', inputmode: mode || 'decimal', autocomplete: 'off', value: b[key], oninput: event => { b[key] = event.target.value; refreshBreaks(); }}));
    return h('form', {class: 'card buy', onsubmit: submitBuy},
      h('p', {class: 'eyebrow'}, 'Step 4 · Buy in Axiom, then log it here'),
      h('h2', {}, `Log your ${m.symbol} buy`),
      h('p', {class: 'lead'}, 'Buy in Axiom first. Then tell Scout what you really paid, so it watches the right numbers.'),
      h('div', {class: 'field-grid'}, field('buy-price', 'Price you paid ($ per coin)', 'entryPrice'), field('buy-size', 'Amount you spent ($)', 'sizeUsd')),
      h('details', {class: 'exits'},
        h('summary', {}, `Exits: +${b.targetPct}% target, −${b.stopPct}% stop, ${b.holdMinutes} min` + (Number(b.trailingPct) ? `, ${b.trailingPct}% trailing stop` : '')),
        h('div', {class: 'field-grid'}, field('buy-target', 'Target %', 'targetPct'), field('buy-stop', 'Stop %', 'stopPct'),
          field('buy-trail', 'Trailing stop % (0 = off)', 'trailingPct'), field('buy-hold', 'Time limit (minutes)', 'holdMinutes', 'numeric'))),
      h('div', {id: 'buy-breaks'}),
      h('p', {class: 'error', id: 'buy-error', role: 'alert', hidden: !b.error}, b.error || ''),
      h('div', {class: 'actions'},
        h('button', {type: 'button', class: 'quiet', onclick: () => { S.flow.step = 'plan'; renderFlow(); }}, '← Back to the plan'),
        h('button', {type: 'submit'}, 'Start watching')));
  }
  function refreshBreaks() {
    const box = $('#buy-breaks');
    if (!box || !S.flow.buy) return;
    const breaks = C.buyBreaks({verdict: S.flow.result.verdict.code, sizeUsd: S.flow.buy.sizeUsd}, S.data.trades, rules(), Date.now());
    const key = breaks.join('|');
    if (box.dataset.key === key) return;
    box.dataset.key = key;
    if (!breaks.length) { box.replaceChildren(); return; }
    box.replaceChildren(h('div', {class: 'callout bad'}, h('b', {}, 'This buy breaks your rules'), h('ul', {}, breaks.map(item => h('li', {}, item))),
      h('label', {class: 'field', for: 'buy-why'}, h('span', {}, 'Why are you doing it anyway? It goes in your journal.'),
        h('textarea', {id: 'buy-why', rows: '2', maxlength: '300', value: S.flow.buy.override || '', oninput: event => { S.flow.buy.override = event.target.value; }}))));
  }
  function submitBuy(event) {
    event.preventDefault();
    const f = S.flow, m = f.market, b = f.buy, now = Date.now();
    try {
      const size = C.num(b.sizeUsd);
      const cost = size > 0 ? C.round2(C.costPct(m.chain, size, m.liquidity, rules(), strategy())) : C.DEFAULT_COST_PCT;
      const trade = C.openTrade({chain: m.chain, address: m.address, pair: m.pair, symbol: m.symbol, name: m.name, entryPrice: b.entryPrice,
        sizeUsd: b.sizeUsd, stopPct: b.stopPct, targetPct: b.targetPct, trailingPct: b.trailingPct, holdMinutes: b.holdMinutes, costPct: cost,
        verdict: f.result.verdict.code, overrideReason: b.override}, S.data.trades, rules(), now, newId());
      trade.imageUrl = m.imageUrl || null;
      S.data.trades.push(trade);
      save();
      resetFlow();
      go('live');
      toast(`Watching ${trade.symbol}. Keep Scout on screen: the iPad pauses it in the background.`);
      lastPriceAt = 0;
      keepAwake();
    } catch (error) {
      b.error = error.message;
      const box = $('#buy-error');
      if (box) { box.textContent = b.error; box.hidden = false; }
    }
  }

  // Price ladder and charts ---------------------------------------------------------
  function ladder(id) {
    return h('div', {class: 'ladder', id: id || null},
      h('div', {class: 'ladder-track', 'aria-hidden': 'true'}, h('span', {class: 'ladder-loss'}), h('span', {class: 'ladder-win'}),
        h('i', {class: 'mk mk-stop'}), h('i', {class: 'mk mk-entry'}), h('i', {class: 'mk mk-target'}), h('i', {class: 'mk mk-trail', hidden: true}), h('b', {class: 'mk-now'})),
      h('p', {class: 'ladder-legend'}, h('span', {class: 'lg lg-stop'}), h('span', {class: 'lg lg-entry'}), h('span', {class: 'lg lg-target'}),
        h('span', {class: 'lg lg-trail', hidden: true}), h('span', {class: 'lg lg-now'})));
  }
  function placeLadder(el, p) {
    if (!el) return;
    const span = Math.max(p.target - p.stop, p.entry * 0.01), lo = p.stop - span * 0.12, hi = p.target + span * 0.12;
    const pos = value => Math.max(0, Math.min(100, (value - lo) / (hi - lo) * 100));
    const at = (selector, value) => { const node = el.querySelector(selector); if (node) node.style.left = pos(value) + '%'; };
    at('.mk-stop', p.stop); at('.mk-entry', p.entry); at('.mk-target', p.target); at('.mk-now', p.now);
    const trail = el.querySelector('.mk-trail');
    trail.hidden = !p.trail;
    if (p.trail) at('.mk-trail', p.trail);
    const loss = el.querySelector('.ladder-loss'), win = el.querySelector('.ladder-win');
    loss.style.left = pos(p.stop) + '%'; loss.style.width = Math.max(0, pos(p.entry) - pos(p.stop)) + '%';
    win.style.left = pos(p.entry) + '%'; win.style.width = Math.max(0, pos(p.target) - pos(p.entry)) + '%';
    el.dataset.side = p.now >= p.entry ? 'up' : 'down';
    const label = (selector, text) => { const node = el.querySelector(selector); if (node && node.textContent !== text) node.textContent = text; };
    label('.lg-stop', 'Stop ' + C.priceText(p.stop));
    label('.lg-entry', 'Entry ' + C.priceText(p.entry));
    label('.lg-target', 'Target ' + C.priceText(p.target));
    const trailLabel = el.querySelector('.lg-trail');
    trailLabel.hidden = !p.trail;
    if (p.trail) label('.lg-trail', 'Trail ' + C.priceText(p.trail));
    label('.lg-now', 'Now ' + C.priceText(p.now));
  }
  function themeColor(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888'; }
  function setupCanvas(canvas) {
    const ratio = window.devicePixelRatio || 1, width = canvas.clientWidth, height = canvas.clientHeight;
    if (!width || !height) return null;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    return {ctx, width, height};
  }
  const CHART_FONT = '600 11px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif';
  function drawCheckChart() {
    const canvas = $('#check-chart'), note = $('#check-chart-note');
    if (!canvas || !note) return;
    const rows = S.flow.candles;
    if (rows === null || rows === undefined) { canvas.hidden = true; note.hidden = false; note.textContent = 'Loading the last hour…'; return; }
    if (!rows.length) { canvas.hidden = true; note.hidden = false; note.textContent = 'No candle data for this pool yet. Use the Chart button to see it.'; return; }
    canvas.hidden = false;
    note.hidden = true;
    const box = setupCanvas(canvas);
    if (!box) return;
    const {ctx, width, height} = box, right = 74, padY = 12, plotW = width - right;
    let lo = Math.min(...rows.map(row => row[3])), hi = Math.max(...rows.map(row => row[2]));
    if (hi <= lo) { hi = lo * 1.01 + 1e-12; lo *= 0.99; }
    const y = value => padY + (hi - value) / (hi - lo) * (height - padY * 2);
    const step = plotW / Math.max(rows.length, 30), body = Math.max(1.5, step * 0.62);
    const up = themeColor('--up'), down = themeColor('--down'), grid = themeColor('--line'), muted = themeColor('--muted'), blue = themeColor('--blue-2');
    ctx.lineWidth = 1;
    ctx.strokeStyle = grid;
    for (let i = 0; i <= 3; i++) {
      const line = Math.round(padY + i * (height - padY * 2) / 3) + 0.5;
      ctx.beginPath(); ctx.moveTo(0, line); ctx.lineTo(plotW, line); ctx.stroke();
    }
    const offset = plotW - rows.length * step;
    rows.forEach((row, i) => {
      const x = offset + i * step + step / 2, color = row[4] >= row[1] ? up : down;
      ctx.strokeStyle = color; ctx.fillStyle = color;
      ctx.beginPath(); ctx.moveTo(x, y(row[2])); ctx.lineTo(x, y(row[3])); ctx.stroke();
      const top = y(Math.max(row[1], row[4])), bottom = y(Math.min(row[1], row[4]));
      ctx.fillRect(x - body / 2, top, body, Math.max(1, bottom - top));
    });
    const last = rows[rows.length - 1][4];
    ctx.setLineDash([3, 4]); ctx.strokeStyle = blue;
    ctx.beginPath(); ctx.moveTo(0, y(last)); ctx.lineTo(plotW, y(last)); ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = CHART_FONT; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    const lastY = Math.max(8, Math.min(height - 8, y(last)));
    ctx.fillStyle = muted;
    if (Math.abs(lastY - Math.max(8, y(hi))) > 16) ctx.fillText(C.priceText(hi), plotW + 8, Math.max(8, y(hi)));
    if (Math.abs(lastY - Math.min(height - 8, y(lo))) > 16) ctx.fillText(C.priceText(lo), plotW + 8, Math.min(height - 8, y(lo)));
    ctx.fillStyle = blue;
    ctx.fillText(C.priceText(last), plotW + 8, lastY);
  }
  function drawSpark(canvas, trade, view) {
    const box = setupCanvas(canvas);
    if (!box) return;
    const {ctx, width, height} = box, padY = 12, labels = 58, plotW = width - labels, now = Date.now();
    const samples = (trade.samples && trade.samples.length ? trade.samples : [[trade.openedAt, trade.entryPrice]]).concat([[trade.markAt, trade.mark]]);
    const prices = samples.map(row => row[1]).concat([view.stopPrice, view.targetPrice, view.trailPrice || trade.entryPrice]);
    let lo = Math.min(...prices), hi = Math.max(...prices);
    const pad = (hi - lo) * 0.1 || hi * 0.01;
    lo -= pad; hi += pad;
    // The chart is your plan's time window: the right edge is the time limit.
    const t0 = trade.openedAt, t1 = Math.max(trade.openedAt + trade.holdMinutes * 60000, samples[samples.length - 1][0], now);
    const x = t => Math.max(0, Math.min(plotW, (t - t0) / (t1 - t0) * plotW)), y = value => padY + (hi - value) / (hi - lo) * (height - padY * 2);
    ctx.font = CHART_FONT; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    const line = (value, color, dash, label) => {
      const at = Math.round(y(value)) + 0.5;
      ctx.setLineDash(dash); ctx.strokeStyle = color; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, at); ctx.lineTo(plotW, at); ctx.stroke();
      ctx.setLineDash([]);
      if (label) { ctx.fillStyle = color; ctx.fillText(label, plotW + 8, Math.max(8, Math.min(height - 8, at))); }
    };
    line(trade.entryPrice, themeColor('--muted'), [2, 4], Math.abs(y(trade.entryPrice) - y(view.stopPrice)) > 16 && Math.abs(y(trade.entryPrice) - y(view.targetPrice)) > 16 ? 'Entry' : null);
    line(view.targetPrice, themeColor('--up'), [5, 4], 'Target');
    line(view.stopPrice, themeColor('--down'), [5, 4], 'Stop');
    if (view.trailPrice) line(view.trailPrice, themeColor('--warn'), [5, 4], Math.abs(y(view.trailPrice) - y(view.stopPrice)) > 16 ? 'Trail' : null);
    ctx.strokeStyle = themeColor('--line-2'); ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(Math.round(x(now)) + 0.5, 0); ctx.lineTo(Math.round(x(now)) + 0.5, height); ctx.stroke();
    ctx.setLineDash([]);
    const color = view.pnlUsd >= 0 ? themeColor('--blue-2') : themeColor('--down');
    ctx.beginPath();
    samples.forEach((row, i) => { if (i) ctx.lineTo(x(row[0]), y(row[1])); else ctx.moveTo(x(row[0]), y(row[1])); });
    ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.stroke();
    const last = samples[samples.length - 1];
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(x(last[0]), y(last[1]), 4.5, 0, Math.PI * 2); ctx.fill();
  }

  // Step 5: live trades ---------------------------------------------------------------
  const cards = new Map();
  let lastPriceAt = 0, priceBusy = false;
  function renderLive() {
    renderRail($('#rail-live'), S.data.trades.some(row => row.id === S.live.reviewed && row.status === 'closed') ? 'review' : 'watch');
    const open = openTrades();
    syncCards(open);
    $('#live-empty').hidden = open.length > 0 || Boolean(S.live.reviewed);
    renderLiveStatus();
    renderReview();
    renderAlertList();
  }
  function tickLive() {
    syncCards(openTrades());
    renderLiveStatus();
  }
  function syncCards(open) {
    const list = $('#live-list'), now = Date.now();
    for (const [id, card] of cards) {
      if (!open.some(trade => trade.id === id)) { card.el.remove(); cards.delete(id); }
    }
    open.forEach((trade, index) => {
      let card = cards.get(trade.id);
      if (!card) { card = buildCard(trade); cards.set(trade.id, card); }
      if (list.children[index] !== card.el) list.insertBefore(card.el, list.children[index] || null);
      updateCard(card, trade, now);
    });
  }
  function fact(label, ...values) { return h('div', {class: 'fact'}, h('dt', {}, label), values); }
  function axiomFor(trade) {
    return trade.chain === 'solana' && trade.pair && C.validMint(trade.pair) ? 'https://axiom.trade/meme/' + trade.pair : null;
  }
  function chartFor(trade) { return 'https://dexscreener.com/' + trade.chain + '/' + (trade.pair || trade.address); }
  function buildCard(trade) {
    const refs = {};
    const axiom = axiomFor(trade);
    const el = h('article', {class: 'card live-card', dataset: {id: trade.id}},
      h('header', {class: 'live-top'}, avatar(trade.symbol, trade.imageUrl),
        h('div', {class: 'live-id'}, h('h2', {}, trade.symbol, h('span', {class: 'chain-chip'}, C.CHAINS[trade.chain])), refs.sub = h('p', {class: 'live-sub'})),
        refs.pnl = h('div', {class: 'live-pnl num'})),
      refs.banner = h('div', {class: 'signal', role: 'status'}),
      h('div', {class: 'live-body'},
        h('div', {class: 'spark-box'}, refs.spark = h('canvas', {class: 'spark', role: 'img', 'aria-label': trade.symbol + ' price since you bought, with your stop and target'})),
        h('dl', {class: 'facts'},
          fact('Price now', refs.price = h('dd', {class: 'num'}), refs.move = h('dd', {class: 'fact-sub'})),
          fact('Time left', refs.time = h('dd', {class: 'num'})),
          fact('Stop', refs.stop = h('dd', {class: 'num down'})),
          fact('Target', refs.target = h('dd', {class: 'num up'})))),
      refs.ladder = ladder(),
      refs.missed = h('p', {class: 'callout bad', hidden: true}),
      refs.stale = h('p', {class: 'stale', hidden: true}, "The price hasn't updated for over a minute. Check your connection, or open the chart."),
      h('div', {class: 'actions'}, copyButton(trade.address),
        axiom ? link(axiom, 'Open in Axiom ↗', 'button secondary') : link(chartFor(trade), 'Open chart ↗', 'button secondary'),
        refs.sell = h('button', {type: 'button', onclick: () => openClose(trade.id)}, 'I sold')),
      refs.form = closeForm(trade));
    return {el, refs, drawn: ''};
  }
  function updateCard(card, trade, now) {
    const v = C.liveView(trade, now), r = card.refs;
    card.el.dataset.signal = trade.signal;
    r.sub.textContent = `${C.usd(trade.sizeUsd)} at ${C.priceText(trade.entryPrice)} · bought ${now - trade.openedAt < 60000 ? 'just now' : C.shortAge(now - trade.openedAt) + ' ago'}`;
    r.pnl.dataset.sign = v.pnlUsd >= 0 ? 'up' : 'down';
    const pnlText = C.signedUsd(v.pnlUsd) + '|' + C.signedPct(v.pnlUsd / trade.sizeUsd * 100);
    if (r.pnl.dataset.text !== pnlText) {
      r.pnl.dataset.text = pnlText;
      r.pnl.replaceChildren(h('b', {}, C.signedUsd(v.pnlUsd)), h('span', {}, C.signedPct(v.pnlUsd / trade.sizeUsd * 100) + ' after fees'));
    }
    if (r.banner.dataset.signal !== trade.signal) {
      r.banner.dataset.signal = trade.signal;
      const [title, line] = SIGNAL_LINES[trade.signal];
      r.banner.replaceChildren(h('b', {}, title), h('span', {}, line));
    }
    r.price.textContent = C.priceText(trade.mark);
    r.move.textContent = `${C.signedPct(v.changePct)} since you bought`;
    r.time.textContent = v.secondsLeft > 0 ? C.clock(v.secondsLeft) : 'Over';
    const trailing = v.trailPrice && v.trailPrice > v.stopPrice;
    r.stop.textContent = C.priceText(trailing ? v.trailPrice : v.stopPrice) + (trailing ? ' trail' : '');
    r.target.textContent = C.priceText(v.targetPrice);
    r.sell.classList.toggle('urgent', trade.signal !== 'hold');
    placeLadder(r.ladder, {stop: v.stopPrice, entry: trade.entryPrice, target: v.targetPrice, trail: v.trailPrice, now: trade.mark});
    r.stale.hidden = !v.stale;
    r.missed.hidden = !trade.missed;
    if (trade.missed) {
      r.missed.textContent = `While Scout was paused, the price fell to ${C.priceText(trade.missed.low)} around ${timeText(trade.missed.at)}, through your ${trade.missed.kind === 'trail' ? 'trailing stop' : 'stop'}. Your plan says get out.`;
    }
    const drawKey = (trade.samples || []).length + ':' + r.spark.clientWidth + ':' + trade.signal;
    if (card.drawn !== drawKey) { drawSpark(r.spark, trade, v); card.drawn = drawKey; }
  }
  function closeForm(trade) {
    const state = {feeling: null};
    const price = h('input', {id: 'sell-' + trade.id, type: 'text', inputmode: 'decimal', autocomplete: 'off'});
    const note = h('textarea', {id: 'note-' + trade.id, rows: '2', maxlength: '500', placeholder: 'What happened? (optional)'});
    const chips = h('div', {class: 'chips', role: 'group', 'aria-label': 'How did you feel during this trade?'}, C.FEELINGS.map(feeling => h('button', {type: 'button', class: 'chip', 'aria-pressed': 'false',
      onclick: event => {
        state.feeling = state.feeling === feeling ? null : feeling;
        chips.querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', String(button === event.currentTarget && state.feeling === feeling)));
      }}, FEELING_LABELS[feeling])));
    const error = h('p', {class: 'error', role: 'alert', hidden: true});
    const remove = h('button', {type: 'button', class: 'quiet danger', onclick: () => armed(remove, 'Tap again to delete', 'Logged by mistake? Delete it', () => deleteTrade(trade.id))}, 'Logged by mistake? Delete it');
    const form = h('form', {class: 'close-form', hidden: true, onsubmit: event => { event.preventDefault(); submitClose(trade.id, price.value, state.feeling, note.value, error); }},
      h('h3', {}, `Log your ${trade.symbol} sell`),
      h('label', {class: 'field', for: price.id}, h('span', {}, 'Price you sold at ($ per coin)'), price),
      h('div', {class: 'field'}, h('span', {}, 'How did you feel during this trade?'), chips),
      h('label', {class: 'field', for: note.id}, h('span', {}, 'Note'), note),
      error,
      h('div', {class: 'actions'}, remove, h('button', {type: 'button', class: 'secondary', onclick: () => { form.hidden = true; }}, 'Cancel'), h('button', {type: 'submit'}, 'Save and review')));
    form.price = price;
    return form;
  }
  function armed(button, confirmText, idleText, action) {
    if (button.dataset.armed) { action(); return; }
    button.dataset.armed = '1';
    button.textContent = confirmText;
    setTimeout(() => { if (button.isConnected) { delete button.dataset.armed; button.textContent = idleText; } }, 4000);
  }
  function openClose(id) {
    const card = cards.get(id), trade = S.data.trades.find(row => row.id === id && row.status === 'open');
    if (!card || !trade) return;
    card.refs.form.hidden = false;
    if (!card.refs.form.price.value) card.refs.form.price.value = C.plain(trade.mark);
    card.refs.form.scrollIntoView({behavior: motionOk ? 'smooth' : 'auto', block: 'center'});
  }
  function submitClose(id, exitPrice, feeling, note, errorEl) {
    const trade = S.data.trades.find(row => row.id === id && row.status === 'open');
    try {
      C.closeTrade(trade, {exitPrice, feeling, note}, Date.now());
    } catch (error) {
      errorEl.textContent = error.message;
      errorEl.hidden = false;
      return;
    }
    trade.samples = thin(trade.samples, 80);
    save();
    S.live.reviewed = id;
    if (S.alert && S.alert.id === id) hideAlert();
    renderLive();
    renderTop();
    renderSide();
    keepAwake();
    window.scrollTo(0, 0);
  }
  function thin(samples, limit) {
    if (!Array.isArray(samples) || samples.length <= limit) return samples || [];
    const step = (samples.length - 1) / (limit - 1);
    return Array.from({length: limit}, (_, i) => samples[Math.round(i * step)]);
  }
  function deleteTrade(id) {
    S.data.trades = S.data.trades.filter(row => row.id !== id);
    if (S.live.reviewed === id) S.live.reviewed = null;
    save();
    renderPage();
    toast('Trade deleted.');
  }
  function renderLiveStatus() {
    const box = $('#live-status'), open = openTrades().length;
    if (!open) { box.textContent = ''; return; }
    const ago = S.live.at ? Math.round((Date.now() - S.live.at) / 1000) : null;
    const parts = [S.live.error ? "Couldn't update prices: " + S.live.error : ago === null ? 'Getting prices…' : `Prices every 8 seconds · updated ${ago < 2 ? 'just now' : ago + 's ago'}`];
    parts.push(wakeLock ? 'Screen stays on while a trade is open.' : 'Keep Scout on screen: the iPad pauses it in the background, and alerts stop.');
    const text = parts.join(' · ');
    if (box.textContent !== text) box.textContent = text;
    box.dataset.bad = S.live.error ? 'true' : 'false';
  }
  function renderReview() {
    const box = $('#live-review'), t = S.data.trades.find(row => row.id === S.live.reviewed && row.status === 'closed');
    if (!t) { box.replaceChildren(); return; }
    const move = (t.exitPrice / t.entryPrice - 1) * 100;
    box.replaceChildren(h('div', {class: 'card review', 'data-result': t.pnlUsd >= 0 ? 'up' : 'down'},
      h('p', {class: 'eyebrow'}, 'Step 6 · Review'),
      h('h2', {}, `${t.symbol}: ${t.pnlUsd >= 0 ? 'win' : 'loss'} `, h('span', {class: 'num'}, C.signedUsd(t.pnlUsd))),
      h('p', {}, `Bought at ${C.priceText(t.entryPrice)}, sold at ${C.priceText(t.exitPrice)} (${C.signedPct(move)} before fees). Exit: ${EXIT_WORDS[t.exitReason]}.`),
      t.followedPlan ? h('p', {class: 'good'}, '✓ You followed your plan.')
        : h('div', {class: 'callout bad'}, h('b', {}, 'Rule breaks'), h('ul', {}, t.ruleBreaks.map(item => h('li', {}, item)))),
      t.lessons.length ? h('div', {class: 'lessons'}, h('b', {}, 'Lessons'), h('ul', {}, t.lessons.map(item => h('li', {}, item)))) : null,
      h('div', {class: 'actions'}, h('button', {type: 'button', class: 'secondary', onclick: () => go('journal')}, 'Open journal'),
        h('button', {type: 'button', onclick: () => { S.live.reviewed = null; renderLive(); if (!openTrades().length) go('trade'); }}, 'Done'))));
  }
  function renderAlertList() {
    const box = $('#live-alerts'), rows = S.data.alerts.slice(-6).reverse();
    if (!rows.length) { box.replaceChildren(); return; }
    box.replaceChildren(h('div', {class: 'card'}, h('h2', {}, 'Recent alerts'),
      h('ul', {class: 'alert-list'}, rows.map(row => h('li', {'data-signal': row.signal}, h('span', {class: 'num'}, timeText(row.at)), h('span', {}, row.text))))));
  }

  // Prices, alerts, sound, screen --------------------------------------------------
  async function refreshPrices() {
    priceBusy = true;
    lastPriceAt = Date.now();
    const open = openTrades();
    const planning = S.page === 'trade' && S.flow.step === 'plan' && S.flow.market;
    const probes = open.map(trade => ({id: trade.id, chain: trade.chain, pair: trade.pair, address: trade.address}));
    if (planning) probes.push({id: 'plan', chain: S.flow.market.chain, pair: S.flow.market.pair, address: S.flow.market.address});
    try {
      const prices = await D.prices(probes);
      const now = Date.now();
      let changed = false;
      for (const trade of openTrades()) {
        const price = prices[trade.id];
        if (!(price > 0)) continue;
        changed = true;
        const fired = C.mark(trade, price, now);
        if (fired) raiseAlert(trade, fired, false);
      }
      if (planning && prices.plan > 0 && S.flow.step === 'plan') S.flow.live = {price: prices.plan, at: now};
      if (changed) save();
      S.live.error = null;
      S.live.at = now;
    } catch (error) {
      S.live.error = error.message;
    } finally {
      priceBusy = false;
      if (S.page === 'live') tickLive();
      if (S.page === 'trade' && S.flow.step === 'plan') updatePlanLive();
      renderSide();
      renderTop();
    }
  }
  async function catchUpAll() {
    const now = Date.now();
    for (const trade of openTrades()) {
      if (!trade.pair || now - trade.markAt < 45000) continue;
      try {
        const rows = await D.candles(trade.chain, trade.pair, Math.min(300, Math.ceil((now - trade.markAt) / 60000) + 2));
        const missed = C.catchUp(trade, rows);
        if (missed && trade.signal === 'hold') raiseAlert(trade, missed.kind, true);
      } catch (error) {
        // Candles only fill the gap; live prices still update.
      }
    }
    save();
  }
  let alarmTimer = null;
  function raiseAlert(trade, signal, missed) {
    const now = Date.now(), [title, line] = SIGNAL_LINES[signal];
    const text = missed ? `While Scout was paused, the price fell through your ${signal === 'trail' ? 'trailing stop' : 'stop'}. Your plan says get out now.` : line;
    S.data.alerts = S.data.alerts.concat([{at: now, id: trade.id, symbol: trade.symbol, signal, text: `${trade.symbol}: ${title}. ${text}`}]).slice(-50);
    save();
    const repeat = S.alert && S.alert.id === trade.id && now - S.alert.at < 120000 && (S.alert.signal === signal || ['stop', 'trail'].includes(S.alert.signal) && ['stop', 'trail'].includes(signal));
    S.alert = {id: trade.id, signal, at: now};
    showAlert(trade, signal, text);
    if (!repeat) startAlarm(signal);
    if (S.page === 'live') renderAlertList();
    renderTop();
  }
  function showAlert(trade, signal, text) {
    const v = C.liveView(trade, Date.now()), box = $('#alert');
    box.dataset.signal = signal;
    $('#alert-kicker').textContent = trade.symbol + ' · ' + C.CHAINS[trade.chain];
    $('#alert-title').textContent = SIGNAL_LINES[signal][0];
    $('#alert-text').textContent = text;
    $('#alert-pnl').textContent = `Now ${C.signedUsd(v.pnlUsd)} after fees · price ${C.signedPct(v.changePct)} · ${C.priceText(trade.mark)}`;
    const axiom = axiomFor(trade), button = $('#alert-axiom');
    button.href = axiom || chartFor(trade);
    button.textContent = axiom ? 'Open Axiom ↗' : 'Open chart ↗';
    box.hidden = false;
    $('#alert-ok').focus({preventScroll: true});
  }
  function hideAlert() { $('#alert').hidden = true; stopAlarm(); }
  function startAlarm(signal) {
    stopAlarm();
    let count = 0;
    beep(signal);
    alarmTimer = setInterval(() => {
      count += 1;
      if (count >= 8 || $('#alert').hidden) { stopAlarm(); return; }
      beep(signal);
    }, 3500);
  }
  function stopAlarm() { clearInterval(alarmTimer); alarmTimer = null; }
  let audio = null;
  function unlockAudio() {
    if (!S.data.prefs.sound) return;
    try {
      const Context = window.AudioContext || window.webkitAudioContext;
      if (!Context) return;
      // iOS 17+: let the alarm play even when the iPad is set to silent.
      if (navigator.audioSession && navigator.audioSession.type !== 'playback') navigator.audioSession.type = 'playback';
      audio = audio || new Context();
      if (audio.state === 'suspended') audio.resume();
    } catch (error) {
      audio = null;
    }
  }
  function beep(signal) {
    if (!audio || !S.data.prefs.sound) return;
    const tones = signal === 'target' ? [660, 880, 1175] : signal === 'time' ? [740, 740] : [988, 740, 988, 740];
    const start = audio.currentTime + 0.02;
    tones.forEach((frequency, i) => {
      const osc = audio.createOscillator(), gain = audio.createGain(), at = start + i * 0.2;
      osc.type = 'triangle';
      osc.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.35, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.17);
      osc.connect(gain);
      gain.connect(audio.destination);
      osc.start(at);
      osc.stop(at + 0.19);
    });
  }
  let wakeLock = null;
  async function keepAwake() {
    const want = S.data.prefs.awake && openTrades().length > 0 && document.visibilityState === 'visible';
    if (want && !wakeLock && navigator.wakeLock) {
      try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; renderLiveStatus(); });
      } catch (error) {
        wakeLock = null;
      }
    } else if (!want && wakeLock) {
      try { await wakeLock.release(); } catch (error) { /* already released */ }
      wakeLock = null;
    }
    renderLiveStatus();
  }

  // Radar ---------------------------------------------------------------------------
  async function loadRadar() {
    const token = S.radar.token + 1;
    Object.assign(S.radar, {token, busy: true, error: null});
    renderRadarStatus();
    try {
      const result = await D.radar(S.radar.chain, S.radar.kind);
      if (token !== S.radar.token) return;
      Object.assign(S.radar, {rows: result.rows, source: result.source, at: Date.now()});
    } catch (error) {
      if (token !== S.radar.token) return;
      S.radar.error = error.message;
      if (!S.radar.rows) S.radar.rows = [];
      S.radar.at = Date.now();
    } finally {
      if (token === S.radar.token) {
        S.radar.busy = false;
        if (S.page === 'radar') renderRadar();
      }
    }
  }
  function renderRadarStatus() {
    const box = $('#radar-status');
    if (S.radar.busy) box.textContent = 'Loading…';
    else if (S.radar.error) box.textContent = "Couldn't load this list: " + S.radar.error;
    else if (S.radar.at) box.textContent = `From ${S.radar.source} · updated ${timeText(S.radar.at)} · refreshes every minute`;
    else box.textContent = '';
    box.dataset.bad = S.radar.error ? 'true' : 'false';
  }
  function renderRadar() {
    document.querySelectorAll('#radar-chain button').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.chain === S.radar.chain)));
    document.querySelectorAll('#radar-kind button').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.kind === S.radar.kind)));
    renderRadarStatus();
    const list = $('#radar-list');
    if (!S.radar.rows) { list.replaceChildren(...Array.from({length: 6}, () => h('div', {class: 'radar-row skeleton', 'aria-hidden': 'true'}))); return; }
    if (!S.radar.rows.length) { list.replaceChildren(h('p', {class: 'empty-line'}, S.radar.error ? 'Nothing to show. Tap Refresh to try again.' : 'No coins in this list right now.')); return; }
    const s = strategy(), r = rules(), now = Date.now(), cap = r.bankrollUsd * r.maxTradePct / 100;
    list.replaceChildren(...S.radar.rows.map(m => radarRow(m, s, r, now, cap)));
  }
  function pctText(value) {
    if (value === null || value === undefined) return h('span', {class: 'muted'}, '—');
    return h('span', {'data-sign': value >= 0 ? 'up' : 'down'}, `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(Math.abs(value) >= 100 ? 0 : 1)}%`);
  }
  function radarRow(m, s, r, now, cap) {
    const graded = C.grade(m, {status: 'skipped'}, s, {now, trades: S.data.trades, sizeUsd: cap, costPct: C.costPct(m.chain, cap, m.liquidity, r, s)});
    const fails = graded.groups.flatMap(group => group.items).filter(item => item.status === 'fail');
    const chip = fails.length
      ? h('span', {class: 'fit-chip', 'data-fit': 'no'}, `Breaks ${fails.length}: ` + fails.slice(0, 2).map(item => item.label.toLowerCase()).join(', ') + (fails.length > 2 ? '…' : ''))
      : h('span', {class: 'fit-chip', 'data-fit': 'yes'}, 'Fits market rules');
    const cell = (label, value) => h('span', {class: 'cell'}, h('small', {}, label), typeof value === 'string' ? h('span', {class: 'num'}, value) : value);
    return h('button', {type: 'button', class: 'radar-row', onclick: () => startCheck(m.address)},
      avatar(m.symbol, m.imageUrl),
      h('span', {class: 'radar-id'}, h('b', {}, m.symbol), h('span', {}, m.name)),
      h('span', {class: 'radar-cells'}, cell('Age', m.createdAt ? C.shortAge(now - m.createdAt) : '—'), cell('Mcap', C.compactUsd(m.valuationUsd)),
        cell('Liq', C.compactUsd(m.liquidity)), cell('5m', pctText(m.change5m)), cell('1h', pctText(m.change1h))),
      chip);
  }

  // Step 6: journal -------------------------------------------------------------------
  function renderJournal() {
    const body = $('#journal-body'), trades = S.data.trades, now = Date.now();
    const closed = trades.filter(row => row.status === 'closed').sort((a, b) => b.closedAt - a.closedAt);
    if (!closed.length) {
      body.replaceChildren(h('div', {class: 'card empty'}, h('h2', {}, 'Nothing here yet'),
        h('p', {}, 'Every trade you log lands here: what you planned, what happened, whether you followed the plan, and what to fix. Patterns show up after a handful of trades.'),
        h('button', {type: 'button', onclick: () => go('trade')}, 'Check a coin')));
      return;
    }
    const stats = C.stats(trades), review = C.review(trades, now);
    body.replaceChildren(todayCard(review), statsCard(stats), planCompare(stats), feelingsCard(stats), historyCard(closed));
  }
  function todayCard(review) {
    if (!review.closes) return h('div', {class: 'card'}, h('p', {class: 'eyebrow'}, 'Today'), h('h2', {}, 'No finished trades today yet'), h('p', {}, 'Your daily debrief shows up here after your first sell.'));
    return h('div', {class: 'card today', 'data-result': review.netUsd >= 0 ? 'up' : 'down'},
      h('p', {class: 'eyebrow'}, 'Today'),
      h('h2', {}, h('span', {class: 'num'}, C.signedUsd(review.netUsd)), ` from ${review.closes} trade${review.closes !== 1 ? 's' : ''} (${review.wins} win${review.wins !== 1 ? 's' : ''}, ${review.losses} loss${review.losses !== 1 ? 'es' : ''})`),
      review.well.length ? h('div', {}, h('b', {}, 'What went well'), h('ul', {}, review.well.map(item => h('li', {}, item)))) : null,
      review.ruleBreaks.length ? h('div', {class: 'callout bad'}, h('b', {}, 'Rules you broke'), h('ul', {}, review.ruleBreaks.map(item => h('li', {}, item)))) : null,
      h('p', {class: 'tomorrow'}, h('b', {}, 'For tomorrow: '), review.tomorrow));
  }
  function statsCard(stats) {
    return h('div', {class: 'card'}, h('h2', {}, 'All trades'),
      h('div', {class: 'tiles'},
        tile('Net result', C.signedUsd(stats.netUsd), `${stats.closes} trade${stats.closes !== 1 ? 's' : ''}`, stats.netUsd >= 0 ? 'up' : 'down'),
        tile('Win rate', stats.winRatePct + '%', `${stats.wins} won · ${stats.losses} lost`),
        tile('Average win', stats.averageWinUsd === null ? '—' : C.signedUsd(stats.averageWinUsd), null, 'up'),
        tile('Average loss', stats.averageLossUsd === null ? '—' : C.signedUsd(stats.averageLossUsd), null, 'down'),
        tile('Followed the plan', stats.followedPct + '%', 'of trades'),
        tile('Best · worst', `${stats.best} · ${stats.worst}`, null)));
  }
  function planCompare(stats) {
    const biggest = Math.max(Math.abs(stats.followedNetUsd), Math.abs(stats.brokeNetUsd), 1);
    const row = (label, net, count) => {
      const bar = h('span', {class: 'bar-fill', 'data-sign': net >= 0 ? 'up' : 'down'});
      bar.style.width = Math.round(Math.abs(net) / biggest * 100) + '%';
      return h('div', {class: 'bar-row'}, h('span', {class: 'bar-label'}, label, h('small', {}, `${count} trade${count !== 1 ? 's' : ''}`)),
        h('span', {class: 'bar'}, bar), h('b', {class: 'num', 'data-sign': net >= 0 ? 'up' : 'down'}, C.signedUsd(net)));
    };
    return h('div', {class: 'card'}, h('h2', {}, 'Plan followed vs plan broken'),
      h('p', {}, 'The most useful number in this journal: what your trades make when you stick to the plan, and when you don\'t.'),
      row('Followed', stats.followedNetUsd, stats.followedCloses), row('Broke a rule', stats.brokeNetUsd, stats.brokeCloses));
  }
  function feelingsCard(stats) {
    const entries = Object.entries(stats.byFeeling).sort((a, b) => b[1].closes - a[1].closes);
    const biggest = Math.max(1, ...entries.map(([, value]) => Math.abs(value.netUsd)));
    return h('div', {class: 'card'}, h('h2', {}, 'How you felt'),
      entries.map(([feeling, value]) => {
        const bar = h('span', {class: 'bar-fill', 'data-sign': value.netUsd >= 0 ? 'up' : 'down'});
        bar.style.width = Math.round(Math.abs(value.netUsd) / biggest * 100) + '%';
        return h('div', {class: 'bar-row'}, h('span', {class: 'bar-label'}, FEELING_LABELS[feeling] || 'Not logged', h('small', {}, `${value.closes} trade${value.closes !== 1 ? 's' : ''}`)),
          h('span', {class: 'bar'}, bar), h('b', {class: 'num', 'data-sign': value.netUsd >= 0 ? 'up' : 'down'}, C.signedUsd(value.netUsd)));
      }));
  }
  function historyCard(closed) {
    return h('div', {class: 'card'}, h('h2', {}, 'History'),
      h('div', {class: 'history'}, closed.slice(0, 200).map(t => {
        const remove = h('button', {type: 'button', class: 'quiet danger', onclick: () => armed(remove, 'Tap again to delete', 'Delete this trade', () => deleteTrade(t.id))}, 'Delete this trade');
        return h('details', {class: 'trade-row'},
          h('summary', {}, h('b', {}, t.symbol), h('span', {class: 'muted'}, dateText(t.closedAt)),
            h('span', {class: 'plan-chip', 'data-ok': t.followedPlan ? 'true' : 'false'}, t.followedPlan ? 'Plan followed' : 'Rule broken'),
            h('b', {class: 'num', 'data-sign': t.pnlUsd >= 0 ? 'up' : 'down'}, C.signedUsd(t.pnlUsd))),
          h('div', {class: 'trade-detail'},
            h('p', {}, `${C.usd(t.sizeUsd)} in at ${C.priceText(t.entryPrice)}, out at ${C.priceText(t.exitPrice)}. Exit: ${EXIT_WORDS[t.exitReason]}. Check said: ${({skip: 'skip it', rules: "doesn't fit your rules", caution: 'be careful', pass: 'fits your rules'})[t.verdict] || 'unknown'}.`),
            t.feeling ? h('p', {}, 'Felt: ' + FEELING_LABELS[t.feeling]) : null,
            t.overrideReason ? h('p', {}, 'Why you broke a rule: ' + t.overrideReason) : null,
            t.ruleBreaks.length ? h('ul', {}, t.ruleBreaks.map(item => h('li', {}, item))) : null,
            t.lessons.length ? h('ul', {class: 'lessons'}, t.lessons.map(item => h('li', {}, item))) : null,
            t.note ? h('p', {class: 'note'}, t.note) : null,
            remove));
      })));
  }

  // Rules ---------------------------------------------------------------------------
  function renderRules() {
    $('#rules-body').replaceChildren(strategyCard(), moneyCard(), costsCard(), appCard(), backupCard(), aboutCard());
  }
  function numberField(id, label, value, commit, whole) {
    const error = h('span', {class: 'field-error', role: 'alert', hidden: true});
    const input = h('input', {id, type: 'text', inputmode: whole ? 'numeric' : 'decimal', autocomplete: 'off', value: value === null || value === undefined ? '' : C.plain(value),
      onchange: () => {
        try {
          commit(input.value);
          error.hidden = true;
          input.removeAttribute('aria-invalid');
          toast(label + ' saved.');
        } catch (problem) {
          error.textContent = problem.message;
          error.hidden = false;
          input.setAttribute('aria-invalid', 'true');
        }
      }});
    return h('label', {class: 'field', for: id}, h('span', {}, label), input, error);
  }
  function strategyCard() {
    const preset = S.data.strategy.preset, config = strategy();
    return h('div', {class: 'card'}, h('h2', {}, 'Strategy'),
      h('p', {}, 'The same presets as your Mac Scout. Every coin check is graded against the one you pick, and the plan uses its target, stop and time limit.'),
      h('div', {class: 'presets', role: 'radiogroup', 'aria-label': 'Strategy'}, Object.entries(C.STRATEGIES).map(([key, item]) => h('button', {type: 'button', class: 'preset', role: 'radio', 'aria-checked': String(key === preset),
        onclick: () => { S.data.strategy = {preset: key, edits: {}}; save(); renderRules(); toast(`Strategy: ${item.name}.`); }}, h('b', {}, item.name), h('span', {}, item.blurb)))),
      h('h3', {}, `Tweak ${C.STRATEGIES[preset].name}`),
      h('div', {class: 'field-grid'}, Object.entries(C.EDITS).map(([field, [label, low, high]]) => numberField('edit-' + field, label, config[field] === null ? 0 : config[field],
        value => { S.data.strategy.edits[field] = C.bounded(value, label, low, high); save(); }))),
      Object.keys(S.data.strategy.edits).length ? h('button', {type: 'button', class: 'quiet', onclick: () => { S.data.strategy.edits = {}; save(); renderRules(); toast('Back to the preset numbers.'); }},
        `Reset to ${C.STRATEGIES[preset].name}'s numbers`) : null);
  }
  function moneySummary() {
    const r = rules();
    return `You risk about ${C.usd(r.bankrollUsd * r.riskPct / 100)} per trade (what you lose if the stop hits), no single trade is bigger than ${C.usd(r.bankrollUsd * r.maxTradePct / 100)}, and you stop for the day after ${r.maxTradesPerDay} trades or ${C.usd(-r.dailyLossLimitUsd)}.`;
  }
  function rulesField(field) {
    const [, low, high, label, whole] = C.RULES[field];
    return numberField('rule-' + field, label, rules()[field], value => {
      S.data.rules = {...rules(), [field]: C.bounded(value, label, low, high, whole)};
      save();
      const summary = $('#money-summary');
      if (summary) summary.textContent = moneySummary();
      renderTop();
    }, whole);
  }
  function moneyCard() {
    return h('div', {class: 'card'}, h('h2', {}, 'Money rules'),
      h('p', {class: 'summary', id: 'money-summary'}, moneySummary()),
      h('div', {class: 'field-grid'}, ['bankrollUsd', 'riskPct', 'maxTradePct', 'maxTradesPerDay', 'dailyLossLimitUsd', 'maxOpen', 'cooldownAfterLosses', 'cooldownMinutes'].map(rulesField)));
  }
  function costsCard() {
    return h('div', {class: 'card'}, h('h2', {}, 'Trading costs'),
      h('p', {}, "Scout counts these on every buy and every sell when it sizes a trade and works out your real profit. Match them to your Axiom settings (slippage and priority fee are in Axiom's buy panel). Until you do, they're estimates."),
      h('div', {class: 'field-grid'}, ['feePct', 'slippagePct', 'solanaFeeUsd'].map(rulesField)));
  }
  function toggle(label, key, note) {
    const button = h('button', {type: 'button', class: 'switch', role: 'switch', 'aria-checked': String(S.data.prefs[key]), onclick: () => {
      S.data.prefs[key] = !S.data.prefs[key];
      button.setAttribute('aria-checked', String(S.data.prefs[key]));
      save();
      if (key === 'awake') keepAwake();
      if (key === 'sound' && S.data.prefs.sound) unlockAudio();
    }}, h('span', {class: 'switch-knob', 'aria-hidden': 'true'}));
    return h('div', {class: 'toggle-row'}, h('div', {}, h('b', {}, label), h('p', {}, note)), button);
  }
  function appCard() {
    return h('div', {class: 'card'}, h('h2', {}, 'Alerts'),
      toggle('Alarm sound', 'sound', 'Beeps when your plan says sell. Turn the iPad volume up.'),
      toggle('Keep the screen on', 'awake', 'While a trade is open. The iPad pauses Scout when the screen locks or you switch apps, so alerts only work while Scout is on screen.'),
      h('div', {class: 'actions'}, h('button', {type: 'button', class: 'secondary', onclick: () => { unlockAudio(); beep('stop'); toast(audio ? 'That is the sell alarm.' : "Sound isn't available here."); }}, 'Test the alarm')));
  }
  function backupCard() {
    const area = h('textarea', {id: 'restore-text', rows: '3', placeholder: 'Paste a Scout backup here to restore it'});
    const restore = h('button', {type: 'button', class: 'secondary', onclick: () => {
      let parsed;
      try { parsed = JSON.parse(area.value); } catch (error) { toast("That isn't a Scout backup. Copy the whole backup text."); return; }
      const data = sanitize(parsed);
      armed(restore, `Tap again: replace this iPad's journal with ${data.trades.length} trades`, 'Restore backup', () => {
        S.data = data;
        cards.forEach(card => card.el.remove());
        cards.clear();
        save();
        renderPage();
        toast('Backup restored.');
      });
    }}, 'Restore backup');
    return h('div', {class: 'card'}, h('h2', {}, 'Backup'),
      h('p', {}, 'Your trades live only on this iPad. Now and then, copy a backup and paste it into Notes. Use Scout from its Home Screen icon: Safari tabs keep a separate journal.'),
      h('div', {class: 'actions'}, h('button', {type: 'button', onclick: () => copyText(JSON.stringify(S.data), `Backup copied (${S.data.trades.length} trades). Paste it into Notes.`)}, 'Copy backup')),
      h('label', {class: 'field', for: 'restore-text'}, h('span', {}, 'Restore'), area),
      h('div', {class: 'actions'}, restore));
  }
  function aboutCard() {
    const status = h('span', {class: 'muted', id: 'update-status'}, `Version ${VERSION}`);
    return h('div', {class: 'card'}, h('h2', {}, 'About Scout for iPad'),
      h('div', {class: 'split'}, status, h('button', {type: 'button', class: 'secondary', onclick: () => checkUpdate(true)}, 'Check for updates')),
      h('ul', {class: 'about'},
        h('li', {}, 'Scout reads public data from DexScreener, RugCheck, GoPlus and GeckoTerminal. It never trades and never connects to a wallet. Never type a seed phrase or private key into anything Scout-related.'),
        h('li', {}, 'Alerts only work while Scout is on screen. Split View with Safari works well: Axiom on one side, Scout on the other.'),
        h('li', {}, 'Contract scans miss things, and prices lag by a few seconds. A pass makes a coin less bad, not safe.'),
        h('li', {}, 'This journal is separate from your Mac Scout.')));
  }

  // Side panel (iPad landscape) ------------------------------------------------------
  function renderSide() {
    const side = $('#side');
    if (!side || getComputedStyle(side).display === 'none') return;
    const open = openTrades(), now = Date.now(), g = guardNow();
    fill(side,
      h('div', {class: 'side-head'}, h('p', {class: 'eyebrow'}, 'Live'), h('h2', {}, open.length ? `${open.length} open trade${open.length !== 1 ? 's' : ''}` : 'No open trades')),
      open.length ? open.map(trade => {
        const v = C.liveView(trade, now);
        return h('button', {type: 'button', class: 'side-card', 'data-signal': trade.signal, onclick: () => go('live')},
          h('span', {class: 'side-row'}, h('b', {}, trade.symbol), h('b', {class: 'num', 'data-sign': v.pnlUsd >= 0 ? 'up' : 'down'}, C.signedUsd(v.pnlUsd))),
          h('span', {class: 'side-row'}, h('span', {class: 'side-signal'}, SIGNAL_LINES[trade.signal][0]),
            h('span', {class: 'num muted', 'data-left': trade.id}, v.secondsLeft > 0 ? C.clock(v.secondsLeft) + ' left' : 'time over')));
      }) : h('p', {class: 'muted'}, 'Trades you log show up here, so you can check the next coin while watching this one.'),
      h('div', {class: 'side-guard', 'data-status': g.status}, h('b', {}, g.status === 'ready' ? 'Clear to trade' : g.status === 'cooldown' ? 'Take a break' : 'Done for today'),
        h('span', {}, g.status === 'ready' ? `${g.tradesLeft} trade${g.tradesLeft !== 1 ? 's' : ''} left today · ${C.usd(g.lossLeftUsd)} before your daily stop` : g.reasons[0])));
  }
  function tickSide() {
    const now = Date.now();
    document.querySelectorAll('#side [data-left]').forEach(el => {
      const trade = S.data.trades.find(row => row.id === el.dataset.left);
      if (!trade) return;
      const left = C.liveView(trade, now).secondsLeft;
      el.textContent = left > 0 ? C.clock(left) + ' left' : 'time over';
    });
  }

  // Little helpers ------------------------------------------------------------------
  async function copyText(value, message) {
    try {
      await navigator.clipboard.writeText(value);
      toast(message);
    } catch (error) {
      const area = h('textarea', {class: 'copy-fallback', readonly: true, value});
      document.body.append(area);
      area.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (problem) { ok = false; }
      area.remove();
      toast(ok ? message : "Couldn't copy here. Long-press the text to copy it.");
    }
  }
  let toastTimer = null;
  function toast(message) {
    const box = $('#toast');
    box.textContent = message;
    box.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { box.hidden = true; }, 4500);
  }
  async function checkUpdate(manual) {
    try {
      const response = await fetch('version.json?t=' + Date.now(), {cache: 'no-store'});
      const info = await response.json();
      if (info && typeof info.version === 'string' && info.version !== VERSION) {
        S.update = info;
        $('#update-title').textContent = `Scout ${C.text(info.version, 20)} is ready.`;
        $('#update-notes').textContent = C.text(info.notes, 200);
        $('#update-banner').hidden = false;
        if (manual) toast('Update found. Tap Update now at the top.');
      } else if (manual) {
        toast(`You have the newest Scout (${VERSION}).`);
      }
    } catch (error) {
      if (manual) toast("Couldn't check for updates. Check your internet connection.");
    }
  }
  function applyUpdate() {
    if (!S.update) return;
    location.replace(location.pathname + '?v=' + encodeURIComponent(C.text(S.update.version, 20)) + '#' + S.page);
  }

  // Start ---------------------------------------------------------------------------
  function everySecond() {
    const now = Date.now();
    for (const trade of openTrades()) {
      if (trade.signal === 'hold' && now - trade.openedAt >= trade.holdMinutes * 60000) {
        const fired = C.mark(trade, trade.mark, now);
        save();
        if (fired) raiseAlert(trade, fired, false);
      }
    }
    if (S.page === 'live') tickLive();
    if (S.page === 'trade' && S.flow.step === 'plan') updatePlanLive();
    if (S.page === 'radar' && !S.radar.busy && S.radar.at && now - S.radar.at > 60000) loadRadar();
    renderTop();
    tickSide();
    const planning = S.page === 'trade' && S.flow.step === 'plan' && S.flow.market;
    if ((openTrades().length || planning) && !priceBusy && now - lastPriceAt >= PRICE_EVERY && document.visibilityState === 'visible') refreshPrices();
  }
  function boot() {
    document.querySelectorAll('[data-go]').forEach(el => el.addEventListener('click', () => go(el.dataset.go)));
    $('#radar-refresh').addEventListener('click', loadRadar);
    $('#radar-chain').addEventListener('click', event => {
      const button = event.target.closest('button[data-chain]');
      if (!button || button.dataset.chain === S.radar.chain) return;
      Object.assign(S.radar, {chain: button.dataset.chain, rows: null});
      renderRadar();
      loadRadar();
    });
    $('#radar-kind').addEventListener('click', event => {
      const button = event.target.closest('button[data-kind]');
      if (!button || button.dataset.kind === S.radar.kind) return;
      Object.assign(S.radar, {kind: button.dataset.kind, rows: null});
      renderRadar();
      loadRadar();
    });
    $('#live-refresh').addEventListener('click', () => { if (!priceBusy) refreshPrices(); });
    $('#guard-pill').addEventListener('click', () => {
      const g = guardNow();
      toast(g.status === 'ready' ? `Today: ${g.tradesToday} trade${g.tradesToday !== 1 ? 's' : ''}, ${C.signedUsd(g.todayNetUsd)}. ${g.tradesLeft} left and ${C.usd(g.lossLeftUsd)} before your daily stop.` : g.reasons.join(' '));
    });
    $('#alert-ok').addEventListener('click', hideAlert);
    $('#alert-sold').addEventListener('click', () => {
      const id = S.alert && S.alert.id;
      hideAlert();
      go('live');
      if (id) openClose(id);
    });
    $('#alert-axiom').addEventListener('click', stopAlarm);
    $('#update-go').addEventListener('click', applyUpdate);
    $('#install-ok').addEventListener('click', () => { S.data.hints.install = true; save(); $('#install-banner').hidden = true; });
    document.addEventListener('pointerdown', unlockAudio, {passive: true});
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('#alert').hidden) hideAlert(); });
    window.addEventListener('resize', debounce(() => {
      renderSide();
      cards.forEach(card => { card.drawn = ''; });
      if (S.page === 'live') tickLive();
      if (S.page === 'trade' && S.flow.step === 'check') drawCheckChart();
    }, 200));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      catchUpAll().finally(() => { lastPriceAt = 0; });
      keepAwake();
      checkUpdate(false);
    });
    const standalone = navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
    $('#install-banner').hidden = standalone || S.data.hints.install;
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    const start = (location.hash || '').replace('#', '');
    go(PAGES.includes(start) ? start : openTrades().length ? 'live' : 'trade');
    setInterval(everySecond, 1000);
    setTimeout(() => checkUpdate(false), 3000);
    setInterval(() => checkUpdate(false), 30 * 60000);
    if (openTrades().length) catchUpAll().finally(() => { lastPriceAt = 0; });
    keepAwake();
  }
  boot();
})();
