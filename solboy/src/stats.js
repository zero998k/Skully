// Numbers shown in both the terminal menu and the dashboard, worked out from the trade log.

const isSell = (t) => t.action.endsWith('sell') && t.pnl_sol !== '';
const pnlOf = (t) => Number(t.pnl_sol);

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
    buys: trades.length - sells.length,
    sells: sells.length,
    wins,
    losses: sells.length - wins,
    winRate: sells.length ? wins / sells.length : null,
    totalPnl: sells.reduce((s, t) => s + pnlOf(t), 0),
    todayPnl: sells.filter((t) => new Date(t.time) >= dayStart).reduce((s, t) => s + pnlOf(t), 0),
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
    if (!t.action.endsWith('sell')) s.copies++;
    else if (t.pnl_sol !== '') {
      s.closed++;
      s.pnl += pnlOf(t);
      if (pnlOf(t) > 0) s.wins++;
    }
  }
  return [...stats.values()].sort((a, b) => b.pnl - a.pnl);
}
