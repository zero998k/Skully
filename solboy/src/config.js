import fs from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import { file as basePath } from './paths.js';

export const DEFAULTS = {
  dryRun: true,
  wallets: [],
  buyAmountSol: 0.05,
  minSourceBuySol: 0.1,
  maxOpenPositions: 5,
  buySlippageBps: 1500,
  sellSlippageBps: 2000,
  priorityFeeMaxLamports: 1_000_000,
  followSells: true,
  sellMode: 'mirror',
  onlyFirstBuy: true,
  sellOnlyOnFullExit: true,
  takeProfitPct: null,
  stopLossPct: null,
  dailyGoalSol: null,
  pauseAtGoal: false,
  priceCheckSeconds: 20,
  dailyLossLimitSol: 0.5,
  skipIfMintAuthority: true,
  skipIfFreezeAuthority: true,
  blocklist: [],
  rpcRequestsPerSecond: 8,
  maxCopyDelaySeconds: 15,
  research: { provider: 'groq' }, // the free AI behind Ask SolBoy
  dashboard: { enabled: true, port: 7777, openBrowser: true },
  assistant: { model: 'free' },
  keepAwake: true,
};

/** Read config.json, fill in defaults, and explain any mistake in plain English. */
export function loadConfig(file = basePath('config.json')) {
  if (!fs.existsSync(file)) throw new Error(`${file} not found.`);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${file} isn't valid JSON (check for a missing comma or quote): ${e.message}`);
  }
  const cfg = {
    ...DEFAULTS,
    ...raw,
    research: { ...DEFAULTS.research, ...raw.research },
    dashboard: { ...DEFAULTS.dashboard, ...raw.dashboard },
    assistant: { ...DEFAULTS.assistant, ...raw.assistant },
  };

  if (!Array.isArray(cfg.wallets) || cfg.wallets.length === 0) {
    throw new Error('Add at least one wallet to "wallets" in config.json.');
  }
  const checked = [];
  cfg.wallets.forEach((w, i) => {
    try {
      checked.push(checkWallet(typeof w === 'string' ? { address: w } : w, checked));
    } catch (e) {
      throw new Error(`Wallet #${i + 1} in config.json: ${e.message}`);
    }
  });
  cfg.wallets = checked;

  if (!['groq', 'gemini', 'anthropic'].includes(cfg.research.provider)) {
    throw new Error('"research.provider" must be "groq", "gemini" or "anthropic".');
  }
  if (!['mirror', 'all'].includes(cfg.sellMode)) throw new Error('"sellMode" must be "mirror" or "all".');
  cfg.buyAmountSol = checkedBuyAmount(cfg.buyAmountSol);
  return cfg;
}

export function checkedBuyAmount(value) {
  const n = Number(value), lamports = Math.round(n * 1e9);
  if (!Number.isFinite(n) || !Number.isSafeInteger(lamports) || lamports <= 0) throw new Error('SOL per trade must be a finite number above 0, with at least one lamport.');
  return n;
}

/**
 * Validate one wallet entry against the ones already added, and fill in a nickname.
 * Throws a plain-English error the dashboard and terminal can show as-is.
 */
// Per-wallet sell rule. Missing means "use the main settings".
export const SELL_RULES = { first: 'Sell all on their first sell', match: 'Match their sell %', wait90: 'Wait for a 90% exit' };
export function checkSellRule(rule) {
  if (rule === undefined || rule === null || rule === '' || rule === 'default') return null;
  if (!SELL_RULES[rule]) throw new Error('Pick a sell rule: first, match or wait90.');
  return rule;
}

export function checkWallet({ address, label, buyAmountSol, retiring, paused, sellRule }, existing) {
  address = String(address ?? '').trim();
  if (!address || address.startsWith('PASTE_')) throw new Error('Paste a wallet address.');
  try {
    new PublicKey(address);
  } catch {
    throw new Error(`"${address.slice(0, 50)}" isn't a valid Solana wallet address.`);
  }
  if (existing.some((w) => w.address === address)) throw new Error('SolBoy is already watching that wallet.');

  label = String(label ?? '').trim().replace(/[^\w .-]/g, '').slice(0, 24);
  if (!label) for (let n = existing.length + 1; !label || existing.some((w) => w.label === label); n++) label = `wallet${n}`;
  if (existing.some((w) => w.label.toLowerCase() === label.toLowerCase())) throw new Error(`You already have a wallet called "${label}". Pick another nickname.`);

  const entry = { label, address };
  if (buyAmountSol !== undefined && buyAmountSol !== null && buyAmountSol !== '') {
    entry.buyAmountSol = checkedBuyAmount(buyAmountSol);
  }
  if (retiring) entry.retiring = true;
  if (paused) entry.paused = true;
  if (checkSellRule(sellRule)) entry.sellRule = sellRule;
  return entry;
}

/** Change one top-level setting in config.json, leaving everything else as it is. */
export function saveConfigValue(key, value, file = basePath('config.json')) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw[key] = value;
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(raw, null, 2) + '\n');
  fs.renameSync(`${file}.tmp`, file);
}

/** Write the wallet list back to config.json, leaving every other setting untouched. */
export function saveWallets(wallets, file = basePath('config.json')) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.wallets = wallets.map(({ label, address, buyAmountSol, retiring, paused, sellRule }) => ({ label, address, ...(buyAmountSol ? { buyAmountSol } : {}), ...(retiring ? { retiring } : {}), ...(paused ? { paused } : {}), ...(sellRule ? { sellRule } : {}) }));
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(raw, null, 2) + '\n');
  fs.renameSync(`${file}.tmp`, file);
}
