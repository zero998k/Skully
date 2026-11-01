import fs from 'node:fs';
import path from 'node:path';

/**
 * Realistic paper fills. Every paper trade is priced three ways:
 *   perfect: the price SolBoy saw when it decided (what paper mode always showed), no costs.
 *   home:    your setup. The trade "lands" after the natural delay, at the live price of that moment,
 *            pays real network costs, and fails exactly when that price moved past your slippage limit.
 *   pro:     an estimate of a server + paid RPC + Jito setup. It sends faster, and the tip buys a better place in
 *            the queue, but it is never instant: its slot depends on how its tip and fee compare with the bots
 *            competing for the same coin right now, some bundles get dropped and re-sent, and it fills at the
 *            live price of its own landing, paying real costs plus the tip. Its trades fail past your slippage
 *            limit like real ones. It gets no credit for spotting trades sooner, so it leans pessimistic.
 * One of them (cfg.paperRealism) drives the paper wallet; the other two are kept beside it for comparison.
 * Real-money trading never comes through here.
 */
export const REALISM = { home: '🏠 My setup', pro: '🚀 $100 setup (estimate)', perfect: '✨ Perfect (no lag, no fees)' };
const MODES = ['perfect', 'home', 'pro'];
const BASE_FEE = 5000n;                                       // one signature
const RENT = { token: 2_039_280n, token2022: 2_074_080n };    // a new token account in your wallet, kept until closed
const CU = { curve: 150_000, jupiter: 300_000 };              // typical compute used, to compare priority fees
const READ_LAG_MS = 100;                                      // a price read is itself a moment behind the chain

export function createPaperReality({ cfg, connection, clock = () => null, file, now = Date.now, random = Math.random, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let data = { landings: [], accounts: [], fails: [] };
  try { if (file && fs.existsSync(file)) data = { ...data, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {}
  const accounts = new Set(data.accounts);
  function save() {
    if (!file) return;
    data.accounts = [...accounts].slice(-2000);
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(`${file}.tmp`, JSON.stringify(data)); fs.renameSync(`${file}.tmp`, file); } catch {}
  }
  const mode = () => (cfg.dryRun && REALISM[cfg.paperRealism] ? cfg.paperRealism : 'perfect');
  const slotMs = () => { const ms = clock()?.slotMs; return Number.isFinite(ms) && ms >= 250 && ms <= 1500 ? ms : 400; };

  // How busy the network is around this coin right now: recent priority fees paid by trades
  // touching the same account, compared with the fee SolBoy pays. Cached briefly; never blocks a trade.
  const busy = new Map();
  // `extra` is lamports paid on top of the priority fee (the Jito tip), counted as part of the bid.
  async function competition(account, via, extra = 0n) {
    const key = account?.toBase58?.() ?? 'all', hit = busy.get(key);
    let fees = hit && now() - hit.at < 15_000 ? hit.fees : undefined;
    if (fees === undefined) {
      fees = null;
      try {
        if (typeof connection?.getRecentPrioritizationFees === 'function') {
          const rows = await Promise.race([connection.getRecentPrioritizationFees(account ? { lockedWritableAccounts: [account] } : undefined), sleep(1500).then(() => null)]);
          const list = (rows ?? []).map((r) => r.prioritizationFee).filter((f) => f > 0).sort((a, b) => a - b);
          if (list.length >= 5) fees = list;
        }
      } catch {}
      busy.set(key, { at: now(), fees });
      if (busy.size > 300) busy.delete(busy.keys().next().value);
    }
    if (!fees) return null;
    const ours = Number(priority(via) + extra) * 1e6 / CU[via === 'curve' ? 'curve' : 'jupiter'];
    return fees.filter((f) => f <= ours).length / fees.length; // share of recent trades we outbid
  }
  const priority = (via) => BigInt(via === 'curve' ? Math.min(cfg.priorityFeeMaxLamports, 2_000_000) : cfg.priorityFeeMaxLamports);
  const tip = () => BigInt(Math.round((cfg.proTipSol ?? 0.001) * 1e9));

  /**
   * How long after sending a real trade would land. Your own measured real-money landings are used once
   * there are a few; until then: the send hop plus the slots it takes to get in, from how your priority
   * fee compares with the trades competing for the same coin right now, with natural variation.
   */
  async function landing(account, via) {
    if (data.landings.length >= 5) return { ms: data.landings[Math.floor(random() * data.landings.length)], source: 'your real trades' };
    const beat = await competition(account, via), r = random();
    const slots = (beat == null ? 2 : beat >= .9 ? 1 : beat >= .75 ? 2 : beat >= .5 ? 3 : 5) + (r < .6 ? 0 : r < .9 ? 1 : 2);
    return { ms: Math.round(150 + slots * slotMs()), slots, source: beat == null ? 'network estimate' : 'live network' };
  }

  // The $100 setup: a server next to the validators sends in ~50ms. Its slot depends on how the tip plus
  // priority fee compares with the bots trading the same coin right now; with no fee data it assumes the
  // next slot. Apart from a dropped bundle it never lands later than your own setup would. A dropped
  // bundle (cfg.proDropRate, ~1 in 10) is noticed a few slots later and re-sent; it costs no fees.
  async function proLanding(account, via, homeMs) {
    const beat = await competition(account, via, tip()), r = random();
    const slots = (beat == null || beat >= .9 ? 1 : beat >= .75 ? 2 : beat >= .5 ? 3 : 4) + (r < .7 ? 0 : r < .92 ? 1 : 2);
    const dropped = random() < (cfg.proDropRate ?? 0.1);
    return { ms: Math.min(homeMs, Math.round(50 + slots * slotMs())) + (dropped ? Math.round(50 + 3 * slotMs()) : 0), dropped };
  }

  // Coins out (buy) or lamports out (sell) for `amount`, from a curve or a quote of a nearby amount.
  function outFor(state, side, amount) {
    if (!state) return null;
    if (state.kind === 'curve') {
      const { vSol, vTokens } = state.curve, k = vSol * vTokens;
      if (side === 'buy') return BigInt(Math.max(0, Math.floor((vTokens - k / (vSol + (Number(amount) / 1e9) * 0.99)) * 1e6)));
      return BigInt(Math.max(0, Math.floor((vSol - k / (vTokens + Number(amount) / 1e6)) * 0.99 * 1e9)));
    }
    return state.amount > 0n ? state.out * amount / state.amount : 0n;
  }
  function fees(m, via, newAccount) {
    if (m === 'perfect') return 0n;
    return BASE_FEE + priority(via) + (m === 'pro' ? tip() : 0n) + (newAccount ? RENT[newAccount] : 0n);
  }
  function noteFail(side, mint, moved) {
    data.fails.push({ at: new Date(now()).toISOString(), side, mint, moved: Math.round(moved * 10) / 10 });
    data.fails = data.fails.slice(-500); save();
  }

  /**
   * Land one paper trade. `state0` is what SolBoy priced at the decision, `readState` reads the market again
   * at landing. For a buy, `amount` is lamports in; for a sell it is the coins sold and `pos` is the position.
   * Returns null in Perfect mode. Throws when the trade would have failed in the mode that drives the wallet.
   */
  async function land({ side, mint, amount, state0, readState, via, slippageBps, sentAt, seenAt, pos = null, account = null, tokenProgram = 'token' }) {
    const driver = mode();
    if (driver === 'perfect') return null;
    const wait = await landing(account, via), pro = await proLanding(account, via, wait.ms), proMs = pro.ms;
    // Read the market when each setup's trade would land, in landing order, a moment late to cover the read's own lag.
    const readAt = async (ms) => {
      if (sentAt + ms + READ_LAG_MS > now()) await sleep(sentAt + ms + READ_LAG_MS - now());
      try { return (await readState()) ?? state0; } catch { return state0; }
    };
    const first = await readAt(Math.min(proMs, wait.ms)), second = proMs === wait.ms ? first : await readAt(Math.max(proMs, wait.ms));
    const statePro = proMs <= wait.ms ? first : second, state1 = proMs <= wait.ms ? second : first;
    const landMs = driver === 'pro' ? proMs : wait.ms;
    const lagMs = Math.max(0, Math.round(sentAt + landMs - (seenAt ?? sentAt))), limit = Number(slippageBps) / 10000;
    const newAccount = side === 'buy' && !accounts.has(mint) ? (tokenProgram === 'token2022' ? 'token2022' : 'token') : null;
    const modes = {};
    for (const m of MODES) {
      const shadow = side === 'sell' ? pos?.reality?.[m] : null;
      if (side === 'sell' && pos?.reality && !shadow) continue;
      const held = side === 'sell' ? BigInt(shadow?.tokens ?? pos.tokens) : null;
      if (side === 'sell' && held <= 0n) { modes[m] = { failed: false, out: 0n, fees: 0n, skipped: true }; continue; }
      const part = side === 'buy' ? amount : BigInt(pos.tokens) > 0n ? held * amount / BigInt(pos.tokens) : 0n;
      const quoted = outFor(state0, side, part), got = m === 'home' ? outFor(state1, side, part) : m === 'pro' ? outFor(statePro, side, part) : quoted;
      const fee = fees(m, via, newAccount);
      const failed = m !== 'perfect' && quoted > 0n && Number(got) < Number(quoted) * (1 - limit);
      modes[m] = { failed, out: got, fees: fee, part, moved: quoted > 0n ? (1 - Number(got) / Number(quoted)) * 100 : 0 };
    }
    // A comparison mode whose trade failed would have been retried: count the wasted fee and keep the late fill.
    // A failed buy is simply missed (no token account gets made); a failed sell is retried.
    for (const m of MODES) if (m !== driver && modes[m]?.failed) {
      if (side === 'buy') Object.assign(modes[m], { out: 0n, fees: BASE_FEE + priority(via) });
      else modes[m].fees += BASE_FEE + priority(via);
    }
    const result = { driver, modes, lagMs, landingMs: landMs, landingSource: driver === 'pro' ? `estimate for the $100 setup${pro.dropped ? ', bundle dropped and re-sent' : ''}` : wait.source };
    if (modes[driver]?.failed) {
      noteFail(side, mint, modes[driver].moved);
      const failure = new Error(`Paper ${side} would have failed for real: the price moved ${modes[driver].moved.toFixed(1)}% in the ${(lagMs / 1000).toFixed(2)}s it took to land, past your ${limit * 100}% slippage limit. Failed trades still pay network fees.`);
      throw Object.assign(failure, { realityFailure: true, feesLamports: BASE_FEE + priority(via), retryAfterMs: 300 });
    }
    if (newAccount) { accounts.add(mint); save(); }
    return result;
  }

  return {
    mode,
    land,
    outFor,
    /** A real-money trade's observed send-to-confirmation time, so paper uses your real landing times. */
    noteLanding(ms) {
      if (!Number.isFinite(ms) || ms <= 0 || ms > 30_000) return;
      data.landings.push(Math.max(Math.round(slotMs()), Math.round(ms - slotMs())));
      data.landings = data.landings.slice(-200); save();
    },
    failsSince(since) { return data.fails.filter((f) => !since || f.at >= since); },
    measuredLandings: () => data.landings.length,
  };
}
