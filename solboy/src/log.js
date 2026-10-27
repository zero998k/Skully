import fs from 'node:fs';
import path from 'node:path';
import { format } from 'node:util';

// Colors make the feed easier to scan; they switch off when output isn't a terminal.
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const c = { bold: paint(1), dim: paint(2), green: paint(32), red: paint(31), yellow: paint(33), cyan: paint(36) };

// While a menu screen is open, live output is held back so it doesn't scroll over what you're reading.
let paused = false;
let held = [];

/** Write to the live feed (or hold it while a screen is open). */
export function write(text) {
  if (!paused) return void process.stdout.write(text);
  held.push(text);
  if (held.length > 2000) held = held.slice(-1000);
}

// Other parts of the app (the dashboard) can listen to every log line.
const listeners = new Set();
export function onLog(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function log(...args) {
  const text = format(...args);
  write(`${c.dim(new Date().toLocaleTimeString())} ${text}\n`);
  const plain = text.replace(/\x1b\[[0-9;]*m/g, '');
  for (const fn of listeners) fn({ at: Date.now(), text: plain });
}

export function pauseFeed() {
  paused = true;
}

/** Resume the live feed and print everything that happened meanwhile. Returns how many updates were held. */
export function resumeFeed() {
  paused = false;
  const updates = held.filter((t) => t.endsWith('\n')).length;
  const text = held.join('');
  held = [];
  process.stdout.write(text);
  return updates;
}

/**
 * Route library messages (printed with console.error/warn) through the feed, so they respect
 * open screens, and turn the Solana library's cryptic "ws error" lines into one plain notice.
 */
export function captureLibraryOutput() {
  let lastNotice = 0;
  const handler = (...args) => {
    const text = format(...args);
    if (/^ws error/i.test(text)) {
      if (Date.now() - lastNotice > 60_000) {
        lastNotice = Date.now();
        log(c.yellow('Live connection to Solana dropped (internet blip?). Reconnecting automatically...'));
      }
      return;
    }
    write(`${text}\n`);
  };
  console.error = handler;
  console.warn = handler;
}

export const short = (s) => (s ? `${s.slice(0, 4)}...${s.slice(-4)}` : '');

/** Append one row to a CSV trade log you can open in Excel or Google Sheets. */
export function recordTrade(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, 'time,action,token,copied_wallet,sol,pnl_sol,reason,tx\n');
  const cells = [new Date().toISOString(), row.action, row.mint, row.wallet, row.sol, row.pnl ?? '', row.reason ?? '', row.tx ?? ''];
  fs.appendFileSync(file, cells.map((c) => `"${String(c).replaceAll('"', '""')}"`).join(',') + '\n');
}

/** Read the trade log back as objects (oldest first). */
export function readTrades(file) {
  if (!fs.existsSync(file)) return [];
  const [header, ...lines] = fs.readFileSync(file, 'utf8').trim().split('\n');
  const keys = header.split(',');
  return lines.map((line) => {
    const cells = [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1].replaceAll('""', '"'));
    return Object.fromEntries(keys.map((k, i) => [k, cells[i] ?? '']));
  });
}

export async function notify(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch (e) {
    log(`Telegram message failed: ${e.message}`);
  }
}
