// Numbers shown in both the terminal menu and the dashboard, worked out from the trade log.

// A realistic paper trade that would have failed for real is logged as "failed": it costs its fee, nothing else.
const isFailed = (t) => / failed /.test(` ${t.action} `);
const isSell = (t) => t.action.endsWith('sell') && t.pnl_sol !== '' && !isFailed(t);
const pnlOf = (t) => Number(t.pnl_sol);
const failedPnl = (rows) => rows.filter(isFailed).reduce((s, t) => s + (Number(t.pnl_sol) || 0), 0);

/** dayStart: when "today" began (midnight, or the last reset of the day). */
export function summarize(trades, dayStart = new Date(new Date().setHours(0, 0, 0, 0))) {
  const sells = trades.filter(isSell);
  const wins = sells.filter((t) => pnlOf(t) > 0).length;

  // Current streak: consecutive wins (or losses) counting back from the latest closed trade.
  let streak = 0;
  for (let i = sells.length - 1; i >= 0; i--) {
    const won = pnlOf(sells[i]) > 0;
    if (streak === 0) streak = won ? 1 : -1;
    else if (won === streak > 0) streak += won ? 1 : -1;
    else break;
  }

  return {
    legacyPaperBuys:trades.filter(t=>t.action==='PAPER buy'&&!t.reason?.includes('simulation estimate')).length,
    buys: trades.length - sells.length - trades.filter(isFailed).length,
    sells: sells.length,
    wins,
    losses: sells.length - wins,
    winRate: sells.length ? wins / sells.length : null,
    totalPnl: sells.reduce((s, t) => s + pnlOf(t), 0) + failedPnl(trades),
    todayPnl: sells.filter((t) => new Date(t.time) >= dayStart).reduce((s, t) => s + pnlOf(t), 0) + failedPnl(trades.filter((t) => new Date(t.time) >= dayStart)),
    streak,
    // Running total after each closed trade, for the profit chart.
    curve: sells.reduce((pts, t) => [...pts, { time: t.time, pnl: (pts.at(-1)?.pnl ?? 0) + pnlOf(t) }], []),
  };
}

export function scoreboard(trades, wallets) {
  const stats = new Map(wallets.map((w) => [w.label, { label: w.label, copies: 0, closed: 0, wins: 0, pnl: 0 }]));
  for (const t of trades) {
    if (!stats.has(t.copied_wallet)) stats.set(t.copied_wallet, { label: t.copied_wallet, copies: 0, closed: 0, wins: 0, pnl: 0 });
    const s = stats.get(t.copied_wallet);
    if (isFailed(t)) { s.pnl += Number(t.pnl_sol) || 0; continue; }
    if (!t.action.endsWith('sell')) s.copies++;
    else if (t.pnl_sol !== '') {
      s.closed++;
      s.pnl += pnlOf(t);
      if (pnlOf(t) > 0) s.wins++;
    }
  }
  return [...stats.values()].sort((a, b) => b.pnl - a.pnl);
}

/**
 * The Reality check: the same paper trades with no lag (perfect), on your setup (home) and on a faster paid
 * setup (pro, an estimate), from trades that recorded all three. Lag/slippage is what the delay cost you.
 */
export function reality(trades) {
  const rows = trades.filter((t) => t.realism), sells = rows.filter(isSell), num = (v) => (v === '' || v == null || v === 'failed' ? null : Number(v));
  const sum = (m) => sells.reduce((s, t) => s + (num(t[`${m}_pnl`]) ?? 0), 0) + rows.filter((t) => isFailed(t) && t.realism === m).reduce((s, t) => s + (Number(t.pnl_sol) || 0), 0);
  const lags = rows.map((t) => num(t.lag_ms)).filter((v) => v != null).sort((a, b) => a - b);
  const fees = rows.reduce((s, t) => s + (num(t.fees_sol) ?? 0), 0);
  const failed = rows.filter(isFailed), missedBuys = rows.filter((t) => t.home_sol === 'failed' && !isFailed(t)).length;
  return {
    trades: sells.length, perfect: sum('perfect'), home: sum('home'), pro: sum('pro'), fees,
    lagMedianMs: lags.length ? lags[Math.floor(lags.length / 2)] : null,
    failedBuys: failed.filter((t) => t.action.endsWith('buy')).length + missedBuys, failedSells: failed.filter((t) => t.action.endsWith('sell')).length,
    driver: rows.at(-1)?.realism ?? null,
  };
}
