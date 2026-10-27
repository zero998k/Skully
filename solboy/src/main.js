// Entry point of the packaged app. A tiny launcher runs SolBoy itself as a child process in the same
// window, so SolBoy can swap its own app file for a new version and simply be started again (update.js).
import { spawn } from 'node:child_process';
import { isPackagedApp } from './paths.js';
import { VERSION } from './version.js';

const WORKER = '--solboy-worker';
const RESTART_CODE = 75; // keep in sync with update.js

if (process.argv.includes('--version')) {
  console.log(`SolBoy ${VERSION}`);
  process.exit(0);
}

if (!isPackagedApp || process.argv.includes(WORKER) || process.env.SOLBOY_NO_LAUNCHER === '1') {
  await import('./index.js');
} else {
  let child = null;
  const launch = (restarted) => {
    const env = { ...process.env, ...(restarted ? { SOLBOY_RESTARTED: '1' } : {}) };
    child = spawn(process.execPath, [...process.argv.slice(2), WORKER], { stdio: 'inherit', env });
    child.on('error', (e) => {
      console.error(`Couldn't start SolBoy: ${e.message}`);
      process.exit(1);
    });
    child.on('exit', (code, signal) => (code === RESTART_CODE ? launch(true) : process.exit(code ?? (signal ? 1 : 0))));
  };
  // Ctrl+C and closing the window reach SolBoy itself too; the launcher just waits for it to finish.
  process.on('SIGINT', () => {});
  process.on('SIGHUP', () => {});
  process.on('SIGTERM', () => child?.kill('SIGTERM'));
  launch(false);
}
