import dotenv from 'dotenv';
import readline from 'node:readline/promises';
import { Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { file } from './paths.js';
import { loadConfig } from './config.js';
import { runSetupIfNeeded } from './setup.js';
import { createBook } from './book.js';
import { createAccount } from './account.js';
import { createBot } from './bot.js';
import { createResearcher } from './research.js';
import { createRpcLimiter } from './rpc.js';
import { createMenu } from './ui.js';
import { startDashboard } from './server.js';
import { log, captureLibraryOutput } from './log.js';
import { keepAwake } from './awake.js';
import { runWebSetupIfNeeded } from './websetup.js';
import { createUpdater } from './update.js';
import { VERSION } from './version.js';

// Server mode: SolBoy runs online on a server, set up and used through the browser with a password.
const SERVER_MODE = process.argv.includes('--server') || process.env.SOLBOY_SERVER === '1';

dotenv.config({ path: file('.env'), quiet: true });

function loadKeypair() {
  const raw = process.env.PRIVATE_KEY?.trim();
  if (!raw) return null;
  try {
    return raw.startsWith('[')
      ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)))
      : Keypair.fromSecretKey(bs58.decode(raw));
  } catch {
    throw new Error(`PRIVATE_KEY in ${file('.env')} isn't a valid Solana private key.`);
  }
}

async function main() {
  captureLibraryOutput();
  // Windows can run an app straight from inside a zip, from a temp folder that gets wiped, losing all settings.
  if (/[\\/](Temp|tmp)[\\/]/i.test(file('')) && process.platform === 'win32') {
    console.log('\n  WARNING: SolBoy is running from a temporary folder, probably from inside the zip.');
    console.log('  Your settings would be lost. Close this window, right-click the zip > Extract All,');
    console.log('  then open SolBoy.exe from the extracted folder.\n');
  }
  if (SERVER_MODE) await runWebSetupIfNeeded({ port: Number(process.env.PORT) || 7777, host: process.env.HOST || '127.0.0.1' });
  else await runSetupIfNeeded();

  const cfg = loadConfig();
  // After an update the dashboard is already open, and reloads by itself.
  if (process.env.SOLBOY_RESTARTED) cfg.dashboard = { ...cfg.dashboard, openBrowser: false };
  if (SERVER_MODE) {
    cfg.keepAwake = false; // servers don't sleep
    cfg.dashboard = { ...cfg.dashboard, enabled: true, openBrowser: false, port: Number(process.env.PORT) || cfg.dashboard.port };
  }
  const rpcUrl = process.env.RPC_URL.trim();
  const wsUrl = process.env.WS_URL?.trim() || rpcUrl.replace(/^http/, 'ws');
  const rpc = createRpcLimiter(cfg.rpcRequestsPerSecond);
  const connection = new Connection(rpcUrl, {
    wsEndpoint: wsUrl,
    commitment: 'confirmed',
    fetch: rpc.fetch,
    disableRetryOnRateLimit: true, // rpc.fetch handles rate limits quietly instead
  });
  const book = createBook(cfg, loadKeypair());

  if (!cfg.dryRun && !book.keypair) {
    cfg.dryRun = true;
    log('Real-money mode needs a funded SolBoy wallet, so SolBoy is starting in PAPER mode. Set one up on the dashboard\'s Account tab.');
  }

  log(`SolBoy ${VERSION} starting in ${cfg.dryRun ? 'PAPER mode (no real trades)' : 'REAL MONEY mode'}`);
  try {
    await connection.getSlot();
  } catch (e) {
    throw new Error(`Couldn't reach Solana. Check your internet, and the Helius key in ${file('.env')}. (${e.message})`);
  }

  if (!cfg.dryRun) {
    const address = book.keypair.publicKey.toBase58();
    const sol = (await connection.getBalance(book.keypair.publicKey)) / 1e9;
    log(`Trading wallet ${address} has ${sol.toFixed(4)} SOL`);
    if (sol < cfg.buyAmountSol + 0.01) log('WARNING: not enough SOL for even one trade plus fees. Deposit on the Account tab.');
    if (cfg.wallets.some((w) => w.address === address)) {
      throw new Error('Your own trading wallet is in the wallets list. Remove it, or the bot would copy itself.');
    }
  }

  if (cfg.keepAwake) keepAwake();

  const account = createAccount({ cfg, connection, book, positionsFor: book.positionsFor });
  const research = createResearcher({ cfg, connection, rpcUrl, rpcFetch: rpc.fetch, outDir: file('data/research') });
  const bot = createBot({ cfg, connection, book, onToken: research ?? undefined, rpcFetch: rpc.fetch });
  bot.start();
  if (research) log(`Token research: ${await research.describe()}.`);
  const researchDir = file('data/research');
  const updater = createUpdater();
  let dashboard = null;
  if (cfg.dashboard.enabled) {
    try {
      dashboard = await startDashboard({ cfg, bot, book, account, researchDir, research, updater, serverMode: SERVER_MODE });
    } catch (e) {
      log(`Dashboard couldn't start (${e.message}). The bot keeps running here in the terminal.`);
    }
  }
  if (SERVER_MODE) log('Server mode: SolBoy is running. Use it from your SolBoy web address.');
  else createMenu({ cfg, bot, book, account, researchDir, research, dashboard, updater }).start();
}

// Keep the window open after an error so a double-clicked app doesn't just vanish.
async function pauseBeforeExit() {
  if (!process.stdin.isTTY) return;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await rl.question('Press Enter to close.');
  rl.close();
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(0));

main().catch(async (e) => {
  console.error(`\nCouldn't start: ${e.message}\n`);
  await pauseBeforeExit();
  process.exit(1);
});
