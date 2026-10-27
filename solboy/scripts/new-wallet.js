// Creates a fresh burner wallet and saves its private key into .env.
import dotenv from 'dotenv';
import { createBurnerWallet } from '../src/envfile.js';
import { file } from '../src/paths.js';

dotenv.config({ path: file('.env'), quiet: true });
if (process.env.PRIVATE_KEY?.trim()) {
  console.log('.env already has a PRIVATE_KEY. Move any funds out of that wallet and delete the line first if you really want a new one.');
  process.exit(1);
}

const kp = createBurnerWallet();
console.log('New burner wallet created.');
console.log(`Address (send SOL here): ${kp.publicKey.toBase58()}`);
console.log('Its private key is saved in .env. Back that file up and never share it.');
