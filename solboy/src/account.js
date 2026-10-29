import { PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import QRCode from 'qrcode';
import { createBurnerWallet } from './envfile.js';
import { saveConfigValue } from './config.js';
import { log, short, c } from './log.js';

const FEE_LAMPORTS = 5000;

/**
 * The SolBoy trading wallet: create it, show its balance, switch between paper and real money,
 * and send SOL back out. The key never leaves this computer.
 */
export function createAccount({ cfg, connection, book, positionsFor }) {
  let cached = { at: 0, sol: null };
  const address = () => book.keypair?.publicKey.toBase58() ?? null;

  async function balance(force = false) {
    if (!book.keypair) return null;
    if (!force && Date.now() - cached.at < 10_000) return cached.sol;
    cached = { at: Date.now(), sol: (await connection.getBalance(book.keypair.publicKey)) / 1e9 };
    return cached.sol;
  }

  function ensureWallet() {
    if (!book.keypair) {
      book.keypair = createBurnerWallet();
      log(`Created your SolBoy wallet: ${address()}. Its key is saved in .env next to the app.`);
    }
    return address();
  }

  async function setMode(mode, confirmed) {
    if(book.isTrading?.())throw new Error('A trade is still being checked. Wait for it to finish before switching modes.');
    if (mode === 'paper') {
      const held = positionsFor('live').count();
      if (!cfg.dryRun && held) {
        throw new Error(`You still hold ${held} real-money token(s). In Paper mode SolBoy would stop following their sells. Sell them first (Positions → Sell now), or use Pause copying to stop new buys while sells keep following.`);
      }
      cfg.dryRun = true;
      saveConfigValue('dryRun', true);
      log('Switched to PAPER mode. Practice trades only; your real-money positions are kept for later.');
      return;
    }
    if (!confirmed) throw new Error('Tick the box to confirm you understand the risk first.');
    if (!book.keypair) throw new Error('Create your SolBoy wallet first.');
    if (cfg.wallets.some((w) => w.address === address())) throw new Error("Your SolBoy wallet is in your copy list. Remove it first; it can't copy itself.");
    const need = +(cfg.buyAmountSol + 0.02).toFixed(4); // one trade + fees + token account rent
    const sol = await balance(true);
    if (sol < need) throw new Error(`Deposit at least ${need} SOL first. You have ${sol.toFixed(4)} SOL.`);
    if(book.isTrading?.())throw new Error('A trade started while checking the balance. Wait for it before switching modes.');
    cfg.dryRun = false;
    saveConfigValue('dryRun', false);
    log(c.red(`REAL MONEY mode ON. SolBoy now trades real SOL from ${short(address())} (balance ${sol.toFixed(4)} SOL).`));
  }

  async function withdraw(to, amount) {
    if (!book.keypair) throw new Error("You don't have a SolBoy wallet yet.");
    let dest;
    try {
      dest = new PublicKey(String(to ?? '').trim());
    } catch {
      throw new Error("That isn't a valid Solana address. Copy it from Phantom (tap your address to copy).");
    }
    if (dest.equals(book.keypair.publicKey)) throw new Error("That's the SolBoy wallet itself. Paste your Phantom address instead.");
    const have = await connection.getBalance(book.keypair.publicKey);
    const lamports = amount === 'all' ? have - FEE_LAMPORTS : Math.round(Number(amount) * 1e9);
    if (!(lamports > 0)) throw new Error(amount === 'all' ? 'Nothing to withdraw.' : 'Enter an amount above 0.');
    if (lamports + FEE_LAMPORTS > have) throw new Error(`Not enough SOL. You have ${(have / 1e9).toFixed(4)} SOL (a tiny network fee also applies).`);
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: book.keypair.publicKey, toPubkey: dest, lamports }));
    const sig = await sendAndConfirmTransaction(connection, tx, [book.keypair], { commitment: 'confirmed' });
    cached.at = 0;
    log(`Withdrew ${(lamports / 1e9).toFixed(4)} SOL to ${short(dest.toBase58())}. tx: ${sig}`);
    return { sig, sol: lamports / 1e9 };
  }

  return {
    address,
    balance,
    ensureWallet,
    setMode,
    withdraw,
    exportKey: () => (book.keypair ? bs58.encode(book.keypair.secretKey) : null),
    // "solana:" links open the send screen when scanned with Phantom or Solflare.
    qrSvg: () => (address() ? QRCode.toString(`solana:${address()}`, { type: 'svg', margin: 1, color: { dark: '#000000', light: '#ffffff' } }) : null),
    livePositions: () => positionsFor('live').count(),
  };
}
