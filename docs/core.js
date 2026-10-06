/* Scout for iPad · the rules.
   Pure functions only: no screen, no network. They mirror the Mac Scout coach
   (coach.py) and live trade coach (trade_session.py) so both give the same answers.
   Scout never trades and never touches a wallet: you buy and sell in Axiom. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ScoutCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CHAINS = {solana: 'Solana', bsc: 'BNB', ethereum: 'Ethereum', base: 'Base', arbitrum: 'Arbitrum', robinhood: 'Robinhood'};
  const GECKO = {solana: 'solana', bsc: 'bsc', ethereum: 'eth', base: 'base', arbitrum: 'arbitrum', robinhood: 'robinhood'};
  const EVM_IDS = {bsc: '56', ethereum: '1', base: '8453', arbitrum: '42161', robinhood: '4663'};
  const EXPLORERS = {solana: 'https://solscan.io/token/', bsc: 'https://bscscan.com/token/', ethereum: 'https://etherscan.io/token/',
    base: 'https://basescan.org/token/', arbitrum: 'https://arbiscan.io/token/', robinhood: 'https://robinhoodchain.blockscout.com/token/'};
  // Network fee per buy or sell in dollars. Solana's comes from your settings (Axiom priority fee).
  const GAS = {bsc: 0.2, ethereum: 2, base: 0.15, arbitrum: 0.3, robinhood: 0.05};
  const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const IMAGE_HOSTS = ['https://dd.dexscreener.com/', 'https://cdn.dexscreener.com/', 'https://assets.geckoterminal.com/', 'https://coin-images.coingecko.com/'];

  // Strategies: the same presets as the Mac Scout paper bot (autopaper.py PROFILES).
  const MOMENTUM = {minLiquidity: 50000, minVolume5m: 5000, takeProfitPct: 20, stopLossPct: 8, maxHoldMinutes: 30, profitBasis: 'gross',
    minChange5m: 2, maxChange5m: 25, maxRoundTripCostPct: null, momentumGate: true, minBuyShare: 0.55, minTransactions5m: 1,
    minAgeSeconds: 600, maxAgeSeconds: 31536000, qualityChecks: false, impactMultiplier: 0, minValuationUsd: null, maxValuationUsd: null,
    minLiquidityToValuationPct: null, trailingStopPct: null, requireRisingHour: true, minChange1h: null, maxBuyShare: 1, minSells5m: 0,
    requireSocials: false, maxTop10HolderPct: null, maxCreatorPct: null, maxCreatorLaunches: null, allowedChains: null,
    confirmationSamples: 0, confirmationSeconds: 0};
  const ACTIVE = {...MOMENTUM, maxHoldMinutes: 5, profitBasis: 'net', takeProfitPct: 2, minChange5m: 0.5, maxChange5m: 20, maxRoundTripCostPct: 6};
  const EXPLORE = {...ACTIVE, minLiquidity: 5000, minVolume5m: 100, momentumGate: false, minBuyShare: 0, minTransactions5m: 3, minAgeSeconds: 30};
  const GOAL = {...EXPLORE, qualityChecks: true, minLiquidity: 50000, minVolume5m: 5000, minTransactions5m: 20, minAgeSeconds: 600,
    momentumGate: true, minBuyShare: 0.55, minChange5m: 0.5, maxChange5m: 15, maxRoundTripCostPct: 4, takeProfitPct: 8, stopLossPct: 6,
    maxHoldMinutes: 10, impactMultiplier: 2, confirmationSeconds: 30, confirmationSamples: 3};
  const TRENCH = {...GOAL, maxRoundTripCostPct: 5.5, minAgeSeconds: 30, maxAgeSeconds: 172800, minValuationUsd: 5000, maxValuationUsd: 3000000,
    minLiquidityToValuationPct: 5, minLiquidity: 2000, minVolume5m: 100, minTransactions5m: 5, minBuyShare: 0.5, minChange5m: 0, maxChange5m: 60,
    takeProfitPct: 12, stopLossPct: 6, maxHoldMinutes: 7, confirmationSamples: 2, confirmationSeconds: 10, requireRisingHour: false};
  const BLITZ = {...GOAL, allowedChains: ['solana', 'robinhood', 'ethereum'], profitBasis: 'gross', takeProfitPct: 7, stopLossPct: 2,
    maxHoldMinutes: 30, minLiquidity: 25000, minVolume5m: 2000, minTransactions5m: 20, minAgeSeconds: 600, maxAgeSeconds: 2592000,
    minValuationUsd: 50000, maxValuationUsd: 20000000, minLiquidityToValuationPct: 3, momentumGate: true, minChange5m: 0, maxChange5m: 30,
    requireRisingHour: false, minChange1h: -40, minBuyShare: 0.5, maxBuyShare: 0.9, minSells5m: 3, requireSocials: true,
    maxTop10HolderPct: 35, maxCreatorPct: 5, maxCreatorLaunches: 2, maxRoundTripCostPct: 5, confirmationSamples: 2, confirmationSeconds: 10};
  const STRATEGIES = {
    blitz: {name: 'Blitz', blurb: 'Strictest safety checks: holders, developer, socials, honeypot pattern. +7% target, −2% stop, up to 30 minutes.', rules: BLITZ},
    goal: {name: 'Goal', blurb: 'Steady, liquid coins at least 10 minutes old. +8% after fees, −6% stop, 10 minutes.', rules: GOAL},
    trench: {name: 'Trench', blurb: 'Brand-new coins, 30 seconds to 2 days old. +12% after fees, −6% stop, 7 minutes.', rules: TRENCH},
    momentum: {name: 'Momentum', blurb: 'Older coins on a rising chart. +20% target, −8% stop, 30 minutes.', rules: MOMENTUM},
    active: {name: 'Active', blurb: 'Quick in and out on liquid coins. +2% after fees, −8% stop, 5 minutes.', rules: ACTIVE},
    explore: {name: 'Explore', blurb: 'Loose rules for learning. +2% after fees, −8% stop, 5 minutes.', rules: EXPLORE}};
  // Strategy settings you can change on top of a preset: field: [label, low, high].
  const EDITS = {takeProfitPct: ['Target %', 0.5, 1000], stopLossPct: ['Stop %', 0.5, 90], maxHoldMinutes: ['Time limit (minutes)', 1, 1440],
    trailingStopPct: ['Trailing stop % (0 = off)', 0, 50], minLiquidity: ['Minimum liquidity ($)', 0, 100000000],
    minVolume5m: ['Minimum 5-minute volume ($)', 0, 100000000], maxChange5m: ['Biggest 5-minute rise allowed (%)', 0, 10000]};

  // Your money rules (trade_session.py SETTINGS) plus trading costs.
  const RULES = {bankrollUsd: [300, 10, 10000000, 'Bankroll ($)'], riskPct: [1, 0.1, 10, 'Risk per trade (%)'],
    maxTradePct: [10, 1, 100, 'Biggest trade (% of bankroll)'], maxTradesPerDay: [5, 1, 100, 'Trades per day', true],
    dailyLossLimitUsd: [15, 1, 1000000, 'Daily loss limit ($)'], maxOpen: [2, 1, 20, 'Open trades at once', true],
    cooldownAfterLosses: [2, 1, 20, 'Losses in a row before a break', true], cooldownMinutes: [60, 0, 1440, 'Break length (minutes)', true],
    feePct: [1, 0, 10, 'Axiom fee per buy or sell (%)'], slippagePct: [1, 0, 50, 'Slippage per buy or sell (%)'],
    solanaFeeUsd: [0.1, 0, 20, 'Solana priority fee per buy or sell ($)']};
  const FEELINGS = ['calm', 'fomo', 'scared', 'greedy', 'revenge', 'bored'];
  const SIGNALS = {hold: 'Hold. Everything is inside your plan.',
    stop: 'SELL NOW: your stop was hit. Waiting usually makes it worse.',
    trail: "SELL NOW: it gave back your trailing stop from its best price. Lock in what's left.",
    target: 'Target hit. Sell now, or keep only a trailing stop running.',
    time: "Time's up. Your plan says to get out now, win or lose."};
  const DEFAULT_COST_PCT = 3;
  const GOPLUS_FLAGS = {is_honeypot: 'Honeypot: you may not be able to sell', cannot_sell_all: "You can't sell all your coins",
    cannot_buy: 'Buying is blocked', is_blacklisted: 'Owner can block wallets', is_mintable: 'Owner can create more coins',
    owner_change_balance: 'Owner can change balances', hidden_owner: 'Hidden owner', is_proxy: 'Contract code can be changed',
    transfer_pausable: 'Owner can pause trading', slippage_modifiable: 'Owner can change the tax',
    can_take_back_ownership: 'Owner can take back control', selfdestruct: 'Contract can self-destruct',
    external_call: 'Contract calls outside code', is_whitelisted: 'Only whitelisted wallets can trade',
    anti_whale_modifiable: 'Owner can change max-buy limits', personal_slippage_modifiable: 'Owner can set a tax per wallet',
    trading_cooldown: 'Trading cooldown between trades', is_airdrop_scam: 'Airdrop scam'};
  const GOPLUS_REQUIRED = ['is_honeypot', 'cannot_sell_all', 'cannot_buy', 'is_blacklisted', 'is_mintable', 'owner_change_balance',
    'hidden_owner', 'is_proxy', 'transfer_pausable', 'slippage_modifiable', 'can_take_back_ownership', 'selfdestruct', 'external_call'];

  // Numbers and text ------------------------------------------------------------
  function num(value) {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
    const n = typeof value === 'number' ? value : Number(String(value).trim());
    return Number.isFinite(n) ? n : null;
  }
  function text(value, limit) {
    return typeof value === 'string' || typeof value === 'number' ? String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit) : '';
  }
  function round2(value) { return Math.round(value * 100) / 100; }
  function sum(values) { return values.reduce((total, value) => total + value, 0); }
  function plain(value) {
    if (!Number.isFinite(value)) return '';
    if (value === 0) return '0';
    const digits = Math.min(20, Math.max(2, 5 - Math.floor(Math.log10(Math.abs(value)))));
    return value.toFixed(digits).replace(/\.?0+$/, '');
  }
  function pct(value) {
    return Math.abs(value) >= 10 ? `${value.toFixed(0)}%` : `${value.toFixed(1).replace(/\.0$/, '')}%`;
  }
  function signedPct(value) { return (value >= 0 ? '+' : '−') + pct(Math.abs(value)); }
  function usd(value) {
    const sign = value < 0 ? '−' : '';
    const abs = Math.abs(value);
    return sign + '$' + (abs >= 1000 ? abs.toLocaleString('en-US', {maximumFractionDigits: 0})
      : abs.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2}));
  }
  function money(value) { return usd(value); }
  function signedUsd(value) { return (value >= 0 ? '+' : '−') + usd(Math.abs(value)); }
  function compactUsd(value) {
    if (value === null || value === undefined) return '—';
    const abs = Math.abs(value);
    if (abs >= 1e9) return '$' + (value / 1e9).toFixed(abs >= 1e10 ? 0 : 1) + 'B';
    if (abs >= 1e6) return '$' + (value / 1e6).toFixed(abs >= 1e7 ? 0 : 1) + 'M';
    if (abs >= 1e3) return '$' + (value / 1e3).toFixed(abs >= 1e4 ? 0 : 1) + 'K';
    return '$' + value.toFixed(0);
  }
  const SUBSCRIPT = '₀₁₂₃₄₅₆₇₈₉';
  function priceText(value) {
    if (!(value > 0)) return '$0';
    if (value >= 1) return '$' + value.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 4});
    if (value >= 0.0001) return '$' + String(Number(value.toPrecision(4)));
    let exp = Math.floor(Math.log10(value));
    let digits = Math.round(value * Math.pow(10, 3 - exp));
    if (digits >= 10000) { exp += 1; digits = Math.round(value * Math.pow(10, 3 - exp)); }
    const zeros = String(-exp - 1).split('').map(d => SUBSCRIPT[Number(d)]).join('');
    return '$0.0' + zeros + String(digits).replace(/0+$/, '');
  }
  function duration(seconds) {
    seconds = Math.floor(seconds);
    if (seconds < 120) return `${seconds} seconds`;
    if (seconds < 7200) return `${Math.floor(seconds / 60)} minutes`;
    if (seconds < 172800) return `${Math.floor(seconds / 3600)} hours`;
    return `${Math.floor(seconds / 86400)} days`;
  }
  function shortAge(ms) {
    const minutes = Math.max(0, Math.floor(ms / 60000));
    if (minutes < 60) return minutes + 'm';
    if (minutes < 2880) return Math.floor(minutes / 60) + 'h';
    return Math.floor(minutes / 1440) + 'd';
  }
  function clock(seconds) {
    seconds = Math.max(0, Math.floor(seconds));
    const m = Math.floor(seconds / 60), s = seconds % 60;
    return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}:${String(s).padStart(2, '0')}`;
  }
  function bounded(value, field, low, high, whole) {
    const n = num(value);
    if (n === null) throw new Error(field + ' must be a number.');
    if (n < low || n > high || (whole && !Number.isInteger(n))) {
      throw new Error(`${field} must be ${whole ? 'a whole number ' : ''}between ${plain(low)} and ${plain(high)}.`);
    }
    return n;
  }

  // Addresses -------------------------------------------------------------------
  function validMint(value) {
    if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
    const bytes = [];
    for (const ch of value) {
      let carry = B58.indexOf(ch);
      for (let i = 0; i < bytes.length; i++) { carry += bytes[i] * 58; bytes[i] = carry & 255; carry >>= 8; }
      while (carry > 0) { bytes.push(carry & 255); carry >>= 8; }
    }
    let zeros = 0;
    while (zeros < value.length && value[zeros] === '1') zeros++;
    return zeros + bytes.length === 32;
  }
  function addressOk(chain, address) {
    return Boolean(CHAINS[chain]) && (chain === 'solana' ? validMint(address) : typeof address === 'string' && EVM_RE.test(address));
  }
  // EVM singleton pools (Uniswap v4) are named by a 32-byte id instead of an address.
  function poolIdOk(chain, value) {
    return addressOk(chain, value) || (chain !== 'solana' && Boolean(CHAINS[chain]) && typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value));
  }
  function sameAddress(first, second, chain) {
    if (typeof first !== 'string' || typeof second !== 'string') return false;
    return chain === 'solana' || validMint(first) ? first === second : first.toLowerCase() === second.toLowerCase();
  }
  // Pull a contract address out of whatever was pasted: a bare CA, or a DexScreener, Axiom or pump.fun link.
  function findAddress(input) {
    const raw = String(input || '').trim();
    const evm = raw.match(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/);
    if (evm) return evm[0];
    const words = raw.split(/[^1-9A-HJ-NP-Za-km-z]+/).filter(validMint);
    return words.length ? words[words.length - 1] : raw;
  }
  function safeImage(url) {
    return typeof url === 'string' && url.length < 500 && IMAGE_HOSTS.some(host => url.startsWith(host)) && !/missing\.png/.test(url) ? url : null;
  }
  function axiomUrl(market) {
    return market && market.chain === 'solana' && validMint(market.pair) ? 'https://axiom.trade/meme/' + market.pair : null;
  }

  // Market data -----------------------------------------------------------------
  function normalizeMarket(pairs, chain, address, now) {
    const found = [];
    for (const pair of Array.isArray(pairs) ? pairs : []) {
      if (!pair || typeof pair !== 'object' || pair.chainId !== chain || !pair.baseToken || !sameAddress(pair.baseToken.address, address, chain)) continue;
      const price = num(pair.priceUsd), liquidity = num(pair.liquidity && pair.liquidity.usd);
      if (!(price > 0) || !(liquidity > 0) || !poolIdOk(chain, pair.pairAddress)) continue;
      found.push([liquidity, pair]);
    }
    if (!found.length) return null;
    found.sort((a, b) => b[0] - a[0]);
    const pair = found[0][1];
    const activity = (pair.txns && pair.txns.m5) || {};
    const change = pair.priceChange || {}, volume = pair.volume || {};
    const marketCap = num(pair.marketCap), fdv = num(pair.fdv);
    const info = pair.info && typeof pair.info === 'object' ? pair.info : null;
    const links = info ? (Array.isArray(info.socials) && info.socials.length > 0) || (Array.isArray(info.websites) && info.websites.length > 0) : false;
    const canonical = chain === 'solana' ? address : address.toLowerCase();
    return {key: chain + ':' + canonical, chain, address: pair.baseToken.address, pair: pair.pairAddress,
      dexId: text(pair.dexId, 40), labels: Array.isArray(pair.labels) ? pair.labels.map(label => text(label, 20)).filter(Boolean).slice(0, 5) : [],
      symbol: text(pair.baseToken.symbol, 32) || 'Unknown', name: text(pair.baseToken.name, 80) || 'Unknown',
      price: num(pair.priceUsd), liquidity: num(pair.liquidity.usd),
      change5m: num(change.m5), change1h: num(change.h1), change24h: num(change.h24),
      volume5m: num(volume.m5), volume24h: num(volume.h24), buys5m: num(activity.buys), sells5m: num(activity.sells),
      marketCap, fdv, valuationUsd: marketCap > 0 ? marketCap : fdv > 0 ? fdv : null,
      valuationKind: marketCap > 0 ? 'market cap' : fdv > 0 ? 'fully diluted value' : null,
      createdAt: num(pair.pairCreatedAt), fetchedAt: now,
      hasSocials: pair.socialsUnknown ? null : links, imageUrl: safeImage(info && info.imageUrl),
      sourceUrl: 'https://dexscreener.com/' + chain + '/' + pair.pairAddress};
  }
  // EVM addresses look the same on every chain: use the chain with the deepest pool for this coin.
  function pickMarket(pairs, address, chain, now) {
    let candidates;
    if (chain) candidates = [chain];
    else if (validMint(address)) candidates = ['solana'];
    else {
      const ranked = [];
      for (const pair of Array.isArray(pairs) ? pairs : []) {
        if (pair && CHAINS[pair.chainId] && pair.baseToken && typeof pair.baseToken.address === 'string'
          && pair.baseToken.address.toLowerCase() === String(address).toLowerCase()) {
          const liquidity = num(pair.liquidity && pair.liquidity.usd);
          if (liquidity !== null) ranked.push([liquidity, pair.chainId]);
        }
      }
      candidates = ranked.sort((a, b) => b[0] - a[0]).map(row => row[1]);
    }
    for (const candidate of [...new Set(candidates)]) {
      const market = normalizeMarket(pairs, candidate, address, now);
      if (market) return market;
    }
    return null;
  }
  // GeckoTerminal pool lists, reshaped like DexScreener pairs (autopaper.py gecko_discovery_pairs).
  function geckoPairs(payload, chain) {
    const network = GECKO[chain], included = {}, out = [];
    for (const row of (payload && Array.isArray(payload.included)) ? payload.included : []) if (row && row.type === 'token') included[row.id] = row;
    for (const pool of (payload && Array.isArray(payload.data)) ? payload.data : []) {
      try {
        const a = pool.attributes, relation = pool.relationships.base_token.data, token = included[relation.id];
        if (!token || pool.type !== 'pool' || relation.type !== 'token') continue;
        const address = token.attributes.address, pairAddress = a.address;
        if (!addressOk(chain, address) || !poolIdOk(chain, pairAddress)) continue;
        const same = chain === 'solana' ? value => value : value => String(value).toLowerCase();
        if (same(token.id) !== same(network + '_' + address) || same(pool.id) !== same(network + '_' + pairAddress)) continue;
        const created = Date.parse(a.pool_created_at);
        if (!Number.isFinite(created) || !/(Z|[+-]\d\d:\d\d)$/.test(String(a.pool_created_at))) continue;
        const dex = pool.relationships.dex && pool.relationships.dex.data;
        out.push({chainId: chain, baseToken: {address, symbol: token.attributes.symbol, name: token.attributes.name},
          pairAddress, priceUsd: a.base_token_price_usd, liquidity: {usd: a.reserve_in_usd}, volume: a.volume_usd || {},
          priceChange: a.price_change_percentage || {}, txns: a.transactions || {}, marketCap: a.market_cap_usd, fdv: a.fdv_usd,
          pairCreatedAt: created, dexId: dex && dex.id, info: {imageUrl: token.attributes.image_url}, socialsUnknown: true});
      } catch (error) {
        continue;
      }
    }
    return out;
  }

  // GeckoTerminal names pools "<network>_<address>": the prefix tells the chain.
  function geckoChain(poolId) {
    const network = String(poolId || '').split('_')[0];
    return Object.keys(GECKO).find(chain => GECKO[chain] === network) || null;
  }
  // A coin's price from a GeckoTerminal pool, whichever side of the pool the coin is on.
  function poolPrice(pool, chain, address) {
    if (!pool || !pool.attributes || !pool.relationships) return null;
    const want = GECKO[chain] + '_' + address;
    const side = name => pool.relationships[name] && pool.relationships[name].data && pool.relationships[name].data.id;
    const same = id => typeof id === 'string' && (chain === 'solana' ? id === want : id.toLowerCase() === want.toLowerCase());
    const price = same(side('base_token')) ? num(pool.attributes.base_token_price_usd) : same(side('quote_token')) ? num(pool.attributes.quote_token_price_usd) : null;
    return price > 0 ? price : null;
  }

  // Contract scans --------------------------------------------------------------
  function riskUnavailable(label, sourceUrl) {
    return {status: 'unavailable', allowed: false, riskDetected: false, flags: [], label, providerSignals: {}, sourceUrl: sourceUrl || null};
  }
  function parseRugcheck(report, mint) {
    if (!report || typeof report !== 'object' || report.mint !== mint || !Array.isArray(report.risks)) {
      throw new Error("RugCheck didn't return a report for this exact coin.");
    }
    const flags = report.risks.slice(0, 30).filter(risk => risk && typeof risk === 'object').map(risk => ({
      name: text(risk.name, 160) || 'Risk', detail: text(risk.description, 300),
      level: risk.level === 'danger' ? 'danger' : 'warn'}));
    if (report.rugged === true) flags.unshift({name: 'RugCheck marked this coin as rugged', detail: '', level: 'danger'});
    const launches = Array.isArray(report.creatorTokens) ? report.creatorTokens.filter(token => token && validMint(token.mint)).length : 0;
    const danger = flags.some(flag => flag.level === 'danger');
    return {status: 'available', provider: 'RugCheck', allowed: flags.length === 0, riskDetected: danger, flags,
      label: flags.length ? 'RugCheck found ' + flags.length + ' risk' + (flags.length === 1 ? '' : 's') : 'RugCheck found no risks',
      providerSignals: {creatorLaunches: launches}, sourceUrl: 'https://rugcheck.xyz/tokens/' + mint};
  }
  function parseGoplus(payload, chain, address) {
    if (!payload || typeof payload !== 'object' || !payload.result || typeof payload.result !== 'object') {
      throw new Error("GoPlus didn't return a scan.");
    }
    const contract = payload.code === 1 ? (payload.result[address.toLowerCase()] || {}) : {};
    const flags = Object.entries(GOPLUS_FLAGS).filter(([field]) => contract[field] === '1')
      .map(([, name]) => ({name, detail: 'Reported by GoPlus', level: 'danger'}));
    if (Object.keys(contract).length && contract.is_open_source !== '1') {
      flags.push({name: "Contract code isn't public", detail: 'Nobody can check what it does', level: 'danger'});
    }
    const fake = contract.fake_token;
    if (fake && typeof fake === 'object' && String(fake.value) === '1') {
      flags.push({name: 'Fake copy of a known token', detail: 'Reported by GoPlus', level: 'danger'});
    }
    const taxes = [['buy_tax', 'Buy'], ['sell_tax', 'Sell']].map(([field, label]) => {
      const value = num(contract[field]);
      return value > 0 ? `${label} tax ${(value * 100).toFixed(0)}%` : null;
    }).filter(Boolean);
    if (taxes.length) flags.push({name: taxes.join(' · '), detail: 'Every trade loses this to the token', level: 'danger'});
    const allowed = contract.is_open_source === '1' && GOPLUS_REQUIRED.every(field => contract[field] === '0')
      && !flags.length && num(contract.buy_tax) === 0 && num(contract.sell_tax) === 0;
    const signals = {};
    for (const [field, output] of [['creator_percent', 'creatorPercent'], ['owner_percent', 'ownerPercent']]) {
      const share = num(contract[field]);
      if (share !== null && share >= 0 && share <= 1) signals[output] = share;
    }
    // Top-10 holder share, leaving out locked supply and contracts (pools, lockers).
    const people = (Array.isArray(contract.holders) ? contract.holders : [])
      .filter(holder => holder && typeof holder === 'object' && String(holder.is_locked) !== '1' && String(holder.is_contract) !== '1')
      .map(holder => num(holder.percent)).filter(share => share !== null && share >= 0 && share <= 1);
    if (people.length) signals.top10HolderShare = sum(people.sort((a, b) => b - a).slice(0, 10));
    return {status: 'available', provider: 'GoPlus', allowed, riskDetected: flags.length > 0, flags,
      label: allowed ? 'GoPlus found no red flags' : flags.length ? 'GoPlus found red flags' : "GoPlus left some checks blank",
      providerSignals: signals, sourceUrl: 'https://gopluslabs.io/token-security/' + EVM_IDS[chain] + '/' + address};
  }

  // Strategy and costs ----------------------------------------------------------
  function strategyConfig(preset, edits) {
    const base = (STRATEGIES[preset] || STRATEGIES.blitz).rules;
    const config = {...base};
    for (const [field, [, low, high]] of Object.entries(EDITS)) {
      const value = num(edits && edits[field]);
      if (value !== null && value >= low && value <= high) config[field] = field === 'trailingStopPct' && value === 0 ? null : value;
    }
    return config;
  }
  function rulesConfig(saved) {
    const rules = {};
    for (const [field, [fallback, low, high, , whole]] of Object.entries(RULES)) {
      const value = num(saved && saved[field]);
      rules[field] = value !== null && value >= low && value <= high && (!whole || Number.isInteger(value)) ? value : fallback;
    }
    return rules;
  }
  function gasFor(chain, rules) { return chain === 'solana' ? rules.solanaFeeUsd : GAS[chain] || 0.5; }
  // Round-trip cost of buying and selling, in % of the amount (autopaper.py round_trip_cost_pct).
  function costPct(chain, notional, liquidity, rules, strategy) {
    if (!(notional > 0)) return 100;
    const fee = rules.feePct / 100;
    const slip = rules.slippagePct / 100 + (strategy.impactMultiplier || 0) * notional / (liquidity > 0 ? liquidity : strategy.minLiquidity || 50000);
    const gas = gasFor(chain, rules);
    const cost = notional * (1 + fee) + gas;
    const proceeds = Math.max(0, notional / (1 + slip) * (1 - slip) * (1 - fee) - gas);
    return (1 - proceeds / cost) * 100;
  }

  // Guardrails (trade_session.py guard), counted in your local day.
  function dayKey(ms) { const d = new Date(ms); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); }
  function guard(trades, rules, now) {
    const day = dayKey(now);
    const todayOpened = trades.filter(row => dayKey(row.openedAt) === day);
    const closed = trades.filter(row => row.status === 'closed');
    const net = round2(sum(closed.filter(row => dayKey(row.closedAt) === day).map(row => row.pnlUsd)));
    let streak = 0, lastLoss = null;
    for (const row of closed.slice().sort((a, b) => b.closedAt - a.closedAt)) {
      if (row.pnlUsd < 0) { streak += 1; lastLoss = lastLoss || row.closedAt; } else break;
    }
    const openCount = trades.filter(row => row.status === 'open').length;
    const reasons = [];
    let cooldownUntil = null;
    const limit = rules.dailyLossLimitUsd;
    if (net <= -limit) reasons.push(`You hit your daily loss limit (${money(-limit)}). Done for today; tomorrow is a fresh start.`);
    if (todayOpened.length >= rules.maxTradesPerDay) reasons.push(`You've used all ${rules.maxTradesPerDay} trades for today.`);
    if (openCount >= rules.maxOpen) reasons.push(`You already have ${openCount} open trade${openCount !== 1 ? 's' : ''}. Close one first.`);
    if (streak >= rules.cooldownAfterLosses && lastLoss && rules.cooldownMinutes) {
      const until = lastLoss + rules.cooldownMinutes * 60000;
      if (now < until) {
        cooldownUntil = until;
        reasons.push(`${streak} losses in a row. Take a break for ${Math.floor((until - now) / 60000) + 1} more minutes so you don't revenge trade.`);
      }
    }
    const status = !reasons.length ? 'ready' : cooldownUntil && reasons.length === 1 ? 'cooldown' : 'stop';
    return {status, reasons, todayNetUsd: net, tradesToday: todayOpened.length, tradesLeft: Math.max(0, rules.maxTradesPerDay - todayOpened.length),
      lossLeftUsd: Math.max(0, round2(limit + net)), openCount, lossStreak: streak, cooldownUntil};
  }

  // Step 3: the plan. Size comes from your risk rules; exits from your strategy.
  function planFor(market, rules, strategy, guardState) {
    const tp = strategy.takeProfitPct, sl = strategy.stopLossPct, net = strategy.profitBasis === 'net';
    const cap = rules.bankrollUsd * rules.maxTradePct / 100;
    let risk = rules.bankrollUsd * rules.riskPct / 100;
    if (guardState) risk = Math.min(risk, guardState.lossLeftUsd);
    let size = cap, cost = costPct(market.chain, cap, market.liquidity, rules, strategy), stopPct = sl, targetPct = tp;
    for (let round = 0; round < 4; round++) {
      stopPct = net ? Math.max(sl - cost, 0.5) : sl;
      targetPct = net ? tp + cost : tp;
      size = Math.max(0, Math.min(risk / ((stopPct + cost) / 100), cap));
      if (size > 0) cost = costPct(market.chain, size, market.liquidity, rules, strategy);
    }
    stopPct = net ? Math.max(sl - cost, 0.5) : sl;
    targetPct = net ? tp + cost : tp;
    if (size * (stopPct + cost) / 100 > risk) size = risk / ((stopPct + cost) / 100);
    size = Math.floor(Math.max(0, size) * 100) / 100;
    const price = market.price;
    const winUsd = round2(size * (targetPct - cost) / 100), lossUsd = round2(size * (stopPct + cost) / 100);
    const breakeven = winUsd > 0 ? Math.round(lossUsd / (winUsd + lossUsd) * 100) : 100;
    const plan = {sizeUsd: size, entry: price, targetPct: round2(targetPct), stopPct: round2(stopPct), trailingPct: strategy.trailingStopPct || null,
      holdMinutes: strategy.maxHoldMinutes, costPct: round2(cost), targetPrice: price * (1 + targetPct / 100), stopPrice: price * (1 - stopPct / 100),
      winUsd, lossUsd, breakevenPct: breakeven, riskUsd: round2(risk), capUsd: round2(cap)};
    if (size < 1) {
      plan.text = guardState && guardState.status !== 'ready' ? 'Your guardrails say no new trades right now.' : 'Your rules leave no room for this trade.';
      plan.odds = '';
      return plan;
    }
    plan.text = `Buy ${usd(size)} near ${priceText(price)}. Sell at ${priceText(plan.targetPrice)} (+${pct(targetPct)}${net ? `, +${pct(tp)} after fees` : ''}) `
      + `or cut at ${priceText(plan.stopPrice)} (−${pct(stopPct)}), and get out after ${strategy.maxHoldMinutes} minutes either way.`;
    if (plan.trailingPct) plan.text += ` Trailing stop: after a +${pct(plan.trailingPct)} run, sell if it falls ${pct(plan.trailingPct)} from its best price.`;
    plan.odds = winUsd > 0
      ? `A win makes about +${usd(winUsd)}, a loss costs about −${usd(lossUsd)} after fees. You need to win more than ${breakeven}% of trades like this to come out ahead. In a crash the price can skip past your stop.`
      : "After fees this target can't make money. Raise the target or trade a coin with lower costs.";
    return plan;
  }

  // Step 2: the check (coach.py grade) ---------------------------------------------
  function grade(market, risk, strategy, ctx) {
    const now = ctx.now, config = strategy;
    risk = risk || riskUnavailable('not checked');
    const signals = risk.providerSignals || {}, flags = risk.flags || [];
    const groups = {'Scam checks': [], 'Developer & holders': [], 'Money in the pool': [], 'Chart & trading': [], 'Fit & costs': []};
    const add = (group, label, status, detail, hard) => groups[group].push({label, status, detail, hard: Boolean(hard) && status === 'fail'});

    // Scam checks
    if (risk.status === 'available' && risk.riskDetected) {
      const danger = flags.filter(flag => flag.level === 'danger');
      add('Scam checks', 'Contract scan', 'fail', 'Red flags: ' + danger.slice(0, 5).map(flag => flag.name).join('; ') + '.', true);
    } else if (risk.status === 'available' && flags.length) {
      add('Scam checks', 'Contract scan', 'fail', 'Warnings: ' + flags.slice(0, 5).map(flag => flag.name).join('; ')
        + '. Not proof of a scam, but your rules want a clean scan.');
    } else if (risk.status === 'available' && risk.allowed) {
      add('Scam checks', 'Contract scan', 'pass', `No red flags in the ${risk.provider} scan. That's not a guarantee.`);
    } else if (risk.status !== 'skipped') {
      add('Scam checks', 'Contract scan', 'unknown', `The contract couldn't be fully checked (${risk.label || 'scanner unavailable'}). Treat it as risky.`);
    }
    if ((market.labels || []).some(label => /v4/i.test(label))) {
      add('Scam checks', 'Pool add-on code', 'warn', 'This is a Uniswap v4 pool. These can run add-on code (a "hook") that changes fees or selling, and its owner may be able to swap that code. Scout can\'t check it.');
    }
    const mine = (ctx.trades || []).filter(row => row.chain === market.chain && sameAddress(row.address, market.address, market.chain));
    const recentLoss = mine.find(row => row.status === 'closed' && row.pnlUsd < 0 && now - row.closedAt < 86400000);
    if (mine.some(row => row.status === 'open')) {
      add('Scam checks', 'Your journal', 'warn', 'You already have an open trade on this coin. Buying more doubles your risk.');
    } else if (recentLoss) {
      add('Scam checks', 'Your journal', 'warn', `You lost ${usd(Math.abs(recentLoss.pnlUsd))} on this coin in the last 24 hours. Buying it right back is often revenge trading.`);
    }

    // Developer & holders
    const share = field => { const value = num(signals[field]); return value !== null && value >= 0 && value <= 1 ? value * 100 : null; };
    const shares = [share('creatorPercent'), share('ownerPercent')].filter(value => value !== null);
    const creator = shares.length ? Math.max(...shares) : null;
    if (creator === null) {
      if (risk.status !== 'skipped') add('Developer & holders', "Developer's share", 'unknown', "Couldn't see how much the developer holds.");
    } else if (config.maxCreatorPct !== null) {
      const over = creator > config.maxCreatorPct;
      add('Developer & holders', "Developer's share", over ? 'fail' : 'pass',
        `The developer holds ${pct(creator)} (your limit ${config.maxCreatorPct}%).` + (over ? ' They could dump on buyers.' : ''), true);
    } else {
      add('Developer & holders', "Developer's share", 'info', `The developer holds ${pct(creator)}.`);
    }
    const launches = signals.creatorLaunches;
    if (Number.isInteger(launches)) {
      if (config.maxCreatorLaunches !== null) {
        const over = launches > config.maxCreatorLaunches;
        add('Developer & holders', "Developer's other coins", over ? 'fail' : 'pass',
          `The developer launched ${launches} other coin${launches !== 1 ? 's' : ''} (your limit ${config.maxCreatorLaunches}).` + (over ? ' Serial launchers often rug.' : ''), true);
      } else {
        add('Developer & holders', "Developer's other coins", 'info', `The developer launched ${launches} other coins.`);
      }
    }
    const top10 = share('top10HolderShare');
    if (top10 !== null) {
      if (config.maxTop10HolderPct !== null) {
        const over = top10 > config.maxTop10HolderPct;
        add('Developer & holders', 'Top 10 holders', over ? 'fail' : 'pass',
          `The top 10 wallets own ${pct(top10)}, not counting pools and locked coins (your limit ${config.maxTop10HolderPct}%).` + (over ? ' A few wallets could crash the price.' : ''), true);
      } else {
        add('Developer & holders', 'Top 10 holders', 'info', `The top 10 wallets own ${pct(top10)}.`);
      }
    } else if (market.chain === 'solana' && risk.status === 'available') {
      add('Developer & holders', 'Top 10 holders', 'info', 'Holder concentration is covered by the RugCheck scan above.');
    }

    // Money in the pool
    const liquidity = market.liquidity, volume = market.volume5m || 0;
    add('Money in the pool', 'Liquidity', liquidity >= config.minLiquidity ? 'pass' : 'fail',
      `${usd(liquidity)} in the pool (you want at least ${usd(config.minLiquidity)}). Less money means bigger price jumps and easier rugs.`);
    add('Money in the pool', '5-minute volume', volume >= config.minVolume5m ? 'pass' : 'fail',
      `${usd(volume)} traded in the last 5 minutes (you want ${usd(config.minVolume5m)}).` + (volume < config.minVolume5m ? ' Quiet coins are hard to sell fast.' : ''));
    const valuation = market.valuationUsd;
    if (config.minValuationUsd !== null) {
      if (valuation === null || valuation === undefined) {
        add('Money in the pool', 'Market cap', 'fail', "No market cap available, so the size rule can't be checked.");
      } else {
        const inside = config.minValuationUsd <= valuation && valuation <= config.maxValuationUsd;
        add('Money in the pool', 'Market cap', inside ? 'pass' : 'fail',
          `Market cap ${usd(valuation)} (your range ${usd(config.minValuationUsd)} to ${usd(config.maxValuationUsd)}).`);
        const ratio = liquidity / valuation * 100, floor = config.minLiquidityToValuationPct || 0;
        add('Money in the pool', 'Pool vs market cap', ratio >= floor ? 'pass' : 'fail',
          `The pool holds ${pct(ratio)} of the market cap (you want ${floor}%).` + (ratio < floor ? " A thin pool can't absorb sellers." : ''));
      }
    } else if (valuation !== null && valuation !== undefined) {
      add('Money in the pool', 'Market cap', 'info', `Market cap ${usd(valuation)}.`);
    }

    // Chart & trading
    if (market.createdAt) {
      const age = (now - market.createdAt) / 60000;
      const fits = config.minAgeSeconds / 60 <= age && age <= config.maxAgeSeconds / 60;
      add('Chart & trading', 'Coin age', fits ? 'pass' : 'fail',
        `The pool is ${duration(age * 60)} old (you want ${duration(config.minAgeSeconds)} to ${duration(config.maxAgeSeconds)}).`
        + (age < config.minAgeSeconds / 60 ? ' The first minutes are sniper chaos.' : ''));
    } else {
      add('Chart & trading', 'Coin age', 'unknown', "The pool's age isn't available.");
    }
    const change5m = market.change5m, change1h = market.change1h;
    if (config.momentumGate && change5m !== null && change5m !== undefined) {
      const low = config.minChange5m, high = config.maxChange5m;
      add('Chart & trading', 'Last 5 minutes', low <= change5m && change5m <= high ? 'pass' : 'fail',
        `Price moved ${change5m >= 0 ? '+' : ''}${change5m.toFixed(1)}% in 5 minutes (you want ${low}% to ${high}%).`
        + (change5m > high ? " That's a vertical pump; buyers late to pumps get dumped on." : change5m < low ? " It's falling right now." : ''));
    }
    if (change1h !== null && change1h !== undefined) {
      const rising = config.requireRisingHour && config.momentumGate, floor = config.minChange1h;
      const bad = (rising && !(change1h > 0 && change1h <= 150)) || (floor !== null && change1h < floor);
      add('Chart & trading', 'Last hour', bad ? 'fail' : 'pass', `Price moved ${change1h >= 0 ? '+' : ''}${change1h.toFixed(1)}% in the last hour.`
        + (floor !== null && change1h < floor ? ' That looks like a recent dump.' : rising && change1h <= 0 ? ' Your strategy wants a rising hour.'
          : rising && change1h > 150 ? ' It already pumped hard; late buyers often get dumped on.' : ''));
    }
    if (market.buys5m !== null && market.buys5m !== undefined && market.sells5m !== null && market.sells5m !== undefined) {
      const buys = market.buys5m, sells = market.sells5m, total = buys + sells;
      add('Chart & trading', 'Trades in 5 minutes', total >= config.minTransactions5m ? 'pass' : 'fail',
        `${buys.toFixed(0)} buys and ${sells.toFixed(0)} sells (you want at least ${config.minTransactions5m} trade${config.minTransactions5m !== 1 ? 's' : ''}).`);
      if (total > 0) {
        const buyShare = buys / total;
        if (sells < config.minSells5m || buyShare > config.maxBuyShare) {
          add('Chart & trading', 'Buyers vs sellers', 'fail', `${(buyShare * 100).toFixed(0)}% buys and almost nobody selling. That can mean people can't sell (honeypot) or bots are pumping it.`, true);
        } else {
          add('Chart & trading', 'Buyers vs sellers', buyShare >= config.minBuyShare ? 'pass' : 'fail',
            `${(buyShare * 100).toFixed(0)}% of trades are buys (you want at least ${(config.minBuyShare * 100).toFixed(0)}%).`);
        }
      }
    } else {
      add('Chart & trading', 'Trades in 5 minutes', 'unknown', "Buy and sell counts aren't available.");
    }

    // Fit & costs
    if (config.allowedChains) {
      const fits = config.allowedChains.includes(market.chain);
      add('Fit & costs', 'Chain', fits ? 'pass' : 'fail', CHAINS[market.chain] + (fits ? " is one of your strategy's chains." : " isn't one of your strategy's chains."));
    }
    if (config.requireSocials) {
      if (market.hasSocials === null || market.hasSocials === undefined) {
        add('Fit & costs', 'Website or socials', 'unknown', 'Links not loaded yet. The full check looks them up.');
      } else {
        add('Fit & costs', 'Website or socials', market.hasSocials ? 'pass' : 'fail',
          market.hasSocials ? 'Website or social links are listed.' : 'No website or social links. Real projects usually have them.');
      }
    }
    if (config.qualityChecks) {
      add('Fit & costs', 'Steady rise', 'info', `Your strategy also waits for the price to rise across ${config.confirmationSamples} checks over `
        + `${config.confirmationSeconds} seconds before buying. Watch the chart for a few seconds first; don't buy into a sudden spike.`);
    }
    const limit = config.maxRoundTripCostPct;
    add('Fit & costs', 'Fees to buy and sell', limit === null || ctx.costPct <= limit ? 'pass' : 'fail',
      `Buying and selling ${usd(ctx.sizeUsd)} costs about ${pct(ctx.costPct)} in fees, slippage and network fees.` + (limit !== null ? ` Your limit is ${limit}%.` : ''));

    const items = Object.values(groups).flat();
    const hard = items.filter(item => item.hard), failed = items.filter(item => item.status === 'fail');
    const unknown = items.some(item => item.status === 'unknown' && item.label === 'Contract scan');
    let verdict;
    if (hard.length) {
      verdict = {code: 'skip', title: 'Skip it', summary: 'Red flags: ' + hard.map(item => item.label.toLowerCase()).join('; ') + '.'};
    } else if (failed.length) {
      verdict = {code: 'rules', title: "Doesn't fit your rules", summary: `${failed.length} rule${failed.length !== 1 ? 's' : ''} not met: ` + failed.map(item => item.label.toLowerCase()).join('; ') + '.'};
    } else if (unknown) {
      verdict = {code: 'caution', title: 'Fits your rules, but be careful', summary: "The contract couldn't be fully checked, so nobody can say it's sellable."};
    } else {
      verdict = {code: 'pass', title: 'Fits your rules', summary: "No rule failed. That improves your odds; it doesn't make it safe. Only use money you can lose."};
    }
    const closes = mine.filter(row => row.status === 'closed');
    let memory = null;
    if (closes.length) {
      const total = round2(sum(closes.map(row => row.pnlUsd)));
      memory = `You traded this coin ${closes.length} time${closes.length !== 1 ? 's' : ''}: ${signedUsd(total)} net.`;
    }
    return {address: market.address, chain: market.chain, chainLabel: CHAINS[market.chain], symbol: market.symbol, name: market.name,
      price: market.price, chartUrl: market.sourceUrl, checkedAt: now, verdict, memory, contractUrl: risk.sourceUrl || null,
      groups: Object.entries(groups).filter(([, rows]) => rows.length).map(([name, rows]) => ({name, items: rows})),
      counts: {total: items.length, passed: items.filter(item => item.status === 'pass').length, failed: failed.length,
        notes: items.filter(item => !['pass', 'fail'].includes(item.status)).length}};
  }

  // Steps 4-7: your trades (trade_session.py) ------------------------------------
  function buyBreaks(body, trades, rules, now) {
    const guardState = guard(trades, rules, now), breaks = [];
    if (body.verdict === 'skip') breaks.push('Bought a coin the coach said to skip');
    if (guardState.status !== 'ready') breaks.push('Traded while your guardrails said stop: ' + guardState.reasons[0]);
    const biggest = rules.bankrollUsd * rules.maxTradePct / 100, size = num(body.sizeUsd);
    if (size !== null && size > biggest * 1.01) breaks.push(`Bought ${usd(size)}, more than your max size of ${usd(biggest)}`);
    return breaks;
  }
  function openTrade(body, trades, rules, now, id) {
    if (!body || typeof body !== 'object') throw new Error('Trade details are missing.');
    if (!CHAINS[body.chain] || !addressOk(body.chain, body.address)) throw new Error('Check the coin again before logging the buy.');
    const symbol = String(body.symbol || 'COIN').replace(/[^\w$.\- ]/g, '').slice(0, 24) || 'COIN';
    const entry = bounded(body.entryPrice, 'Your buy price', 1e-12, 1e7);
    const size = bounded(body.sizeUsd, 'Amount you bought ($)', 1, 1e7);
    const stop = bounded(body.stopPct, 'Stop %', 0.5, 95);
    const target = bounded(body.targetPct, 'Target %', 0.5, 10000);
    const trailRaw = num(body.trailingPct);
    const trail = trailRaw === null || trailRaw === 0 ? null : bounded(trailRaw, 'Trailing stop %', 0, 50);
    const hold = bounded(body.holdMinutes, 'Time limit (minutes)', 1, 10080, true);
    const cost = bounded(body.costPct === undefined || body.costPct === null ? DEFAULT_COST_PCT : body.costPct, 'Fees %', 0, 50);
    const verdict = String(body.verdict || 'unknown').slice(0, 12);
    const override = String(body.overrideReason || '').trim().slice(0, 300);
    const breaks = buyBreaks({...body, sizeUsd: size}, trades, rules, now);
    if (breaks.length && override.length < 3) {
      throw new Error('This trade breaks your rules (' + breaks[0].toLowerCase() + "). If you're doing it anyway, write why; it goes in your journal.");
    }
    return {id, status: 'open', chain: body.chain, address: body.address, pair: poolIdOk(body.chain, body.pair) ? body.pair : null, symbol,
      name: text(body.name, 80), openedAt: now, entryPrice: entry, sizeUsd: size, stopPct: stop, targetPct: target, trailingPct: trail,
      holdMinutes: hold, costPct: cost, verdict, ruleBreaks: breaks, overrideReason: override || null, mark: entry, markAt: now, peak: entry,
      signal: 'hold', firstSellAt: null, firstSell: null, samples: [[now, entry]]};
  }
  function signal(trade, price, now) {
    const entry = trade.entryPrice, peak = trade.peak;
    if (price <= entry * (1 - trade.stopPct / 100)) return 'stop';
    const trail = trade.trailingPct;
    if (trail && peak >= entry * (1 + trail / 100) && price <= peak * (1 - trail / 100)) return 'trail';
    if (price >= entry * (1 + trade.targetPct / 100)) return 'target';
    if (now - trade.openedAt >= trade.holdMinutes * 60000) return 'time';
    return 'hold';
  }
  // A new live price. Returns the signal when it just changed to a sell signal.
  function mark(trade, price, now) {
    trade.mark = price;
    trade.markAt = now;
    trade.peak = Math.max(trade.peak, price);
    trade.samples = (trade.samples || []).concat([[now, price]]).slice(-400);
    const next = signal(trade, price, now);
    if (next === trade.signal) return null;
    trade.signal = next;
    if (next === 'hold') return null;
    if (!trade.firstSellAt) { trade.firstSellAt = now; trade.firstSell = next; }
    return next;
  }
  // While the iPad paused Scout, the price may have crossed your stop. Candles fill the gap: [[ms, open, high, low, close], ...]
  function catchUp(trade, candles) {
    const since = trade.markAt;
    const rows = (Array.isArray(candles) ? candles : []).filter(row => Array.isArray(row) && row[0] + 60000 > since && row[2] > 0 && row[3] > 0)
      .sort((a, b) => a[0] - b[0]);
    if (!rows.length) return null;
    const entry = trade.entryPrice, stopPrice = entry * (1 - trade.stopPct / 100);
    let missed = null;
    for (const [at, , high, low] of rows) {
      // Inside one candle the order of high and low is unknown, so the trail uses the best price before it.
      const trail = trade.trailingPct;
      const trailHit = trail && trade.peak >= entry * (1 + trail / 100) && low <= trade.peak * (1 - trail / 100);
      if (!missed && (low <= stopPrice || trailHit)) missed = {kind: low <= stopPrice ? 'stop' : 'trail', at: Math.max(at, since), low};
      trade.peak = Math.max(trade.peak, high);
    }
    if (missed && !trade.firstSellAt) { trade.firstSellAt = missed.at; trade.firstSell = missed.kind; }
    if (missed) trade.missed = missed;
    return missed;
  }
  function closeTrade(trade, body, now) {
    if (!trade || trade.status !== 'open') throw new Error("That trade isn't open anymore.");
    const feeling = body.feeling || null;
    if (feeling && !FEELINGS.includes(feeling)) throw new Error('Pick how you felt from the list.');
    const exit = bounded(body.exitPrice, 'Your sell price', 0, 1e7);
    const note = String(body.note || '').trim().slice(0, 500);
    const entry = trade.entryPrice, size = trade.sizeUsd, cost = trade.costPct;
    const pnl = round2(size * (exit / entry - 1) - size * cost / 100);
    const breaks = trade.ruleBreaks.slice(), lessons = [];
    const stopPrice = entry * (1 - trade.stopPct / 100);
    if (['stop', 'trail', 'time'].includes(trade.firstSell) && now - trade.firstSellAt > 120000) {
      const minutes = Math.floor((now - trade.firstSellAt) / 60000);
      breaks.push(`Held ${minutes} min past your ${trade.firstSell === 'stop' ? 'stop' : trade.firstSell === 'trail' ? 'trailing stop' : 'time limit'}`);
    }
    if (exit < stopPrice * 0.97 && trade.firstSell !== 'stop') lessons.push('It fell through your stop before you sold. Next time sell the moment Scout says SELL NOW.');
    if (!trade.firstSell && pnl < 0 && exit > stopPrice) lessons.push("You sold before your stop. If you didn't trust the plan, the size was probably too big.");
    if (!trade.firstSell && pnl > 0) lessons.push("You took profit before the target. Fine sometimes; if it's every time, set a smaller target.");
    if (['fomo', 'revenge', 'greedy'].includes(feeling)) lessons.push(`You felt ${feeling === 'fomo' ? 'FOMO' : feeling}. Those trades are worth watching in your journal.`);
    Object.assign(trade, {status: 'closed', closedAt: now, exitPrice: exit, pnlUsd: pnl, feeling, note: note || null,
      exitReason: trade.signal !== 'hold' ? trade.signal : 'manual', ruleBreaks: breaks, followedPlan: !breaks.length, lessons});
    return trade;
  }
  function liveView(trade, now) {
    const entry = trade.entryPrice, size = trade.sizeUsd, trail = trade.trailingPct;
    const trailActive = trail && trade.peak >= entry * (1 + trail / 100);
    return {changePct: (trade.mark / entry - 1) * 100, pnlUsd: round2(size * (trade.mark / entry - 1) - size * trade.costPct / 100),
      stopPrice: entry * (1 - trade.stopPct / 100), targetPrice: entry * (1 + trade.targetPct / 100),
      trailPrice: trailActive ? trade.peak * (1 - trail / 100) : null, trailStartPrice: trail ? entry * (1 + trail / 100) : null,
      secondsLeft: Math.max(0, Math.floor((trade.openedAt + trade.holdMinutes * 60000 - now) / 1000)),
      signalText: SIGNALS[trade.signal], stale: now - trade.markAt > 60000};
  }

  // Journal ------------------------------------------------------------------------
  function stats(rows) {
    const closed = rows.filter(row => row.status === 'closed');
    if (!closed.length) return {closes: 0};
    const pnls = closed.map(row => row.pnlUsd);
    const wins = pnls.filter(value => value > 0), losses = pnls.filter(value => value <= 0);
    const followed = closed.filter(row => row.followedPlan), broke = closed.filter(row => !row.followedPlan);
    const total = group => round2(sum(group.map(row => row.pnlUsd)));
    const bucket = key => {
      const out = {};
      for (const row of closed) {
        const name = row[key] || (key === 'feeling' ? 'not logged' : 'unknown');
        out[name] = out[name] || {closes: 0, netUsd: 0};
        out[name].closes += 1;
        out[name].netUsd = round2(out[name].netUsd + row.pnlUsd);
      }
      return out;
    };
    const best = closed.reduce((a, b) => (b.pnlUsd > a.pnlUsd ? b : a)), worst = closed.reduce((a, b) => (b.pnlUsd < a.pnlUsd ? b : a));
    return {closes: closed.length, netUsd: total(closed), wins: wins.length, losses: losses.length,
      winRatePct: Math.round(wins.length * 100 / closed.length), averageWinUsd: wins.length ? round2(sum(wins) / wins.length) : null,
      averageLossUsd: losses.length ? round2(sum(losses) / losses.length) : null, followedPct: Math.round(followed.length * 100 / closed.length),
      followedNetUsd: total(followed), brokeNetUsd: total(broke), followedCloses: followed.length, brokeCloses: broke.length,
      byVerdict: bucket('verdict'), byFeeling: bucket('feeling'), best: best.symbol, worst: worst.symbol};
  }
  const TIPS = [['Bought a coin the coach said to skip', 'Respect Skip it. Close the chart and find the next coin.'],
    ['Held N min past your', 'Sell the moment Scout says SELL NOW. Hoping is not a plan.'],
    ['Traded while your guardrails said stop', 'When your limit hits, close Axiom for the day.'],
    ['Bought $', 'Keep every buy at or under your max size. Big size makes it hard to follow the plan.']];
  function review(trades, now) {
    const day = dayKey(now);
    const today = trades.filter(row => row.status === 'closed' && dayKey(row.closedAt) === day);
    if (!today.length) return {closes: 0, text: 'No finished trades today yet.'};
    const summary = stats(today);
    const breaks = today.flatMap(row => row.ruleBreaks || []);
    const well = [];
    if (summary.followedPct === 100) well.push('You followed your plan on every trade.');
    if (today.some(row => row.exitReason === 'stop' && row.followedPlan)) well.push("You took a stop when it hit. That's what keeps an account alive.");
    if (summary.wins) well.push(`${summary.wins} winning trade${summary.wins !== 1 ? 's' : ''}.`);
    const counts = {};
    for (const item of breaks) {
      const kind = item.split(':')[0].replace(/\d+/g, 'N');
      counts[kind] = (counts[kind] || 0) + 1;
    }
    const fix = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || null;
    const tip = fix && TIPS.find(([prefix]) => fix.startsWith(prefix));
    const tomorrow = tip ? tip[1] : fix ? `Avoid this: ${fix.toLowerCase()}.`
      : summary.netUsd >= 0 ? 'Keep doing exactly this. Consistency beats one big win.'
        : 'Your rules were followed, so the losses are the cost of trading. Make sure your coin checks pass before buying.';
    return {closes: today.length, netUsd: summary.netUsd, wins: summary.wins, losses: summary.losses, well, ruleBreaks: breaks, tomorrow};
  }

  return {CHAINS, GECKO, EVM_IDS, EXPLORERS, EVM_RE, STRATEGIES, EDITS, RULES, FEELINGS, SIGNALS, DEFAULT_COST_PCT,
    num, text, round2, plain, pct, signedPct, usd, money, signedUsd, compactUsd, priceText, duration, shortAge, clock, bounded,
    validMint, addressOk, poolIdOk, sameAddress, findAddress, safeImage, axiomUrl,
    normalizeMarket, pickMarket, geckoPairs, geckoChain, poolPrice, riskUnavailable, parseRugcheck, parseGoplus,
    strategyConfig, rulesConfig, costPct, dayKey, guard, planFor, grade,
    buyBreaks, openTrade, signal, mark, catchUp, closeTrade, liveView, stats, review};
});
