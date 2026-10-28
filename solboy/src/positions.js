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

  recordPnl(sol) {
    const d = today();
    this.data.pnlByDay[d] = (this.data.pnlByDay[d] ?? 0) + sol;
    this.save();
  }
  todayPnl() { return this.data.pnlByDay[today()] ?? 0; }

  /** Start today's profit/loss (and so the daily loss limit) from zero again. */
  resetDay() {
    this.data.pnlByDay[today()] = 0;
    this.data.dayResetAt = new Date().toISOString();
    this.save();
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
