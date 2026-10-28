// Isolated test processes: never stop the owner's running SolBoy or other unrelated processes.
const { spawn } = require('node:child_process');
const [mode, seconds, command, ...args] = process.argv.slice(2);
const child = spawn(command, args, { stdio: [mode === 'app' ? 'pipe' : 'inherit', 'inherit', 'inherit'], detached: true, env: process.env });
let timedOut = false;
const stop = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch {} };
const timer = mode === 'timeout' ? setTimeout(() => { timedOut = true; stop(); setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 2000).unref(); }, Number(seconds) * 1000) : null;
process.on('SIGTERM', stop); process.on('SIGINT', stop);
child.on('error', (e) => { console.error(e.message); process.exit(1); });
child.on('exit', (code) => { if (timer) clearTimeout(timer); stop(); process.exit(timedOut ? 124 : code ?? 1); });
