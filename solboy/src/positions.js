import fs from 'node:fs';
import path from 'node:path';

// "Today" follows this computer's clock, from midnight (or from the last reset, if later).
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Open positions and daily profit/loss, saved to a JSON file so a restart doesn't lose them. */
export class Positions {
  constructor(file) {
    this.file = file;
    this.data = { open: {}, pnlByDay: {} };
    if (fs.existsSync(file)) this.data = { ...this.data, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  }

  get(mint) { return this.data.open[mint]; }
  has(mint) { return mint in this.data.open; }
  count() { return Object.keys(this.data.open).length; }
  entries() { return Object.entries(this.data.open); }

  open(mint, pos) { this.data.open[mint] = pos; this.save(); }
  update(mint, changes) { Object.assign(this.data.open[mint], changes); this.save(); }
  close(mint) { delete this.data.open[mint]; this.save(); }

  // Practice cash and its position/PnL change are one atomic file replacement. A crash
  // cannot debit cash without opening the position or credit the same sell twice.
  settlePaper(mint, pos, cashDelta, pnl = null) {
    const before=this.data;
    this.data=structuredClone(before);
    try {
      if(this.data.paperWallet?.enabled){
        const available=BigInt(this.data.paperWallet.availableLamports)+cashDelta;
        if(available<0n)throw new Error('Not enough paper SOL for this buy.');
        this.data.paperWallet.availableLamports=String(available);
      }
      if(pos==null)delete this.data.open[mint];else this.data.open[mint]=pos;
      if(pnl!=null)this.data.pnlByDay[today()]=(this.data.pnlByDay[today()]??0)+pnl;
      this.save();
    }catch(error){this.data=before;throw error;}
  }

  recordPnl(sol) {
    const d = today();
    this.data.pnlByDay[d] = (this.data.pnlByDay[d] ?? 0) + sol;
    this.save();
  }
  todayPnl() { return this.data.pnlByDay[today()] ?? 0; }

  /** Start profit/loss from zero again: today's (so the daily loss limit refills) and the running totals. */
  resetPnl() {
    const now = new Date().toISOString();
    this.data.pnlByDay[today()] = 0;
    this.data.dayResetAt = now;
    this.data.statsResetAt = now;
    this.save();
  }
  /** Trades that count toward the totals: those since the last reset (older ones stay in the history). */
  counted(trades) {
    const since = this.data.statsResetAt;
    return since ? trades.filter((t) => t.time >= since) : trades;
  }
  dayStart() {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const reset = this.data.dayResetAt ? new Date(this.data.dayResetAt) : null;
    return reset > midnight ? reset : midnight;
  }
  /** When today was last reset, or null if it wasn't. */
  resetToday() {
    const start = this.dayStart();
    return start.getHours() || start.getMinutes() || start.getSeconds() || start.getMilliseconds() ? start.toISOString() : null;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}
