import { saveConfigValue } from './config.js';

// Settings that can be changed while SolBoy runs, from the dashboard's Quick settings or by the assistant.
// Real-money mode, keys and withdrawals are deliberately absent.
const pct = (v) => `${v / 100}%`;
export const SETTINGS = {
  buyAmountSol: { label: 'SOL per copied buy', type: 'number', min: 0.001, max: 100, unit: ' SOL' },
  minSourceBuySol: { label: 'Ignore copied buys smaller than', type: 'number', min: 0, max: 1000, unit: ' SOL' },
  maxOpenPositions: { label: 'Max tokens held at once', type: 'int', min: 1, max: 50 },
  takeProfitPct: { label: 'Take profit', hint: 'percent gain', type: 'number', min: 1, max: 10000, nullable: true, fmt: (v) => `+${v}%` },
  stopLossPct: { label: 'Stop loss', hint: 'percent loss', type: 'number', min: 1, max: 99, nullable: true, abs: true, fmt: (v) => `-${v}%` },
  dailyLossLimitSol: { label: 'Daily loss limit', type: 'number', min: 0.001, max: 1000, unit: ' SOL' },
  buySlippageBps: { label: 'Max buy slippage', hint: 'basis points, 100 = 1%', type: 'int', min: 50, max: 5000, fmt: pct },
  sellSlippageBps: { label: 'Max sell slippage', hint: 'basis points, 100 = 1%', type: 'int', min: 50, max: 9000, fmt: pct },
  followSells: { label: 'Sell when the copied wallet sells', type: 'bool' },
  sellMode: { label: 'When they sell, sell', type: 'enum', values: ['mirror', 'all'], fmt: (v) => (v === 'all' ? 'everything' : 'the same %') },
  skipIfMintAuthority: { label: 'Skip tokens whose creator can mint more', type: 'bool' },
  skipIfFreezeAuthority: { label: 'Skip tokens whose creator can freeze holders', type: 'bool' },
  maxCopyDelaySeconds: { label: 'Skip buys slower to load than', type: 'int', min: 1, max: 120, unit: 's' },
  researchOn: { label: 'AI research runs on', type: 'enum', values: ['buys', 'detected'], fmt: (v) => (v === 'buys' ? 'tokens SolBoy buys' : 'every token your wallets buy') },
};

export function parseValue(spec, raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (spec.nullable && ['off', 'none', 'null', 'disable', 'disabled', '0', ''].includes(v)) return null;
  if (spec.type === 'bool') {
    if (['true', 'yes', 'on', '1'].includes(v)) return true;
    if (['false', 'no', 'off', '0'].includes(v)) return false;
    throw new Error('needs yes or no');
  }
  if (spec.type === 'enum') {
    if (!spec.values.includes(v)) throw new Error(`must be one of: ${spec.values.join(', ')}`);
    return v;
  }
  let n = Number(v.replace(/[%+\s]|sol/g, ''));
  if (spec.abs) n = Math.abs(n); // "-25" and "25" both mean a 25% drop
  if (!v || !Number.isFinite(n)) throw new Error('needs a number');
  if (spec.type === 'int' && !Number.isInteger(n)) throw new Error('needs a whole number');
  if (n < spec.min || n > spec.max) throw new Error(`must be between ${spec.min} and ${spec.max}`);
  return n;
}

export const show = (v) => (v === null || v === undefined ? 'off' : v === true ? 'yes' : v === false ? 'no' : String(v));
export const showSetting = (spec, v) => (v === null || v === undefined || typeof v === 'boolean' ? show(v) : spec.fmt ? spec.fmt(v) : `${v}${spec.unit ?? ''}`);

export const settingValue = (cfg, key) => (key === 'researchOn' ? cfg.research.on : cfg[key]);

/** Check a new value, use it straight away and save it to config.json. Throws a plain-English reason if it's not allowed. */
export function applySetting(cfg, key, raw) {
  const spec = SETTINGS[key];
  if (!spec) throw new Error(`There's no setting called "${key}".`);
  let value;
  try {
    value = parseValue(spec, raw);
  } catch (e) {
    throw new Error(`${spec.label} ${e.message}.`);
  }
  const before = settingValue(cfg, key);
  if (key === 'researchOn') {
    cfg.research.on = value;
    cfg.research.onChosen = true;
    saveConfigValue('research', { ...cfg.research });
  } else {
    cfg[key] = value;
    saveConfigValue(key, value);
  }
  return { setting: key, value, before, summary: `${spec.label}: ${showSetting(spec, before)} → ${showSetting(spec, value)}` };
}
