import fs from 'node:fs';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { file } from './paths.js';

const TEMPLATE = `# Your connection to Solana (free key from https://www.helius.dev)
RPC_URL=
WS_URL=

# Burner wallet used in LIVE mode. Anyone with this key can take its SOL. Never share this file.
PRIVATE_KEY=

# Optional: free AI assistant, Ask SolBoy (free key from https://console.groq.com/keys)
GROQ_API_KEY=

# Optional: a free Jupiter key from https://portal.jup.ag (only if swaps fail without one)
JUPITER_API_KEY=

# Optional: Telegram alerts (see README)
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
`;

/** Set KEY=value in .env (creating it if needed) and in the running process. */
export function setEnvValue(key, value) {
  const envPath = file('.env');
  let text = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : TEMPLATE;
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  text = re.test(text) ? text.replace(re, line) : `${text}${text.endsWith('\n') ? '' : '\n'}${line}\n`;
  fs.writeFileSync(envPath, text, { mode: 0o600 });
  fs.chmodSync(envPath, 0o600); // also tighten a file that already existed (no effect on Windows)
  process.env[key] = value;
}

/** Make a fresh burner wallet, save its key to .env, and return it. */
export function createBurnerWallet() {
  const kp = Keypair.generate();
  setEnvValue('PRIVATE_KEY', bs58.encode(kp.secretKey));
  return kp;
}
