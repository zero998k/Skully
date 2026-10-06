/* Scout for iPad · public market data, read straight from the iPad.
   DexScreener (prices and pools), RugCheck (Solana contract scan), GoPlus (other chains)
   and GeckoTerminal (trending lists and candles). Read-only: nothing here can trade. */
(function (root) {
  'use strict';
  const C = root.ScoutCore;

  class DataError extends Error {
    constructor(kind, message) { super(message); this.kind = kind; }
  }
  function host(url) { try { return new URL(url).hostname.replace(/^api\./, ''); } catch (error) { return 'the data source'; } }

  async function getJson(url, timeout) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout || 12000);
    try {
      const response = await fetch(url, {signal: controller.signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer'});
      if (response.status === 429) throw new DataError('busy', host(url) + ' is busy. Wait a few seconds and try again.');
      if (!response.ok) throw new DataError('http', host(url) + ' answered with error ' + response.status + '.');
      return await response.json();
    } catch (error) {
      if (error instanceof DataError) throw error;
      if (error && error.name === 'AbortError') throw new DataError('timeout', host(url) + ' took too long to answer.');
      throw new DataError('network', "Couldn't reach " + host(url) + '. Check your internet connection.');
    } finally {
      clearTimeout(timer);
    }
  }

  // Step 1: find the coin's busiest pool from a pasted CA or link.
  // DexScreener first; GeckoTerminal is the backup if DexScreener can't be reached or doesn't know the coin.
  async function market(input) {
    const address = C.findAddress(input);
    if (!C.validMint(address) && !C.EVM_RE.test(address)) {
      throw new DataError('input', "Paste the coin's contract address (CA). Names and tickers can be faked.");
    }
    let dexError = null, geckoError = null;
    try {
      const found = await dexMarket(address);
      if (found) return found;
    } catch (error) {
      dexError = error;
    }
    try {
      const backup = await geckoMarket(address);
      if (backup) return backup;
    } catch (error) {
      geckoError = error;
    }
    if (dexError && geckoError) throw dexError;
    throw new DataError('none', 'No trading pool found for this coin on Solana, BNB, Ethereum, Base, Arbitrum or Robinhood Chain.');
  }
  async function dexMarket(address) {
    const payload = await getJson('https://api.dexscreener.com/latest/dex/tokens/' + address);
    const found = C.pickMarket(payload && payload.pairs, address, null, Date.now());
    if (found) return found;
    // Axiom and DexScreener links carry the pool address, not the coin's: look the pool up.
    const search = await getJson('https://api.dexscreener.com/latest/dex/search?q=' + encodeURIComponent(address));
    const pool = ((search && search.pairs) || []).find(pair => pair && C.CHAINS[pair.chainId] && C.sameAddress(pair.pairAddress, address, pair.chainId));
    if (pool && pool.baseToken && C.addressOk(pool.chainId, pool.baseToken.address)) {
      const again = await getJson('https://api.dexscreener.com/latest/dex/tokens/' + pool.baseToken.address);
      return C.pickMarket(again && again.pairs, pool.baseToken.address, pool.chainId, Date.now());
    }
    return null;
  }
  async function geckoMarket(address) {
    const payload = await getJson('https://api.geckoterminal.com/api/v2/search/pools?query=' + encodeURIComponent(address) + '&include=base_token');
    const byChain = {};
    for (const pool of (payload && Array.isArray(payload.data)) ? payload.data : []) {
      const chain = C.geckoChain(pool && pool.id);
      if (chain) (byChain[chain] = byChain[chain] || []).push(pool);
    }
    const pairs = Object.entries(byChain).flatMap(([chain, data]) => C.geckoPairs({data, included: payload.included}, chain));
    const direct = C.pickMarket(pairs, address, null, Date.now());
    if (direct) return direct;
    // A pool address was pasted: use that pool's coin.
    const pool = pairs.find(pair => C.sameAddress(pair.pairAddress, address, pair.chainId));
    return pool ? C.pickMarket(pairs, pool.baseToken.address, pool.chainId, Date.now()) : null;
  }

  // Step 2: the contract scan. A failed scan is reported as unknown, never as safe.
  async function risk(chain, address) {
    try {
      if (chain === 'solana') {
        return C.parseRugcheck(await getJson('https://api.rugcheck.xyz/v1/tokens/' + address + '/report', 20000), address);
      }
      const id = C.EVM_IDS[chain];
      return C.parseGoplus(await getJson('https://api.gopluslabs.io/api/v1/token_security/' + id + '?contract_addresses=' + address, 20000), chain, address);
    } catch (error) {
      const page = chain === 'solana' ? 'https://rugcheck.xyz/tokens/' + address : 'https://gopluslabs.io/token-security/' + C.EVM_IDS[chain] + '/' + address;
      return C.riskUnavailable(error.message.replace(/\.$/, ''), page);
    }
  }

  // Discover: DexScreener's newest token pages, community takeovers and boosts mark coins with fresh attention.
  function cleanLinks(row) {
    const links = [];
    for (const item of [].concat(row && Array.isArray(row.links) ? row.links : [])) {
      const url = item && typeof item.url === 'string' && item.url.startsWith('https://') && item.url.length < 300 ? item.url : null;
      if (url) links.push({label: C.text(item.label || item.type || 'Link', 30) || 'Link', url});
    }
    return links.slice(0, 6);
  }
  async function listings(chain) {
    const urls = {profile: 'https://api.dexscreener.com/token-profiles/latest/v1', cto: 'https://api.dexscreener.com/community-takeovers/latest/v1',
      boost: 'https://api.dexscreener.com/token-boosts/latest/v1'};
    const tags = {};
    let reached = 0;
    await Promise.all(Object.entries(urls).map(async ([kind, url]) => {
      let rows;
      try { rows = await getJson(url, 10000); reached += 1; } catch (error) { return; }
      for (const row of Array.isArray(rows) ? rows : rows ? [rows] : []) {
        if (!row || row.chainId !== chain || !C.addressOk(chain, row.tokenAddress)) continue;
        const tag = tags[row.tokenAddress] = tags[row.tokenAddress] || {};
        if (kind === 'boost') tag.boost = Math.max(tag.boost || 0, C.num(row.totalAmount) || C.num(row.amount) || 0);
        else tag[kind] = true;
        if (!tag.description && row.description) tag.description = C.text(row.description, 280);
        const links = cleanLinks(row);
        if (links.length && !(tag.links && tag.links.length)) tag.links = links;
        if (!tag.imageUrl) tag.imageUrl = C.safeImage(row.icon);
      }
    }));
    if (!reached) throw new DataError('network', "Couldn't reach dexscreener.com.");
    return tags;
  }
  async function geckoList(chain, list, page) {
    const payload = await getJson('https://api.geckoterminal.com/api/v2/networks/' + C.GECKO[chain] + '/' + list + '?include=base_token&page=' + page, 12000);
    const now = Date.now();
    return C.geckoPairs(payload, chain).map(pair => C.normalizeMarket([pair], chain, pair.baseToken.address, now)).filter(Boolean);
  }
  // Fresh DexScreener readings for many coins at once (30 per request).
  async function markets(chain, addresses) {
    const out = {}, list = [...new Set(addresses)].slice(0, 300);
    const batches = [];
    for (let i = 0; i < list.length; i += 30) batches.push(list.slice(i, i + 30));
    let lastError = null, reached = 0;
    await Promise.all(batches.map(async batch => {
      try {
        const pairs = await getJson('https://api.dexscreener.com/tokens/v1/' + chain + '/' + batch.join(','), 12000);
        reached += 1;
        const now = Date.now();
        for (const address of batch) {
          const found = C.normalizeMarket(pairs, chain, address, now);
          if (found) out[address] = found;
        }
      } catch (error) {
        lastError = error;
      }
    }));
    if (batches.length && !reached && lastError) throw lastError;
    return out;
  }

  // Live prices for open trades: DexScreener (exact pool, then the coin's busiest pool), GeckoTerminal as backup.
  async function prices(trades) {
    const out = {}, byChain = {};
    let lastError = null;
    for (const trade of trades) (byChain[trade.chain] = byChain[trade.chain] || []).push(trade);
    await Promise.all(Object.entries(byChain).map(async ([chain, rows]) => {
      try { await dexPrices(chain, rows, out); } catch (error) { lastError = error; }
      const missing = rows.filter(row => !(row.id in out));
      if (missing.length) {
        try { await geckoPrices(chain, missing, out); } catch (error) { lastError = lastError || error; }
      }
    }));
    if (trades.length && !Object.keys(out).length && lastError) throw lastError;
    return out;
  }
  async function dexPrices(chain, rows, out) {
    const pools = [...new Set(rows.filter(row => row.pair).map(row => row.pair))].slice(0, 30);
    if (pools.length) {
      const payload = await getJson('https://api.dexscreener.com/latest/dex/pairs/' + chain + '/' + pools.join(','), 10000);
      const pairs = (payload && (payload.pairs || (payload.pair ? [payload.pair] : []))) || [];
      for (const row of rows) {
        const pair = pairs.find(item => item && C.sameAddress(item.pairAddress, row.pair, chain));
        const price = pair && C.num(pair.priceUsd);
        if (price > 0) out[row.id] = price;
      }
    }
    const missing = rows.filter(row => !(row.id in out));
    if (missing.length) {
      const addresses = [...new Set(missing.map(row => row.address))].slice(0, 30);
      const pairs = await getJson('https://api.dexscreener.com/tokens/v1/' + chain + '/' + addresses.join(','), 10000);
      for (const row of missing) {
        const found = C.normalizeMarket(pairs, chain, row.address, Date.now());
        if (found) out[row.id] = found.price;
      }
    }
  }
  async function geckoPrices(chain, rows, out) {
    const pools = [...new Set(rows.filter(row => row.pair).map(row => row.pair))].slice(0, 30);
    if (!pools.length) return;
    const payload = await getJson('https://api.geckoterminal.com/api/v2/networks/' + C.GECKO[chain] + '/pools/multi/' + pools.join(','), 10000);
    const list = (payload && Array.isArray(payload.data)) ? payload.data : [];
    for (const row of rows) {
      const pool = list.find(item => item && item.attributes && C.sameAddress(item.attributes.address, row.pair, chain));
      const price = C.poolPrice(pool, chain, row.address);
      if (price) out[row.id] = price;
    }
  }

  // One-minute candles, oldest first: [[ms, open, high, low, close, volume], ...]
  async function candles(chain, pool, limit) {
    const payload = await getJson('https://api.geckoterminal.com/api/v2/networks/' + C.GECKO[chain] + '/pools/' + pool
      + '/ohlcv/minute?aggregate=1&currency=usd&limit=' + Math.max(1, Math.min(300, Math.round(limit || 60))), 12000);
    const list = payload && payload.data && payload.data.attributes && payload.data.attributes.ohlcv_list;
    return (Array.isArray(list) ? list : []).filter(row => Array.isArray(row) && row.length >= 5 && row.slice(0, 5).every(Number.isFinite))
      .map(row => [row[0] * 1000, row[1], row[2], row[3], row[4], row[5] || 0]).sort((a, b) => a[0] - b[0]);
  }

  root.ScoutData = {DataError, getJson, market, risk, listings, geckoList, markets, prices, candles};
})(typeof self !== 'undefined' ? self : this);
