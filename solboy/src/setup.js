import fs from 'node:fs';
import readline from 'node:readline/promises';
import { PROVIDERS, AiError, listModels } from './ai.js';
import { Connection, PublicKey } from '@solana/web3.js';
import { DEFAULTS } from './config.js';
import { setEnvValue } from './envfile.js';
import { file } from './paths.js';

// Which research provider config.json asks for (Groq unless changed). Claude keys are entered by hand.
export function researchProvider() {
  try {
    const name = JSON.parse(fs.readFileSync(file('config.json'), 'utf8')).research?.provider ?? 'groq';
    return PROVIDERS[name] ?? null;
  } catch {
    return PROVIDERS.groq;
  }
}
export const needsResearchChoice = () => {
  const p = researchProvider();
  return p && !process.env[p.envKey]?.trim() && process.env.RESEARCH_SKIPPED !== p.envKey;
};
export const needsRpcKey = () => !process.env.RPC_URL?.trim() || process.env.RPC_URL.includes('YOUR_KEY');

export function needsWallets() {
  const cfgPath = file('config.json');
  if (!fs.existsSync(cfgPath)) return true;
  try {
    const { wallets } = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    return !wallets?.length || wallets.some((w) => (w.address ?? w).startsWith('PASTE_'));
  } catch {
    return false; // broken JSON: let loadConfig explain the problem
  }
}

function isAddress(s) {
  try {
    new PublicKey(s);
    return s.length >= 32;
  } catch {
    return false;
  }
}

// People often paste the whole Helius URL instead of just the key.
export function extractKey(input) {
  const m = input.match(/api-key=([A-Za-z0-9-]+)/);
  return (m ? m[1] : input).trim();
}

async function askResearchKey(rl) {
  const provider = researchProvider();
  console.log('\nOptional: free AI token research.');
  console.log('  When the bot buys a token, AI writes a quick breakdown: the story, why it is pumping now,');
  console.log('  risks, and a bull vs bear verdict. You can also paste any token address to research it.');
  console.log(`  It uses ${provider.label}'s free plan. Make a free account at ${provider.signup} and create an API key.\n`);
  for (;;) {
    const key = (await rl.question(`  Paste your ${provider.label} API key, or press Enter to skip: `)).trim();
    if (!key) {
      setEnvValue('RESEARCH_SKIPPED', provider.envKey);
      console.log(`  Skipped. To turn it on later, paste a key into the dashboard's Ask SolBoy panel (or after ${provider.envKey}= in .env) and restart SolBoy.`);
      return;
    }
    process.stdout.write('  Checking the key... ');
    try {
      await listModels(provider, key);
      console.log('works!');
    } catch (e) {
      if (e instanceof AiError) {
        console.log(`${e.message} Try again.`);
        continue;
      }
      console.log(`couldn't check it right now (${e.message}). Saving it anyway.`);
    }
    setEnvValue(provider.envKey, key);
    return;
  }
}

/** First-run questions. Does nothing once everything has been answered. */
export async function runSetupIfNeeded() {
  const firstRun = needsRpcKey() || needsWallets();
  if (!firstRun && !needsResearchChoice()) return;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  if (firstRun) {
    console.log('\n=== SolBoy: first-time setup ===\n');
    console.log('Your answers are saved next to this app, so you only do this once.\n');
  } else {
    console.log('\n=== New feature ===');
  }

  if (needsRpcKey()) {
    console.log('Step 1: connect to Solana.');
    console.log('  Make a free account at https://www.helius.dev and copy your API key.\n');
    for (;;) {
      const key = extractKey(await rl.question('  Paste your Helius API key: '));
      if (!key) continue;
      const rpc = `https://mainnet.helius-rpc.com/?api-key=${key}`;
      process.stdout.write('  Checking the key... ');
      try {
        await new Connection(rpc).getSlot();
        console.log('works!\n');
        setEnvValue('RPC_URL', rpc);
        setEnvValue('WS_URL', `wss://mainnet.helius-rpc.com/?api-key=${key}`);
        break;
      } catch (e) {
        console.log(`that didn't work (${e.message}). Check you copied the whole key and try again.\n`);
      }
    }
  }

  if (needsWallets()) {
    console.log('Step 2: wallets to copy.');
    console.log('  Paste one wallet address per line. Press Enter on an empty line when done.\n');
    const wallets = [];
    for (;;) {
      const addr = (await rl.question(`  Wallet ${wallets.length + 1}: `)).trim();
      if (!addr) {
        if (wallets.length) break;
        console.log('  Add at least one wallet.');
        continue;
      }
      if (!isAddress(addr)) {
        console.log("  That isn't a valid Solana wallet address. Try again.");
        continue;
      }
      if (wallets.some((w) => w.address === addr)) continue;
      wallets.push({ label: `wallet${wallets.length + 1}`, address: addr });
    }

    let buyAmountSol = DEFAULTS.buyAmountSol;
    for (;;) {
      const ans = (await rl.question(`\n  SOL to spend on each copied trade [${buyAmountSol}]: `)).trim();
      if (!ans) break;
      const n = Number(ans);
      if (n > 0) {
        buyAmountSol = n;
        break;
      }
      console.log('  Enter a number like 0.05');
    }

    fs.writeFileSync(file('config.json'), JSON.stringify({ ...DEFAULTS, wallets, buyAmountSol }, null, 2) + '\n');
  }

  if (needsResearchChoice()) await askResearchKey(rl);

  rl.close();
  if (!firstRun) return console.log('');
  console.log('\nSetup saved. The bot starts in PAPER mode: real prices, no real money.');
  console.log('Your dashboard opens in your browser in a moment. Add wallets and change settings there, or just ask the SolBoy assistant.\n');
}
